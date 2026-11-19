const test = require("node:test");
const assert = require("node:assert/strict");
const { createPoller } = require("../src/admin/client/polling");
const { diagnosticExport } = require("../src/admin/client/diagnostics");
const { createApi } = require("../src/admin/client/api");

const ok = (data) => ({ status: 200, ok: true, json: async () => data });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ statusFn, diagnosticsFn } = {}) {
  const state = { token: "token", busy: false };
  let generation = 0;
  const calls = { status: 0, diagnostics: 0 };
  const events = [];
  const poller = createPoller({
    api: {
      status: async () => { calls.status += 1; return statusFn ? statusFn() : {}; },
      diagnostics: async () => { calls.diagnostics += 1; return diagnosticsFn ? diagnosticsFn() : ok({}); },
    },
    getState: () => state,
    getGeneration: () => generation,
    onStatus: (data) => events.push(["status", data]),
    onDiagnostics: (data) => events.push(["diagnostics", data]),
    onFailure: (type) => events.push(["failure", type]),
    onError: (type, error) => events.push(["error", type, error.message]),
    onRecovered: (type) => events.push(["recovered", type]),
  });
  return {
    poller, state, calls, events,
    bumpGeneration: () => { generation += 1; },
  };
}

test("同一端点并发读取只发一次请求", async () => {
  let release;
  const harnessed = harness({ statusFn: () => new Promise((resolve) => { release = () => resolve({ n: 1 }); }) });
  const first = harnessed.poller.loadStatus();
  const second = harnessed.poller.loadStatus();
  assert.equal(harnessed.calls.status, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(harnessed.events, [["status", { n: 1 }], ["recovered", "status"]], "只写一次状态，且非静默刷新提示已刷新");
});

test("操作后的强制刷新等待旧请求，再读取新状态", async () => {
  let resolveOld;
  const responses = [new Promise((resolve) => { resolveOld = () => resolve({ n: "old" }); }), { n: "new" }];
  let index = 0;
  const harnessed = harness({ statusFn: () => responses[index++] });
  const old = harnessed.poller.loadStatus();
  const fresh = harnessed.poller.loadStatus({ fresh: true });
  await tick();
  assert.equal(harnessed.calls.status, 1);
  harnessed.bumpGeneration();
  resolveOld();
  await Promise.all([old, fresh]);
  assert.deepEqual(harnessed.events.filter(([type]) => type === "status"), [["status", { n: "new" }]], "旧代次结果被丢弃");
});

test("迟到响应在会话切换后不覆盖界面", async () => {
  let resolveStatus;
  const harnessed = harness({ statusFn: () => new Promise((resolve) => { resolveStatus = () => resolve({ stale: true }); }) });
  const pending = harnessed.poller.loadStatus();
  harnessed.bumpGeneration();
  resolveStatus();
  await pending;
  assert.deepEqual(harnessed.events, [], "旧代次响应不得写入状态");
});

test("连续失败两次才提示服务不可用，恢复后清除", async () => {
  let fail = true;
  const harnessed = harness({
    statusFn: () => {
      if (fail) throw new Error("offline");
      return { recovered: true };
    },
  });
  await harnessed.poller.loadStatus({ silent: true });
  assert.equal(harnessed.events.filter(([type]) => type === "failure").length, 1);
  assert.equal(harnessed.events.filter(([type]) => type === "recovered").length, 0, "沉默刷新成功不提示已刷新");
  fail = false;
  await harnessed.poller.loadStatus({ silent: true });
  assert.deepEqual(harnessed.events.at(-1), ["status", { recovered: true }]);
});

test("无令牌时不发请求", async () => {
  const harnessed = harness();
  harnessed.state.token = "";
  await harnessed.poller.loadStatus();
  await harnessed.poller.loadDiagnostics();
  assert.equal(harnessed.calls.status, 0);
  assert.equal(harnessed.calls.diagnostics, 0);
});

test("401 触发令牌失效回调，且不把响应当普通错误", async () => {
  const seen = [];
  const api = createApi({
    fetchFn: async () => ({ status: 401, ok: false, json: async () => ({}) }),
    getToken: () => "token",
    onUnauthorized: (message) => seen.push(message),
  });
  await assert.rejects(() => api.status(), /后台令牌无效/);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /重新点击/);
});

test("非 401 的失败使用服务端消息或状态码", async () => {
  const withMessage = createApi({
    fetchFn: async () => ({ status: 500, ok: false, json: async () => ({ message: "读取失败" }) }),
    getToken: () => "token",
  });
  await assert.rejects(() => withMessage.diagnostics(), /读取失败/);
  const withoutBody = createApi({
    fetchFn: async () => ({ status: 502, ok: false, json: async () => { throw new Error("no json"); } }),
    getToken: () => "token",
  });
  await assert.rejects(() => withoutBody.diagnostics(), /HTTP 502/);
});

test("诊断导出只保留白名单，丢弃任意标识与文本", () => {
  const exported = diagnosticExport({
    status: {
      auth: { state: "signed-in", userId: "private-user" },
      config: { region: "china", printerId: "private-device" },
      devices: [{ id: "private-device" }],
      printer: {
        link: { state: "connected", attempt: 2, lastError: { message: "private-error" } },
        state: {
          activity: "printing", lastReportAt: 12, taskName: "private-task",
          progressPercent: 42, remainingMinutes: 7,
          nozzle: { current: 200, target: 210 }, bed: { current: 60, target: 60 },
          chamber: { current: 30 },
        },
      },
    },
    diagnostics: { requests: [
      { at: 1, method: "GET", path: "/private-device", status: 200, kind: "network", durationMs: 42 },
      { at: 2, method: "TRACE", status: 200, kind: "private-kind" },
    ] },
    now: () => new Date(0),
  });
  const text = JSON.stringify(exported);
  assert.doesNotMatch(text, /private-/);
  assert.equal(exported.status.printerState.activity, "printing");
  assert.equal(exported.status.printerState.progressPercent, 42);
  assert.deepEqual(exported.diagnostics.requests[0], { at: 1, method: "GET", status: 200, kind: "network", durationMs: 42 });
  assert.deepEqual(exported.diagnostics.requests[1], { at: 2, method: null, status: 200, kind: null, durationMs: null });
});
