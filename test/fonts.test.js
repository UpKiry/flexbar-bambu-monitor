const test = require("node:test");
const assert = require("node:assert/strict");
const { registerDashboardFont, FONT_FAMILY } = require("../src/display/fonts");

test("注册可用的中文字体并回退缺失字体", () => {
  const calls = [];
  const fonts = { registerFromPath(file, family) { calls.push([file, family]); return calls.length === 2; } };
  assert.equal(registerDashboardFont(fonts, { platform: "darwin" }), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, family]) => family === FONT_FAMILY));
  assert.equal(registerDashboardFont({}, { platform: "win32" }), false);
});
