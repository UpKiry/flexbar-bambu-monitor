const test = require("node:test");
const assert = require("node:assert/strict");
const { createDiagnostics, sanitizePath } = require("../src/admin/diagnostics");

test("diagnostics redacts log secrets and keeps only request metadata", () => {
  const diagnostics = createDiagnostics();
  diagnostics.recordLog({ level: "info", message: "login token=secret123", at: 1000 });
  diagnostics.recordRequest({
    method: "post",
    path: "/v1/user-service/user/login?account=a@b.c",
    status: 200,
    durationMs: 12.6,
    headers: { authorization: "Bearer tok" },
    body: { password: "pw" },
  });

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.logs.length, 1);
  assert.equal(snapshot.logs[0].level, "info");
  assert.ok(!snapshot.logs[0].message.includes("secret123"));
  assert.equal(snapshot.requests.length, 1);
  assert.deepEqual(Object.keys(snapshot.requests[0]).sort(), ["at", "durationMs", "kind", "method", "path", "status"]);
  assert.equal(snapshot.requests[0].method, "POST");
  assert.equal(snapshot.requests[0].path, "/v1/user-service/user/login");
  assert.equal(snapshot.requests[0].durationMs, 13);
  assert.ok(!JSON.stringify(snapshot).includes("Bearer tok"));
  assert.ok(!JSON.stringify(snapshot).includes('"pw"'));
});

test("diagnostics bounds memory and reports counts", () => {
  const diagnostics = createDiagnostics({ logCapacity: 2, requestCapacity: 1 });
  diagnostics.recordLog({ level: "info", message: "first" });
  diagnostics.recordLog({ level: "warn", message: "second" });
  diagnostics.recordLog({ level: "error", message: "third" });
  diagnostics.recordRequest({ method: "GET", path: "/a" });
  diagnostics.recordRequest({ method: "GET", path: "/b" });

  const snapshot = diagnostics.snapshot();
  assert.deepEqual(snapshot.logs.map((entry) => entry.message), ["third", "second"]);
  assert.deepEqual(snapshot.requests.map((entry) => entry.path), ["/b"]);
  assert.deepEqual(diagnostics.summary(), {
    startedAt: snapshot.startedAt,
    logCount: 2,
    requestCount: 1,
  });
});

test("sanitizePath removes query strings and fragments", () => {
  assert.equal(sanitizePath("/v1/path?token=abc#x"), "/v1/path");
  assert.equal(sanitizePath(""), "/");
  assert.equal(sanitizePath("/v1/path#frag"), "/v1/path");
});
