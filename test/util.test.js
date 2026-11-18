const test = require("node:test");
const assert = require("node:assert/strict");
const { redact, createSafeLogger } = require("../src/util/logger");
const { resolveRegion, isKnownRegion, listRegions, regionMismatchHint } = require("../src/cloud/region");

test("redact hides tokens, passwords, codes and access codes", () => {
  const raw = JSON.stringify({
    accessToken: "abc.def.ghi",
    refreshToken: "xyz",
    password: "hunter2",
    dev_access_code: "1234abcd",
  });
  const output = redact(raw);
  assert.ok(!output.includes("abc.def.ghi"));
  assert.ok(!output.includes("hunter2"));
  assert.ok(!output.includes("1234abcd"));
  assert.ok(output.includes("accessToken"));
});

test("redact removes bearer headers and auth cookies", () => {
  const output = redact("Authorization: Bearer eyJhbGciOi.xx.yy; auth-token=secrettoken");
  assert.ok(!output.includes("eyJhbGciOi"));
  assert.ok(!output.includes("secrettoken"));
});

test("redact suppresses explicitly provided secrets anywhere in the text", () => {
  const output = redact("request failed token=supersecretvalue in body", ["supersecretvalue"]);
  assert.ok(!output.includes("supersecretvalue"));
});

test("createSafeLogger throttles identical errors and hides secrets", () => {
  const lines = [];
  let clock = 0;
  const logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m), debug: (m) => lines.push(m) };
  const safe = createSafeLogger(logger, { repeatIntervalMs: 1000, now: () => clock });

  safe.error("failed with token abc123456", ["abc123456"]);
  safe.error("failed with token abc123456", ["abc123456"]);
  clock = 500;
  safe.error("failed with token abc123456", ["abc123456"]);
  clock = 1500;
  safe.error("failed with token abc123456", ["abc123456"]);

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => !line.includes("abc123456")));
});

test("region resolution never guesses and reports fallback", () => {
  assert.equal(resolveRegion("china").apiBaseUrl, "https://api.bambulab.cn");
  assert.equal(resolveRegion("global").mqttHost, "us.mqtt.bambulab.com");
  assert.equal(resolveRegion("china").fallback, false);

  const fallback = resolveRegion("eu");
  assert.equal(fallback.id, "global");
  assert.equal(fallback.fallback, true);
  // 空值表示"还没选"，不算配置错误
  assert.equal(resolveRegion(undefined).fallback, false);
  // 空字符串等价于"还没选"，直接使用默认区域，不算配置错误
  assert.equal(resolveRegion("").fallback, false);
  assert.equal(resolveRegion("").id, "global");

  assert.equal(isKnownRegion("global"), true);
  assert.equal(isKnownRegion("mars"), false);
  assert.deepEqual(listRegions().map((item) => item.id), ["global", "china"]);
  assert.match(regionMismatchHint("china"), /中国大陆/);
});

test("redact does not append the match offset to one-group patterns", () => {
  assert.equal(redact("token=secret123"), "token=[已隐藏]");
  assert.equal(redact("hello token=secret123"), "hello token=[已隐藏]");
});

test("createSafeLogger sends redacted records to the diagnostics sink", () => {
  const records = [];
  const lines = [];
  const logger = {
    info: (m) => lines.push(m),
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const safe = createSafeLogger(logger, {
    repeatIntervalMs: 0,
    onRecord: (entry) => records.push(entry),
  });
  safe.info("login token=secret123", ["secret123"]);
  assert.equal(records.length, 1);
  assert.equal(records[0].level, "info");
  assert.ok(!records[0].message.includes("secret123"));
  assert.ok(lines[0].includes("[已隐藏]"));
});
