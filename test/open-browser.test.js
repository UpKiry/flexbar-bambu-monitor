const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { isLocalAdminUrl, browserCommandFor, openBrowser } = require("../src/admin/open-browser");

function fakeChild() {
  const child = new EventEmitter();
  child.unref = () => {};
  return child;
}

test("only loopback admin URLs are accepted", () => {
  assert.equal(isLocalAdminUrl("http://127.0.0.1:1234/#token=abc"), true);
  assert.equal(isLocalAdminUrl("http://127.0.0.1:1234/"), true);
  assert.equal(isLocalAdminUrl("http://127.0.0.1:1234/path"), false);
  assert.equal(isLocalAdminUrl("https://127.0.0.1:1234/#token=abc"), false);
  assert.equal(isLocalAdminUrl("http://192.168.1.2:1234/"), false);
  assert.equal(isLocalAdminUrl("http://127.0.0.1:1234/?next=https://evil"), false);
});

test("browser commands are platform specific and never use a shell", () => {
  const url = "http://127.0.0.1:1234/#token=abc";
  assert.deepEqual(browserCommandFor(url, "darwin"), { command: "open", args: [url] });
  assert.deepEqual(browserCommandFor(url, "win32"), {
    command: "cmd",
    args: ["/c", "start", "", url],
    windowsHide: true,
  });
  assert.deepEqual(browserCommandFor(url, "linux"), { command: "xdg-open", args: [url] });
});

test("openBrowser reports success when the launcher exits with 0", async () => {
  let spawned = null;
  const child = fakeChild();
  const result = await openBrowser("http://127.0.0.1:1234/#token=abc", {
    platform: "darwin",
    spawnFn: (command, args, options) => {
      spawned = { command, args, options };
      setImmediate(() => child.emit("close", 0));
      return child;
    },
  });

  assert.deepEqual(result, { opened: true, reason: "" });
  assert.equal(spawned.command, "open");
  assert.deepEqual(spawned.args, ["http://127.0.0.1:1234/#token=abc"]);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.stdio, "ignore");
});

test("openBrowser reports failure for nonzero exit and spawn errors", async () => {
  const nonzero = await openBrowser("http://127.0.0.1:1234/#token=abc", {
    platform: "darwin",
    spawnFn: () => {
      const child = fakeChild();
      setImmediate(() => child.emit("close", 3));
      return child;
    },
  });
  assert.deepEqual(nonzero, { opened: false, reason: "exit-3" });

  const errored = await openBrowser("http://127.0.0.1:1234/#token=abc", {
    platform: "darwin",
    spawnFn: () => {
      const child = fakeChild();
      setImmediate(() => child.emit("error", new Error("no browser")));
      return child;
    },
  });
  assert.equal(errored.opened, false);
  assert.match(errored.reason, /no browser/);
});

test("openBrowser refuses non-loopback URLs without spawning", async () => {
  let called = false;
  const result = await openBrowser("https://example.com", {
    spawnFn: () => {
      called = true;
      return fakeChild();
    },
  });
  assert.deepEqual(result, { opened: false, reason: "invalid-url" });
  assert.equal(called, false);
});
