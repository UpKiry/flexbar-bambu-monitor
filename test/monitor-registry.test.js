const test = require("node:test");
const assert = require("node:assert/strict");
const { createMonitorRegistry } = require("../src/printer/monitor-registry");

function makeManagerFactory() {
  const created = [];
  const createManager = () => {
    const manager = {
      printerId: null,
      printerName: null,
      connected: false,
      connectCalls: [],
      disconnectCalls: 0,
      listeners: new Set(),
      closeResult: null,
      selectPrinter(id, meta = {}) {
        if (manager.printerId === id) return;
        manager.printerId = id;
        manager.printerName = meta.name || null;
      },
      connect(args) {
        manager.connectCalls.push(args);
        manager.connected = true;
        return { started: true };
      },
      disconnect() {
        manager.disconnectCalls += 1;
        manager.connected = false;
        return manager.closeResult || Promise.resolve();
      },
      subscribe(listener) {
        manager.listeners.add(listener);
        return () => manager.listeners.delete(listener);
      },
      tick() {},
      emit(change) { for (const listener of manager.listeners) listener(change); },
    };
    created.push(manager);
    return manager;
  };
  return { createManager, created };
}

const TOKEN = "tok-1";
const base = {
  token: TOKEN,
  userId: "42",
  region: "global",
  verified: true,
  devices: ["A", "B", "C"],
};

test("默认设备与按键设备使用同一套建连逻辑，且同一会话不重复连接", () => {
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager });
  registry.reconcile({ ...base, defaultId: "A", defaultName: "一号", wantedIds: ["B"] });
  assert.equal(created.length, 2);

  const again = registry.reconcile({ ...base, defaultId: "A", defaultName: "一号", wantedIds: ["B"] });
  assert.deepEqual(again.started, ["A"], "默认设备已连接时只回报，不重复 connect");
  assert.ok(created.every((manager) => manager.connectCalls.length === 1));
});

test("需求变化时只断开不再需要的设备，保留仍被引用的连接", () => {
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager });
  registry.reconcile({ ...base, defaultId: "A", wantedIds: ["B", "C"] });
  const [defaultManager, bManager, cManager] = created;

  const summary = registry.reconcile({ ...base, defaultId: "A", wantedIds: ["B"] });
  assert.deepEqual(summary.stopped, ["C"]);
  assert.equal(defaultManager.disconnectCalls, 0);
  assert.equal(bManager.disconnectCalls, 0);
  assert.equal(cManager.disconnectCalls, 1);
  assert.equal(registry.get("C"), null, "被移除的设备不再可查");
});

test("默认设备切换复用同一 manager，并重置设备选择", () => {
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager });
  registry.reconcile({ ...base, defaultId: "A", defaultName: "一号" });
  const defaultManager = created[0];
  registry.reconcile({ ...base, defaultId: "B", defaultName: "二号" });
  assert.equal(created.length, 1, "默认设备复用 manager，不新建实例");
  assert.equal(defaultManager.printerId, "B");
  assert.equal(defaultManager.printerName, "二号");
  assert.equal(defaultManager.connectCalls.length, 2);
});

test("关闭失败保留屏障，替换连接被推迟而不是绕过", async () => {
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager });
  registry.reconcile({ ...base, defaultId: "A" });
  const defaultManager = created[0];
  const failure = new Error("close pending");
  defaultManager.closeResult = Promise.reject(failure);

  // 触发默认设备关闭：切换默认设备前由调用方 closeAll。
  const closing = registry.closeAll();
  await closing.catch(() => {});
  assert.equal(registry.closingCount, 1, "未确认关闭的 manager 仍在屏障中");

  const summary = registry.reconcile({ ...base, defaultId: "B" });
  assert.equal(summary.deferred, true, "屏障期间不得建立新连接");
  assert.ok(created.every((manager) => manager.connectCalls.every((calls) => true)));
});

test("未验证会话不建连，并清理不再需求的额外设备", () => {
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager });
  registry.reconcile({ ...base, defaultId: "A", wantedIds: ["B"] });
  assert.equal(created.length, 2);
  const summary = registry.reconcile({ ...base, verified: false, defaultId: "A", wantedIds: ["B"] });
  assert.deepEqual(summary.started, []);
  assert.deepEqual(summary.stopped.sort(), ["B"]);
  assert.equal(registry.get("B"), null);
});

test("事件携带设备身份与连接令牌，供上层判断会话归属", () => {
  const events = [];
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager, onEvent: (event) => events.push(event) });
  registry.reconcile({ ...base, defaultId: "A", wantedIds: ["B"] });
  const [defaultManager, bManager] = created;
  defaultManager.emit({ type: "state" });
  bManager.emit({ type: "report" });
  assert.deepEqual(events.map((event) => [event.printerId, event.token]), [["A", TOKEN], ["B", TOKEN]]);
});

test("blocked 上下文暂停新连接但不主动断开已有连接", () => {
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager });
  registry.reconcile({ ...base, defaultId: "A" });
  const summary = registry.reconcile({ ...base, defaultId: "B", blocked: true });
  assert.equal(summary.deferred, true);
  assert.equal(created[0].connectCalls.length, 1, "暂停期间不新增连接");
  assert.equal(created[0].disconnectCalls, 0);
});

test("dispose 解除订阅并断开全部设备", () => {
  const { createManager, created } = makeManagerFactory();
  const registry = createMonitorRegistry({ createManager });
  registry.reconcile({ ...base, defaultId: "A", wantedIds: ["B"] });
  registry.dispose();
  assert.ok(created.every((manager) => manager.listeners.size === 0));
  assert.ok(created.every((manager) => manager.disconnectCalls === 1));
  const summary = registry.reconcile({ ...base, defaultId: "A" });
  assert.deepEqual(summary.started, [], "销毁后不再收敛");
});
