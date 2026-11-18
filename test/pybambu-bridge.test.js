const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const SCRIPT = path.join(__dirname, "unused-script");
const { PyBambuBridge } = require("../src/pybambu/bridge");

function makeBridge(source, options = {}) {
  return new PyBambuBridge({
    pythonCommand: process.execPath,
    scriptPath: SCRIPT,
    spawnFn: (command, args, settings) => {
      assert.equal(command, process.execPath);
      assert.deepEqual(args, [SCRIPT]);
      assert.equal(settings.shell, false);
      return spawn(command, ["-e", source], settings);
    },
    timeoutMs: 1000,
    stopTimeoutMs: 100,
    ...options,
  });
}

const server = `
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', line => {
    const req = JSON.parse(line);
    if (req.method === 'hello') return process.stdout.write(JSON.stringify({id:req.id,result:{protocol:1}})+'\\n');
    const op = req.params.op;
    if (op === 'hang') return;
    if (op === 'crash') return process.exit(1);
    if (op === 'error') return process.stdout.write(JSON.stringify({id:req.id,error:{code:'secret-code',message:'secret-message'}})+'\\n');
    if (op === 'oversize') return process.stdout.write('x'.repeat(200));
    if (op === 'invalid') return process.stdout.write('not-json\\n');
    const response = JSON.stringify({id:req.id,result:req.params})+'\\n';
    setTimeout(() => {
      const bytes = Buffer.from(response);
      process.stdout.write(bytes.subarray(0, 2));
      process.stdout.write(bytes.subarray(2));
    }, op === 'slow' ? 40 : 0);
  });
`;

test("只接受显式绝对 Python 路径及受限模式", () => {
  for (const command of [undefined, "python3", "./python3", ""]) {
    assert.throws(() => new PyBambuBridge({ pythonCommand: command, scriptPath: SCRIPT }), TypeError);
  }
  for (const scriptPath of [undefined, "script.py", "./script.py", ""]) {
    assert.throws(() => new PyBambuBridge({ pythonCommand: process.execPath, scriptPath }), TypeError);
  }
  assert.throws(() => new PyBambuBridge({ pythonCommand: process.execPath, scriptPath: SCRIPT, mode: "arbitrary" }), TypeError);
});

test("握手后并发请求按 id 关联乱序、分片和 UTF-8 响应", async (t) => {
  const bridge = makeBridge(server).start();
  t.after(() => bridge.stop());
  const slow = bridge.request("update", { op: "slow", text: "中文" });
  const fast = bridge.request("update", { value: 2 });
  const remote = bridge.request("update", { op: "error" });
  await assert.rejects(remote, (error) => error.code === "REMOTE_ERROR" && !JSON.stringify(error).includes("secret"));
  assert.deepEqual(await fast, { value: 2 });
  assert.deepEqual(await slow, { op: "slow", text: "中文" });
  await assert.rejects(bridge.request("monitor.start"), { code: "METHOD_NOT_ALLOWED" });
  await assert.rejects(bridge.request("shutdown"), { code: "METHOD_NOT_ALLOWED" });
});

test("协议版本和 monitor 能力不匹配时拒绝请求", async () => {
  for (const [reply, mode] of [[{ protocol: 2 }, "probe"], [{ protocol: 1 }, "monitor"], [{ protocol: 1, capabilities: ["monitor.passive"] }, "monitor"], [{ protocol: 1, capabilities: ["monitor.passive", "monitor.snapshot"] }, "monitor"]]) {
    const source = `require('node:readline').createInterface({input:process.stdin}).on('line', l => { const r=JSON.parse(l); process.stdout.write(JSON.stringify({id:r.id,result:${JSON.stringify(reply)}})+'\\n'); });`;
    const bridge = makeBridge(source, { mode }).start();
    await assert.rejects(bridge.request("hello"), { code: "HANDSHAKE_FAILED" });
    await bridge.stop();
  }
});

test("monitor 只允许白名单方法并原样传递 poll 参数", async (t) => {
  const source = `const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',l=>{const r=JSON.parse(l); if(r.method==='hello') return process.stdout.write(JSON.stringify({id:r.id,result:{protocol:1,capabilities:['monitor.passive','monitor.snapshot','monitor.poll-deltas']}})+'\\n'); if(r.method==='shutdown') return process.exit(0); process.stdout.write(JSON.stringify({id:r.id,result:{method:r.method,params:r.params}})+'\\n');});`;
  const bridge = makeBridge(source, { mode: "monitor" }).start();
  t.after(() => bridge.stop());
  const params = { generation: 7, afterSeq: 19 };
  assert.deepEqual(await bridge.request("monitor.poll", params), { method: "monitor.poll", params });
  for (const method of ["monitor.start", "monitor.snapshot", "monitor.stop"]) {
    assert.deepEqual(await bridge.request(method), { method, params: {} });
  }
  for (const method of ["monitor.pause", "monitor.refresh", "publish", "update", "shutdown"]) {
    await assert.rejects(bridge.request(method), { code: "METHOD_NOT_ALLOWED" });
  }
});

test("monitor 优先发送 shutdown 并等待实际退出", async () => {
  const source = `const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',l=>{const r=JSON.parse(l); if(r.method==='hello') process.stdout.write(JSON.stringify({id:r.id,result:{protocol:1,capabilities:['monitor.passive','monitor.snapshot','monitor.poll-deltas']}})+'\\n'); else if(r.method==='shutdown') setTimeout(()=>process.exit(0),40); else process.stdout.write(JSON.stringify({id:r.id,result:{ok:true}})+'\\n');}); process.stdin.on('end',()=>{});`;
  const bridge = makeBridge(source, { mode: "monitor", stopTimeoutMs: 300 }).start();
  assert.deepEqual(await bridge.request("monitor.snapshot"), { ok: true });
  await assert.rejects(bridge.request("update"), { code: "METHOD_NOT_ALLOWED" });
  const child = bridge.child;
  await bridge.stop();
  assert.equal(child.exitCode, 0);
  assert.equal(child.signalCode, null);
});

test("拒绝退出的进程在宽限期后被强制终止", async () => {
  const source = `const rl=require('node:readline').createInterface({input:process.stdin}); rl.on('line',l=>{const r=JSON.parse(l); if(r.method==='hello') process.stdout.write(JSON.stringify({id:r.id,result:{protocol:1,capabilities:['monitor.passive','monitor.snapshot','monitor.poll-deltas']}})+'\\n');}); setInterval(()=>{},1000);`;
  const bridge = makeBridge(source, { mode: "monitor", stopTimeoutMs: 80 }).start();
  await bridge.request("hello");
  const child = bridge.child;
  await bridge.stop();
  assert.equal(child.signalCode, "SIGKILL");
});

test("超时后忽略迟到响应，其他请求仍可使用", async (t) => {
  const bridge = makeBridge(server, { timeoutMs: 150 }).start();
  t.after(() => bridge.stop());
  await assert.rejects(bridge.request("update", { op: "hang" }), { code: "TIMEOUT" });
  assert.deepEqual(await bridge.request("update", { ok: true }), { ok: true });
});

test("停止拒绝待处理请求，关闭后可重新启动", async () => {
  const bridge = makeBridge(server).start();
  await bridge.request("hello");
  const rejected = assert.rejects(bridge.request("update", { op: "hang" }), { code: "BRIDGE_STOPPED" });
  // Allow the authorized request to enter the pending map before stopping.
  await Promise.resolve();
  await Promise.all([bridge.stop(), rejected]);
  await assert.rejects(bridge.request("update"), { code: "BRIDGE_STATE" });
  bridge.start();
  assert.deepEqual(await bridge.request("update", { restarted: true }), { restarted: true });
  await bridge.stop();
});

test("进程崩溃时拒绝所有请求", async () => {
  const bridge = makeBridge(server).start();
  await bridge.request("hello");
  const first = bridge.request("update", { op: "hang" });
  const second = bridge.request("update", { op: "crash" });
  await Promise.all([assert.rejects(first, { code: "PROCESS_CLOSED" }), assert.rejects(second, { code: "PROCESS_CLOSED" })]);
  await bridge.stop();
});

test("响应超限或格式错误时终止进程并拒绝请求", async () => {
  for (const [op, code] of [["oversize", "OUTPUT_LIMIT"], ["invalid", "PROTOCOL_ERROR"]]) {
    const bridge = makeBridge(server, { maxOutputBytes: 64 }).start();
    await assert.rejects(bridge.request("update", { op }), { code });
    await bridge.stop();
  }
});

test("请求字节上限包含 JSON 与换行，超限后仍可发送", async (t) => {
  const request = { id: 2, method: "update", params: { text: "中文" } };
  const size = Buffer.byteLength(JSON.stringify(request) + "\n");
  const bridge = makeBridge(server, { maxRequestBytes: size }).start();
  t.after(() => bridge.stop());
  assert.deepEqual(await bridge.request("update", request.params), request.params);
  await assert.rejects(bridge.request("update", { text: "中文x" }), { code: "REQUEST_LIMIT" });
  assert.deepEqual(await bridge.request("update", { text: "ok" }), { text: "ok" });
});

test("握手期间等待的请求也受并发上限限制", async () => {
  const bridge = makeBridge(server, { maxPendingRequests: 1 }).start();
  const first = bridge.request("update", { ok: true });
  await assert.rejects(bridge.request("update", { ok: false }), { code: "PENDING_LIMIT" });
  assert.deepEqual(await first, { ok: true });
  await bridge.stop();
});

test("待处理请求达到上限时拒绝新请求，超时后释放名额", async (t) => {
  const bridge = makeBridge(server, { maxPendingRequests: 1, timeoutMs: 150 }).start();
  t.after(() => bridge.stop());
  await bridge.request("hello");
  const timeout = assert.rejects(bridge.request("update", { op: "hang" }), { code: "TIMEOUT" });
  await assert.rejects(bridge.request("update"), { code: "PENDING_LIMIT" });
  await timeout;
  assert.deepEqual(await bridge.request("update", { ok: true }), { ok: true });
});

test("启动失败和请求序列化失败不暴露原始敏感信息", async () => {
  const bridge = new PyBambuBridge({ pythonCommand: process.execPath, scriptPath: SCRIPT, spawnFn: () => { throw new Error("secret"); } });
  assert.throws(() => bridge.start(), (error) => error.code === "SPAWN_FAILED" && !error.message.includes("secret"));
  const running = makeBridge(server).start();
  const circular = {}; circular.self = circular;
  await assert.rejects(running.request("update", circular), { code: "INVALID_REQUEST" });
  await running.stop();
});
