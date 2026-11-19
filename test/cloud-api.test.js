const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { CloudApi, CloudApiError, ERROR_KINDS, classifyServiceError, request } = require("../src/cloud/cloud-api");

/** 构造一个记录请求并可返回预设响应的假 HTTPS 层。 */
function makeRequester(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fn: async (request) => {
      calls.push(request);
      if (!queue.length) throw new Error("no more canned responses");
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { status: next.status ?? 200, headers: {}, text: JSON.stringify(next.body) };
    },
  };
}

test("device online accepts booleans and preserves missing or invalid values as unknown", async () => {
  const values = [true, false, undefined, null, 0, 1, "true", "false"];
  const requester = makeRequester([{ body: { devices: values.map((online, index) => ({ dev_id: `D${index}`, online })) } }]);
  const api = new CloudApi({ requestFn: requester.fn });
  assert.deepEqual((await api.fetchDevices("tok")).map((device) => device.online),
    [true, false, null, null, null, null, null, null]);
});

test("login returns tokens and never leaks them in the request log", async () => {
  const requester = makeRequester([{ body: { accessToken: "tok", refreshToken: "ref", expiresIn: 7776000, loginType: "" } }]);
  const api = new CloudApi({ region: "global", requestFn: requester.fn });
  const result = await api.login({ account: "a@b.c", password: "pw" });

  assert.equal(result.accessToken, "tok");
  assert.equal(result.refreshToken, "ref");
  assert.equal(result.expiresInSeconds, 7776000);
  assert.equal(requester.calls[0].url, "https://api.bambulab.com/v1/user-service/user/login");
  assert.equal(requester.calls[0].method, "POST");
  assert.deepEqual(requester.calls[0].body, { account: "a@b.c", password: "pw", apiError: "" });
  assert.deepEqual(requester.calls[0].headers, {});
});

test("login requires a verification code when the service asks for one", async () => {
  const requester = makeRequester([{ body: { loginType: "verifyCode" } }]);
  const api = new CloudApi({ region: "china", requestFn: requester.fn });
  await assert.rejects(
    () => api.login({ account: "a@b.c", password: "pw" }),
    (error) => error instanceof CloudApiError && error.kind === ERROR_KINDS.verificationRequired,
  );
});

test("email accounts request an email verification code", async () => {
  const requester = makeRequester([{ body: { code: 0, message: "success" } }]);
  const api = new CloudApi({ region: "global", requestFn: requester.fn });
  const result = await api.requestVerificationCode("a@b.c");

  assert.deepEqual(result, { codeSent: true, channel: "email", login: null });
  assert.equal(requester.calls[0].url, "https://api.bambulab.com/v1/user-service/user/sendemail/code");
  assert.deepEqual(requester.calls[0].body, { email: "a@b.c", type: "codeLogin" });
});

test("phone accounts request a China SMS verification code", async () => {
  const requester = makeRequester([{ body: { code: 0, message: "success" } }]);
  const api = new CloudApi({ region: "china", requestFn: requester.fn });
  const result = await api.requestVerificationCode("13800138000");

  assert.deepEqual(result, { codeSent: true, channel: "sms", login: null });
  assert.equal(requester.calls[0].url, "https://api.bambulab.cn/v1/user-service/user/sendsmscode");
  assert.deepEqual(requester.calls[0].body, { phone: "13800138000", type: "codeLogin" });
});

test("requestEmailCode remains a channel-aware compatibility alias", async () => {
  const requester = makeRequester([{ body: { code: 0 } }]);
  const api = new CloudApi({ region: "global", requestFn: requester.fn });
  const result = await api.requestEmailCode("13800138000");
  assert.equal(result.channel, "sms");
});

test("service errors are classified for the UI", () => {
  assert.equal(classifyServiceError(400, { code: 1, error: "Incorrect account or password." }), ERROR_KINDS.invalidCredentials);
  assert.equal(classifyServiceError(401, { code: 4, error: "Please login.", message: "" }), ERROR_KINDS.unauthorized);
  assert.equal(classifyServiceError(429, {}), ERROR_KINDS.rateLimited);
  assert.equal(classifyServiceError(400, { error: "Verification code expired" }), ERROR_KINDS.verificationInvalid);
  assert.equal(classifyServiceError(400, { error: "Two-factor authentication required" }), ERROR_KINDS.twoFactorRequired);
  assert.equal(classifyServiceError(400, { code: 1, error: "Enter a valid phone number." }), ERROR_KINDS.invalidPhone);
  assert.equal(classifyServiceError(500, {}), ERROR_KINDS.unknown);
});

test("invalid credentials surface as a user readable message", async () => {
  const requester = makeRequester([{ status: 400, body: { code: 1, error: "Incorrect account or password." } }]);
  const api = new CloudApi({ region: "global", requestFn: requester.fn });
  await assert.rejects(
    () => api.login({ account: "a@b.c", password: "bad" }),
    (error) => error.kind === ERROR_KINDS.invalidCredentials && error.message === "账号或密码错误",
  );
});

test("server errors and transport exceptions never expose echoed credentials", async () => {
  const secret = "FAKE-token-password-code-928374";
  const events = [];
  const api = new CloudApi({
    requestFn: makeRequester([
      { body: { accessToken: secret } },
      { status: 500, body: { message: secret, code: secret } },
      { status: 500, body: { error: secret, code: secret } },
      new CloudApiError(ERROR_KINDS.network, secret, { cause: new Error(secret), code: secret }),
    ]).fn,
    onRequest: (event) => events.push(event),
  });
  const login = await api.login({ account: "a@b.c", password: secret });
  assert.equal(login.accessToken, secret);
  for (const operation of [() => api.fetchUserId(secret), () => api.fetchDevices(secret), () => api.fetchDevices(secret)]) {
    await assert.rejects(operation, (error) => {
      assert.ok(!String(error.stack).includes(secret));
      assert.ok(!JSON.stringify(error).includes(secret));
      assert.equal(error.cause, null);
      return true;
    });
  }
  assert.ok(!JSON.stringify(events).includes(secret));
});

test("network and timeout errors are classified", async () => {
  const networkError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const api = new CloudApi({ region: "global", requestFn: makeRequester([networkError]).fn });
  await assert.rejects(
    () => api.fetchDevices("tok"),
    (error) => error.kind === ERROR_KINDS.network,
  );

  const timeoutError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  const api2 = new CloudApi({ region: "global", requestFn: makeRequester([timeoutError]).fn });
  await assert.rejects(
    () => api2.fetchDevices("tok"),
    (error) => error.kind === ERROR_KINDS.timeout,
  );
});

test("fetchDevices strips access codes and keeps only needed fields", async () => {
  const requester = makeRequester([
    {
      body: {
        message: "success",
        devices: [
          {
            dev_id: "DEV1",
            name: "X1-01",
            online: true,
            print_status: "SUCCESS",
            dev_model_name: "BL-P001",
            dev_product_name: "X1 Carbon",
            dev_access_code: "1234abcd",
            nozzle_diameter: "0.4",
          },
          { name: "missing id" },
        ],
      },
    },
  ]);
  const api = new CloudApi({ region: "global", requestFn: requester.fn });
  const devices = await api.fetchDevices("tok");
  assert.equal(devices.length, 1);
  assert.deepEqual(devices[0], {
    id: "DEV1",
    name: "X1-01",
    model: "X1 Carbon",
    online: true,
    printStatus: "SUCCESS",
    nozzleDiameter: "0.4",
  });
  assert.ok(!JSON.stringify(devices).includes("1234abcd"));
  assert.equal(requester.calls[0].headers.authorization, "Bearer tok");
});

test("fetchDevices rejects malformed payloads instead of reporting zero devices", async () => {
  const api = new CloudApi({ region: "global", requestFn: makeRequester([{ body: { message: "success" } }]).fn });
  await assert.rejects(
    () => api.fetchDevices("tok"),
    (error) => error.kind === ERROR_KINDS.deviceListUnavailable,
  );
});

test("fetchUserId accepts numbers and numeric strings only", async () => {
  const numeric = new CloudApi({ region: "global", requestFn: makeRequester([{ body: { uid: 12345 } }]).fn });
  assert.equal(await numeric.fetchUserId("tok"), "12345");

  const stringy = new CloudApi({ region: "global", requestFn: makeRequester([{ body: { uid: "6789" } }]).fn });
  assert.equal(await stringy.fetchUserId("tok"), "6789");

  const bad = new CloudApi({ region: "global", requestFn: makeRequester([{ body: { uid: "abc" } }]).fn });
  await assert.rejects(() => bad.fetchUserId("tok"), /用户标识/);
});

test("request trace records no headers, bodies or tokens", async () => {
  const requester = makeRequester([{ body: { message: "success", devices: [] } }]);
  const events = [];
  const api = new CloudApi({
    region: "global",
    requestFn: requester.fn,
    onRequest: (event) => events.push(event),
  });
  await api.fetchDevices("super-secret-token");

  assert.equal(events.length, 1);
  assert.deepEqual(Object.keys(events[0]).sort(), ["durationMs", "kind", "method", "path", "status"]);
  assert.equal(events[0].method, "GET");
  assert.equal(events[0].path, "/v1/iot-service/api/user/bind");
  assert.equal(events[0].status, 200);
  assert.equal(events[0].kind, null);
  assert.ok(Number.isFinite(events[0].durationMs));
  assert.ok(!JSON.stringify(events[0]).includes("super-secret-token"));
});

test("request trace records the classified error kind without response details", async () => {
  const requester = makeRequester([{ status: 401, body: { code: 4, error: "Please login." } }]);
  const events = [];
  const api = new CloudApi({
    region: "global",
    requestFn: requester.fn,
    onRequest: (event) => events.push(event),
  });
  await assert.rejects(() => api.fetchDevices("tok"), (error) => error.kind === ERROR_KINDS.unauthorized);

  assert.equal(events.length, 1);
  assert.equal(events[0].status, 401);
  assert.equal(events[0].kind, ERROR_KINDS.unauthorized);
  assert.ok(!JSON.stringify(events[0]).includes("Bearer"));
});

test("code login submits only account and code", async () => {
  const requester = makeRequester([{ body: { accessToken: "tok" } }]);
  const api = new CloudApi({ region: "china", requestFn: requester.fn });
  await api.login({ account: "13800138000", code: "123456" });
  assert.deepEqual(requester.calls[0].body, { account: "13800138000", code: "123456" });
});

// 保留真实请求封装和可读流，只控制 HTTPS 事件及字节传输。
function controlledTransport() {
  const req = new EventEmitter();
  req.write = () => {};
  req.end = () => {};
  req.destroy = () => { req.destroyed = true; };
  const res = new PassThrough();
  res.statusCode = 200;
  res.headers = {};
  let respond;
  let options;
  return {
    req,
    res,
    get options() { return options; },
    requestFn: (requestOptions, callback) => {
      options = requestOptions;
      respond = callback;
      return req;
    },
    respond: () => respond(res),
  };
}

function transportRequest(transport, timeoutMs = 1000) {
  return request({ url: "https://example.test/path", timeoutMs, httpsRequest: transport.requestFn });
}

function rejectsKind(promise, kind) {
  return assert.rejects(promise, (error) => error instanceof CloudApiError && error.kind === kind);
}

test("transport accepts a complete response at the 1 MiB boundary", async () => {
  const transport = controlledTransport();
  const pending = transportRequest(transport);
  assert.equal(transport.options.rejectUnauthorized, undefined);
  transport.respond();
  transport.res.end(Buffer.alloc(1024 * 1024, 97));
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(Buffer.byteLength(response.text), 1024 * 1024);
});

test("transport rejects more than 1 MiB across chunks and destroys the request", async () => {
  const transport = controlledTransport();
  const pending = transportRequest(transport);
  transport.respond();
  transport.res.write(Buffer.alloc(1024 * 1024));
  transport.res.write(Buffer.alloc(1));
  await rejectsKind(pending, ERROR_KINDS.network);
  assert.equal(transport.req.destroyed, true);
  assert.equal(transport.res.destroyed, true);
});

test("transport maps aborted, errored and prematurely closed responses", async (t) => {
  for (const event of ["aborted", "error", "close"]) {
    await t.test(event, async () => {
      const transport = controlledTransport();
      const pending = transportRequest(transport);
      transport.respond();
      transport.res.write("partial");
      transport.res.emit(event, ...(event === "error" ? [new Error("stream failure")] : []));
      await rejectsKind(pending, ERROR_KINDS.network);
      assert.equal(transport.req.destroyed, true);
    });
  }
});

test("transport maps request errors and socket timeout", async (t) => {
  for (const [event, error, kind] of [
    ["error", Object.assign(new Error("reset"), { code: "ECONNRESET" }), ERROR_KINDS.network],
    ["error", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), ERROR_KINDS.timeout],
    ["timeout", undefined, ERROR_KINDS.timeout],
  ]) {
    await t.test(`${event} ${kind}`, async () => {
      const transport = controlledTransport();
      const pending = transportRequest(transport);
      transport.req.emit(event, error);
      await rejectsKind(pending, kind);
      assert.equal(transport.req.destroyed, true);
    });
  }
});

test("total deadline applies before headers and while data keeps arriving", async (t) => {
  await t.test("before headers", async () => {
    const transport = controlledTransport();
    await rejectsKind(transportRequest(transport, 40), ERROR_KINDS.timeout);
    assert.equal(transport.req.destroyed, true);
  });
  await t.test("while receiving data", async () => {
    const transport = controlledTransport();
    const pending = transportRequest(transport, 80);
    transport.respond();
    const interval = setInterval(() => transport.res.write("x"), 10);
    try {
      await rejectsKind(pending, ERROR_KINDS.timeout);
      assert.equal(transport.req.destroyed, true);
      assert.equal(transport.res.destroyed, true);
    } finally {
      clearInterval(interval);
    }
  });
});
