const test = require("node:test");
const assert = require("node:assert/strict");
const { createAuthService, STATES, normalizeSession } = require("../src/auth/auth-service");
const { CloudApi, CloudApiError, ERROR_KINDS } = require("../src/cloud/cloud-api");
const { createCredentialStore, createMemoryBackend } = require("../src/auth/credential-store");

function memoryStore({ available = true, reason = "" } = {}) {
  const backend = createMemoryBackend();
  backend.probe = async () => ({ available, reason });
  return createCredentialStore({ backend });
}

function makeApi({ region = "global", login, requestEmailCode, fetchUserId, logout } = {}) {
  return {
    regionId: region,
    regionLabel: region === "china" ? "中国大陆" : "全球",
    login: login || (async () => ({ accessToken: "tok", refreshToken: "ref", expiresInSeconds: 3600, loginType: "" })),
    requestEmailCode: requestEmailCode || (async () => ({ codeSent: true, login: null })),
    fetchUserId: fetchUserId || (async () => "42"),
    logout: logout || (async () => true),
  };
}

function setup(apiOptions, storeOptions) {
  const api = makeApi(apiOptions);
  const store = memoryStore(storeOptions);
  const logged = [];
  const auth = createAuthService({
    createApi: () => api,
    credentialStore: store,
    logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m), error: (m) => logged.push(m) },
    now: () => 1_000_000,
  });
  return { auth, api, store, logged };
}

test("password login walks signed-out → signing-in → signed-in", async () => {
  const { auth } = setup();
  assert.equal(auth.state, STATES.signedOut);

  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  assert.equal(result.status, "success");
  assert.equal(auth.state, STATES.signedIn);
  assert.equal(auth.getAccessToken(), "tok");
  assert.equal(auth.getUserId(), "42");
  assert.equal(auth.getRegion(), "global");
});

test("real cloud adapter login and user ID failure keep echoed token out of logs and diagnostics", async () => {
  const secret = "FAKE-token-732009";
  const events = [];
  const logged = [];
  const api = new CloudApi({
    region: "global",
    requestFn: async ({ url }) => url.endsWith("/login")
      ? { status: 200, text: JSON.stringify({ accessToken: secret }) }
      : { status: 500, text: JSON.stringify({ error: secret }) },
    onRequest: (event) => events.push(event),
  });
  const auth = createAuthService({
    createApi: () => api,
    credentialStore: memoryStore(),
    logger: { info: (m) => logged.push(m), warn: (m) => logged.push(m) },
  });
  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "FAKE-password" });
  assert.equal(result.status, "success");
  assert.equal(auth.getAccessToken(), secret);
  assert.equal(auth.getUserId(), null);
  assert.ok(!JSON.stringify({ result, logged, events }).includes(secret));
});

test("login user ID failures and remote logout never log echoed secrets", async () => {
  const secret = "FAKE-token-1345876";
  const { auth, logged } = setup({
    login: async () => ({ accessToken: secret }),
    fetchUserId: async () => { throw new Error(`response ${secret}`); },
    logout: async () => { throw new Error(`network ${secret}`); },
  });
  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "FAKE-password" });
  assert.equal(result.status, "success");
  assert.equal(auth.getUserId(), null);
  await auth.logout();
  assert.ok(!JSON.stringify({ result, logged }).includes(secret));
});

test("auth errors use fixed messages even when injected errors echo credentials", async () => {
  const secret = "FAKE-password-code-491127";
  for (const error of [new Error(secret), new CloudApiError(ERROR_KINDS.invalidCredentials, secret)]) {
    const { auth, logged } = setup({ login: async () => { throw error; } });
    const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: secret });
    assert.equal(result.status, "failed");
    assert.ok(!JSON.stringify({ result, logged, snapshot: auth.snapshot() }).includes(secret));
  }
});

test("a failed login keeps the user in a retryable failed state", async () => {
  const { auth } = setup({
    login: async () => {
      throw new CloudApiError(ERROR_KINDS.invalidCredentials, "账号或密码错误");
    },
  });
  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "bad" });
  assert.equal(result.status, "failed");
  assert.equal(auth.state, STATES.failed);
  assert.equal(result.error.kind, ERROR_KINDS.invalidCredentials);
  assert.equal(auth.getAccessToken(), null);
});

test("rate limiting is surfaced, never retried", async () => {
  let attempts = 0;
  const { auth } = setup({
    login: async () => {
      attempts += 1;
      throw new CloudApiError(ERROR_KINDS.rateLimited, "请求过于频繁，请稍后再试");
    },
  });
  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  assert.equal(result.status, "failed");
  assert.equal(attempts, 1);
});

test("verification-code flow moves through awaiting-code and completes", async () => {
  const api = makeApi({
    login: async ({ code }) => {
      if (!code) throw new CloudApiError(ERROR_KINDS.verificationRequired, "该账号需要输入邮箱验证码");
      return { accessToken: "tok2", refreshToken: "", expiresInSeconds: 60, loginType: "verifyCode" };
    },
  });
  const store = memoryStore();
  const auth = createAuthService({ createApi: () => api, credentialStore: store, logger: {} });

  const requested = await auth.requestEmailCode({ region: "global", account: "a@b.c" });
  assert.equal(requested.status, "code-sent");
  assert.equal(auth.state, STATES.awaitingCode);

  const submitted = await auth.submitCode({ code: "123456" });
  assert.equal(submitted.status, "success");
  assert.equal(auth.state, STATES.signedIn);
  assert.equal(auth.getAccessToken(), "tok2");
});

test("submitting a code without a pending flow is rejected", async () => {
  const { auth } = setup();
  const result = await auth.submitCode({ code: "123456" });
  assert.equal(result.status, "failed");
  assert.equal(result.error.kind, ERROR_KINDS.verificationInvalid);
});

test("unsupported two-factor stops instead of bypassing verification", async () => {
  const { auth } = setup({
    login: async () => {
      throw new CloudApiError(ERROR_KINDS.twoFactorRequired, "TFA required");
    },
  });
  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  assert.equal(result.status, "unsupported");
  assert.equal(auth.state, STATES.awaitingTwoFactor);
  assert.equal(auth.getAccessToken(), null);
});

test("session is restored from secure storage on restart", async () => {
  const { auth, store } = setup();
  await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  assert.ok(await store.load());

  const restored = createAuthService({
    createApi: () => makeApi(),
    credentialStore: store,
    logger: {},
    now: () => 1_000_000,
  });
  const snapshot = await restored.hydrate();
  assert.equal(snapshot.state, STATES.signedIn);
  assert.equal(restored.getAccessToken(), "tok");
  assert.equal(restored.getRegion(), "global");
});

test("expired sessions are not treated as signed in", async () => {
  const backend = createMemoryBackend();
  backend.probe = async () => ({ available: true });
  const store = createCredentialStore({ backend });
  await store.save(JSON.stringify({
    session: { accessToken: "tok", region: "global", expiresAt: 500, issuedAt: 100 },
  }));

  const auth = createAuthService({
    createApi: () => makeApi(),
    credentialStore: store,
    logger: {},
    now: () => 1_000,
  });
  const snapshot = await auth.hydrate();
  assert.equal(snapshot.state, STATES.expired);
  assert.equal(auth.getAccessToken(), null);
});

test("logout clears local credentials even when the remote call fails", async () => {
  const { auth, store } = setup({
    logout: async () => {
      throw new Error("network down");
    },
  });
  await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  const snapshot = await auth.logout();
  assert.equal(snapshot.state, STATES.signedOut);
  assert.equal(auth.getAccessToken(), null);

  const restored = createAuthService({ createApi: () => makeApi(), credentialStore: store, logger: {} });
  assert.equal((await restored.hydrate()).state, STATES.signedOut);
});

test("secure storage being unavailable downgrades to memory instead of plaintext", async () => {
  const { auth, logged } = setup({}, { available: false, reason: "钥匙串不可用" });
  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  assert.equal(result.status, "success");
  assert.equal(result.persisted, false);
  assert.ok(logged.some((line) => line.includes("安全存储不可用")));

  // 换一个进程视角：没有安全存储就恢复不了会话。
  const fresh = createAuthService({
    createApi: () => makeApi(),
    credentialStore: memoryStore({ available: false }),
    logger: {},
  });
  assert.equal((await fresh.hydrate()).state, STATES.signedOut);
});

test("missing user id still logs in but reports no user id", async () => {
  const { auth } = setup({
    fetchUserId: async () => {
      throw new Error("preference unavailable");
    },
  });
  const result = await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  assert.equal(result.status, "success");
  assert.equal(auth.getUserId(), null);
});

test("invalidate marks the session as expired", async () => {
  const { auth } = setup();
  await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  const snapshot = await auth.invalidate();
  assert.equal(snapshot.state, STATES.expired);
  assert.equal(auth.getAccessToken(), null);
});

test("normalizeSession rejects malformed records", () => {
  assert.equal(normalizeSession(null), null);
  assert.equal(normalizeSession({}), null);
  assert.equal(normalizeSession({ accessToken: "" }), null);
  assert.deepEqual(normalizeSession({ accessToken: "t", userId: 7 }).userId, "7");
});

test("China phone accounts request an SMS code", async () => {
  const { auth } = setup({
    region: "china",
    requestEmailCode: async () => ({ codeSent: true, channel: "sms", login: null }),
  });
  const result = await auth.requestEmailCode({ region: "china", account: "13800138000" });
  assert.equal(result.status, "code-sent");
  assert.equal(result.channel, "sms");
  assert.match(result.message, /手机号/);
  assert.equal(auth.state, STATES.awaitingCode);
});

test("China accounts reject email-shaped accounts before calling the API", async () => {
  let called = false;
  const { auth } = setup({
    requestEmailCode: async () => {
      called = true;
      return { codeSent: true, login: null };
    },
  });
  const result = await auth.requestEmailCode({ region: "china", account: "a@b.c" });
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /手机号/);
  assert.equal(called, false);
});

test("global accounts reject phone-shaped accounts before calling the API", async () => {
  let called = false;
  const { auth } = setup({
    requestEmailCode: async () => {
      called = true;
      return { codeSent: true, login: null };
    },
  });
  const result = await auth.requestEmailCode({ region: "global", account: "13800138000" });
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /邮箱/);
  assert.equal(called, false);
});

test("password login also enforces the China phone account rule", async () => {
  const { auth } = setup();
  const result = await auth.loginWithPassword({ region: "china", account: "a@b.c", password: "pw" });
  assert.equal(result.status, "failed");
  assert.match(result.error.message, /手机号/);
  assert.equal(auth.state, STATES.failed);
});

test("China phone numbers are normalized before requesting a code", async () => {
  let sent = "";
  const { auth } = setup({
    region: "china",
    requestEmailCode: async (account) => {
      sent = account;
      return { codeSent: true, channel: "sms", login: null };
    },
  });
  const result = await auth.requestEmailCode({ region: "china", account: "+86 138-0013-8000" });
  assert.equal(result.status, "code-sent");
  assert.equal(sent, "+8613800138000");
});


test("password verification keeps the normalized account and permits a retry", async () => {
  const attempts = [];
  const { auth } = setup({
    region: "china",
    login: async (credentials) => {
      attempts.push(credentials);
      if (credentials.password) throw new CloudApiError(ERROR_KINDS.verificationRequired, "需要验证码");
      if (credentials.code === "wrong") throw new CloudApiError(ERROR_KINDS.verificationInvalid, "验证码错误");
      return { accessToken: "tok", expiresInSeconds: 60 };
    },
  });
  assert.equal((await auth.loginWithPassword({ region: "china", account: "+86 138-0013-8000", password: "pw" })).status, "code-required");
  assert.equal((await auth.submitCode({ code: "" })).status, "failed");
  assert.equal((await auth.submitCode({ code: "wrong" })).status, "failed");
  assert.equal((await auth.submitCode({ code: "right" })).status, "success");
  assert.deepEqual(attempts.slice(1), [
    { account: "+8613800138000", code: "wrong" },
    { account: "+8613800138000", code: "right" },
  ]);
  assert.equal((await auth.submitCode({ code: "again" })).status, "failed");
});

test("transient code errors retain the flow, but terminal errors clear it", async () => {
  let kind = ERROR_KINDS.network;
  const { auth } = setup({ login: async () => { throw new CloudApiError(kind, "失败"); } });
  await auth.requestEmailCode({ region: "global", account: "a@b.c" });
  assert.equal((await auth.submitCode({ code: "123" })).error.kind, ERROR_KINDS.network);
  kind = ERROR_KINDS.twoFactorRequired;
  assert.equal((await auth.submitCode({ code: "123" })).status, "unsupported");
  assert.match((await auth.submitCode({ code: "123" })).error.message, /流程已失效/);
});

test("cancel, logout, invalidate and switching login clear pending verification", async () => {
  for (const action of [
    (auth) => auth.cancelPendingLogin(),
    (auth) => auth.logout(),
    (auth) => auth.invalidate(),
    (auth) => auth.loginWithPassword({ region: "china", account: "bad@email", password: "pw" }),
    (auth) => auth.requestEmailCode({ region: "global", account: "" }),
  ]) {
    const { auth } = setup();
    await auth.requestEmailCode({ region: "global", account: "a@b.c" });
    await action(auth);
    assert.match((await auth.submitCode({ code: "123" })).error.message, /流程已失效/);
  }
});

test("cancelled in-flight requests cannot restore a verification flow or session", async () => {
  let resolveRequest;
  const { auth } = setup({ requestEmailCode: () => new Promise((resolve) => { resolveRequest = resolve; }) });
  const request = auth.requestEmailCode({ region: "global", account: "a@b.c" });
  assert.equal(auth.cancelPendingLogin().state, STATES.signedOut);
  resolveRequest({ codeSent: true });
  assert.equal((await request).status, "cancelled");
  assert.match((await auth.submitCode({ code: "123" })).error.message, /流程已失效/);

  let resolveUser;
  const second = setup({ fetchUserId: () => new Promise((resolve) => { resolveUser = resolve; }) });
  const login = second.auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  await new Promise((resolve) => setImmediate(resolve));
  await second.auth.logout();
  resolveUser("42");
  assert.equal((await login).status, "cancelled");
  assert.equal(second.auth.getAccessToken(), null);
  assert.equal(await second.store.load(), null);
});


test("logout waits for an in-progress credential save before clearing it", async () => {
  let finishSave;
  let stored = null;
  const store = {
    save: (value) => new Promise((resolve) => { finishSave = () => { stored = value; resolve({ persisted: true }); }; }),
    clear: async () => { stored = null; },
    load: async () => stored,
  };
  const auth = createAuthService({ createApi: () => makeApi(), credentialStore: store, logger: {} });
  const login = auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  await new Promise((resolve) => setImmediate(resolve));
  const logout = auth.logout();
  finishSave();
  assert.equal((await login).status, "cancelled");
  assert.equal((await logout).state, STATES.signedOut);
  assert.equal(await store.load(), null);
  assert.equal(auth.snapshot().persisted, false);
});


test("cancelling during credential save discards the new session and stored credentials", async () => {
  let finishSave;
  let stored = null;
  const store = {
    save: (value) => new Promise((resolve) => { finishSave = () => { stored = value; resolve({ persisted: true }); }; }),
    clear: async () => { stored = null; },
    load: async () => stored,
  };
  const auth = createAuthService({ createApi: () => makeApi(), credentialStore: store, logger: {} });
  const login = auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.getAccessToken(), null);
  assert.equal(auth.cancelPendingLogin().state, STATES.signedOut);
  finishSave();
  assert.equal((await login).status, "cancelled");
  assert.equal(auth.getAccessToken(), null);
  assert.equal(auth.snapshot().persisted, false);
  assert.equal(await store.load(), null);
});

test("old logout and invalidate clears cannot erase a newer login", async () => {
  for (const action of ["logout", "invalidate"]) {
    let stored = null;
    let releaseClear;
    let notifyClear;
    const clearStarted = new Promise((resolve) => { notifyClear = resolve; });
    const calls = [];
    const store = {
      async load() { return stored; },
      async save(value) { calls.push("save"); stored = value; return { persisted: true }; },
      async clear() {
        calls.push("clear-start");
        notifyClear();
        await new Promise((resolve) => { releaseClear = resolve; });
        stored = null;
        calls.push("clear-end");
      },
    };
    let sequence = 0;
    const api = makeApi({ login: async () => ({ accessToken: ++sequence === 1 ? "old" : "new" }) });
    const auth = createAuthService({ createApi: () => api, credentialStore: store, logger: {} });
    await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
    const clearing = auth[action]();
    assert.equal(auth.getAccessToken(), null, `${action} clears the local session immediately`);
    await clearStarted;
    const newLogin = auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["save", "clear-start"]);
    releaseClear();
    await clearing;
    assert.equal((await newLogin).status, "success");
    assert.equal(auth.getAccessToken(), "new");
    assert.equal(JSON.parse(stored).session.accessToken, "new");
    assert.deepEqual(calls, ["save", "clear-start", "clear-end", "save"]);
  }
});

test("failed old clear is reported without preventing a later login save", async () => {
  let rejectClear;
  let notifyClear;
  let stored = null;
  const clearStarted = new Promise((resolve) => { notifyClear = resolve; });
  const store = {
    async load() { return stored; },
    async save(value) { stored = value; return { persisted: true }; },
    clear() { notifyClear(); return new Promise((_resolve, reject) => { rejectClear = reject; }); },
  };
  const auth = createAuthService({ createApi: () => makeApi(), credentialStore: store, logger: {} });
  await auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  const clearing = auth.logout();
  await clearStarted;
  const login = auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  rejectClear(new Error("synthetic"));
  await assert.rejects(clearing, /本地凭据删除失败/);
  assert.equal((await login).status, "success");
  assert.equal(auth.getAccessToken(), "tok");
  assert.equal(JSON.parse(stored).session.accessToken, "tok");
});

test("cancelling a replacement login during save restores the previous credentials", async () => {
  const original = JSON.stringify({ session: { accessToken: "old", region: "global" } });
  let stored = original;
  let finishSave;
  let saves = 0;
  const store = {
    save: (value) => {
      saves += 1;
      if (saves === 1) return new Promise((resolve) => { finishSave = () => { stored = value; resolve({ persisted: true }); }; });
      stored = value;
      return Promise.resolve({ persisted: true });
    },
    clear: async () => { stored = null; },
    load: async () => stored,
  };
  const auth = createAuthService({ createApi: () => makeApi(), credentialStore: store, logger: {} });
  await auth.hydrate();
  const login = auth.loginWithPassword({ region: "global", account: "a@b.c", password: "pw" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(auth.cancelPendingLogin().state, STATES.signedIn);
  finishSave();
  assert.equal((await login).status, "cancelled");
  assert.equal(auth.getAccessToken(), "old");
  assert.equal(JSON.parse(await store.load()).session.accessToken, "old");
});
