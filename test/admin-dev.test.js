const test = require("node:test");
const assert = require("node:assert/strict");
const { devMonitorFactory, createDevPlugin } = require("../scripts/admin-dev");

test("development monitor requires explicit absolute Python selection", () => {
  assert.equal(devMonitorFactory([]), undefined);
  assert.throws(() => devMonitorFactory(["--pybambu-python=python3"]), /绝对路径/);
  assert.throws(() => devMonitorFactory(["--pybambu-python=/one", "--pybambu-python=/two"]), /绝对路径/);
  const factory = devMonitorFactory(["--pybambu-python=/opt/python3"]);
  assert.equal(typeof factory, "function");
  const manager = factory({ logger: {} });
  assert.equal(manager.connected, false);
});

test("development host keeps configuration only in memory", async () => {
  const host = createDevPlugin();
  await host.setConfig({ region: "china", printerId: "DEVICE", printerName: "A1" });
  assert.equal((await host.getConfig()).printerId, "DEVICE");
  assert.equal((await createDevPlugin().getConfig()).printerId, "");
});
