import test from "node:test";
import assert from "node:assert/strict";
import { proxyFromEnvironment } from "../src/browser.js";

test("proxyFromEnvironment reads an authenticated HTTPS proxy", () => {
  const proxy = proxyFromEnvironment({
    HTTPS_PROXY: "http://demo:p%40ss@127.0.0.1:7890",
    NO_PROXY: "localhost, 127.0.0.1"
  });
  assert.deepEqual(proxy, {
    server: "http://127.0.0.1:7890",
    username: "demo",
    password: "p@ss",
    bypass: "localhost,127.0.0.1"
  });
});

test("proxyFromEnvironment ignores missing or unsupported proxy values", () => {
  assert.equal(proxyFromEnvironment({}), undefined);
  assert.equal(proxyFromEnvironment({ HTTPS_PROXY: "file:///tmp/proxy" }), undefined);
});
