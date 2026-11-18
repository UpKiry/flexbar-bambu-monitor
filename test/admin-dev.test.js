const test = require("node:test");
const assert = require("node:assert/strict");
const { createDevPlugin } = require("../scripts/admin-dev");

test("development host keeps configuration only in memory", async () => {
  const host = createDevPlugin();
  await host.setConfig({ region: "china", printerId: "DEVICE", printerName: "A1" });
  assert.equal((await host.getConfig()).printerId, "DEVICE");
  assert.equal((await createDevPlugin().getConfig()).printerId, "");
});
