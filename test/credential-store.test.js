const test = require("node:test");
const assert = require("node:assert/strict");
const { createCredentialStore, createKeychainBackend } = require("../src/auth/credential-store");
const { createAuthService } = require("../src/auth/auth-service");

test("keychain persists via stdin and restores without exposing secrets in argv", async () => {
  const calls = [];
  let stored = null;
  const backend = createKeychainBackend({ runner: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "default-keychain") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "-i") { stored = options.input.match(/ -w (\S+)\n$/)[1]; return { code: 0, stdout: "", stderr: "" }; }
    if (args[0] === "find-generic-password") return { code: stored ? 0 : 44, stdout: stored || "", stderr: "" };
    if (args[0] === "delete-generic-password") { stored = null; return { code: 0, stdout: "", stderr: "" }; }
    throw new Error("unexpected");
  } });
  const store = createCredentialStore({ backend });
  const secret = '{"token":"example-secret"}';
  assert.equal((await store.save(secret)).persisted, true);
  assert.equal(await createCredentialStore({ backend }).load(), secret);
  assert.ok(calls.every(({ args }) => !JSON.stringify(args).includes("example-secret")));
  assert.ok(calls.find(({ args }) => args[0] === "-i").options.input.includes("bambu-base64-v1:"));
  await store.clear();
  assert.equal(await store.load(), null);
});

test("failed keychain writes fall back only after clearing old credentials", async () => {
  const calls = [];
  const backend = createKeychainBackend({ runner: async (_command, args) => {
    calls.push(args[0]);
    if (args[0] === "default-keychain") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "-i") return { code: 0, stdout: "", stderr: "denied" };
    if (args[0] === "find-generic-password") return { code: 44, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  } });
  const store = createCredentialStore({ backend });
  assert.equal((await store.save("example-secret")).persisted, false);
  assert.equal(await store.load(), "example-secret");
  assert.ok(calls.includes("delete-generic-password"));
  await store.clear();
});

test("failed write and failed cleanup cannot silently restore an old account", async () => {
  const backend = createKeychainBackend({ runner: async (_command, args) => {
    if (args[0] === "default-keychain") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "-i") return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "example-secret" };
  } });
  await assert.rejects(createCredentialStore({ backend }).save("example-secret"), /删除系统钥匙串/);
});

test("unimplemented Windows credential storage falls back to memory", async () => {
  const store = createCredentialStore({ platform: "win32" });
  const status = await store.status();
  assert.equal(status.available, false);
  assert.match(status.reason, /内存/);
  assert.equal((await store.save("example-secret")).persisted, false);
  assert.equal(await store.load(), "example-secret");
  await store.clear();
  assert.equal(await store.load(), null);
});

test("keychain cleanup failure propagates even when persistence is unavailable", async () => {
  const backend = createKeychainBackend({ runner: async () => ({ code: 1, stdout: "", stderr: "denied" }) });
  const store = createCredentialStore({ backend });
  await store.save("example-secret");
  await assert.rejects(store.clear(), /删除系统钥匙串/);
  assert.equal(await store.load(), null);
});

test("logout reports a failed delete after clearing memory and attempting remote logout", async () => {
  let revoked = false;
  const api = {
    regionId: "global",
    login: async () => ({ accessToken: "example-token" }),
    fetchUserId: async () => "42",
    logout: async () => { revoked = true; },
  };
  const backend = createKeychainBackend({ runner: async () => ({ code: 1, stdout: "", stderr: "denied" }) });
  const auth = createAuthService({ createApi: () => api, credentialStore: createCredentialStore({ backend }), logger: {} });
  assert.equal((await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" })).persisted, false);
  await assert.rejects(auth.logout(), /本地凭据删除失败/);
  assert.equal(auth.getAccessToken(), null);
  assert.equal(auth.snapshot().state, "signed-out");
  assert.equal(revoked, true);
});
