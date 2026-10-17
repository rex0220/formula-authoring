/**
 * User API（users --pull）の認証と呼び出し（工程 1 の後半）: cybozu.com 共通管理の API トークン（Authorization: Bearer）は User API だけ、
 * ログインユーザーはどちらにも、アプリの API トークンは kintone だけ。codes[] の付け方。接続のファイルの userApiToken。.env の FORMULA_USER_API_TOKEN
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALLOWED_USER_APIS, NotAllowedError, createRestClient, setQuery } from "../src/kintone-rest.ts";
import { ConnectionError, loadConnections, pickProfile, userApiAuthFor } from "../src/connections.ts";
import { AuthError, describeAuth, loadUserApiAuth } from "../src/env.ts";

function fakeFetch(body = '{"users":[]}') {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    let done = false;
    return {
      ok: true, status: 200, headers: { get: () => null },
      body: { getReader: () => ({ async read() { if (done) return { done: true }; done = true; return { done: false, value: new TextEncoder().encode(body) }; }, async cancel() {} }) }
    };
  };
  return { calls, fetchImpl };
}

test("setQuery: 配列は codes[0]=a&codes[1]=b、undefined は付けない", () => {
  const url = new URL("https://x.cybozu.com/v1/users.json");
  setQuery(url, { codes: ["a", "b"], size: 100, skip: undefined, ok: true });
  assert.equal(url.search, "?codes%5B0%5D=a&codes%5B1%5D=b&size=100&ok=true");
});

test("認証ヘッダー: Bearer は User API だけ（kintone の API は止める）、ログインユーザーは両方、アプリの API トークンは kintone だけ", async () => {
  const bearer = fakeFetch();
  const cb = createRestClient({ baseUrl: "https://x.cybozu.com", bearer: "cy.s.api1.tok" }, bearer.fetchImpl);
  await cb.getUser("users", { codes: ["a"], size: 100 });
  assert.equal(bearer.calls[0].url, "https://x.cybozu.com/v1/users.json?codes%5B0%5D=a&size=100");
  assert.equal(bearer.calls[0].headers.Authorization, "Bearer cy.s.api1.tok");
  assert.equal(bearer.calls[0].headers["X-Cybozu-API-Token"], undefined);
  await assert.rejects(cb.get("app", { id: 1 }), (e) => e instanceof NotAllowedError && /User API（users --pull）だけに使う/.test(e.message));
  assert.equal(bearer.calls.length, 1, "止めたときは送らない");

  const up = fakeFetch();
  const cu = createRestClient({ baseUrl: "https://x.cybozu.com", username: "u", password: "p" }, up.fetchImpl);
  await cu.getUser("user/organizations", { code: "u1" });
  assert.equal(up.calls[0].url, "https://x.cybozu.com/v1/user/organizations.json?code=u1");
  assert.equal(up.calls[0].headers["X-Cybozu-Authorization"], Buffer.from("u:p").toString("base64"));
  await cu.get("app", { id: 1 });
  assert.equal(up.calls[1].headers["X-Cybozu-Authorization"], Buffer.from("u:p").toString("base64"));

  const tk = fakeFetch();
  const ct = createRestClient({ baseUrl: "https://x.cybozu.com", token: "app-token" }, tk.fetchImpl);
  await ct.get("app", { id: 1 });
  assert.equal(tk.calls[0].headers["X-Cybozu-API-Token"], "app-token");
  await assert.rejects(ct.getUser("users", {}), (e) => e instanceof NotAllowedError && /アプリの API トークンでは呼べない/.test(e.message));
  await assert.rejects(ct.getUser("nope", {}), NotAllowedError);
  assert.deepEqual([...ALLOWED_USER_APIS], ["users", "organizations", "groups", "organization/users", "group/users", "user/organizations", "user/groups"]);
});

test("接続のファイルの userApiToken（計算式の tools の拡張）: env: か値。User API の認証は userApiToken → username / password。アプリのトークンだけなら no-user-api-auth。壊れた値はその profile だけ使えない", () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "formula-uat-")));
  try {
    const file = path.join(dir, "connections.json");
    writeFileSync(file, JSON.stringify({
      profiles: {
        a: { baseUrl: "https://a.cybozu.com", tokenMap: { APP1: "t" }, userApiToken: "env:FORMULA_UAT" },
        b: { baseUrl: "https://a.cybozu.com", username: "u", password: "p" },
        c: { baseUrl: "https://a.cybozu.com", tokenMap: { APP1: "t" } },
        d: { baseUrl: "https://a.cybozu.com", userApiToken: "" },
        e: { baseUrl: "https://a.cybozu.com", userApiToken: "env:bad name" },
        f: { baseUrl: "https://a.cybozu.com", username: "u", password: "p", userApiToken: "cy.s.api1.inline" },
        g: { baseUrl: "https://a.cybozu.com", userApiToken: "env:FORMULA_MISSING" }
      }
    }), { mode: 0o600 });
    const set = loadConnections(file, { workspaceRoots: [], env: { FORMULA_UAT: "cy.s.api1.fromenv" } });
    assert.deepEqual(set.invalid.map((i) => i.name).sort(), ["d", "e"]);
    assert.equal(pickProfile(set, "a").userApiTokenReady, true);
    assert.equal(pickProfile(set, "g").userApiTokenReady, false);
    assert.equal(pickProfile(set, "b").userApiTokenReady, false);
    assert.deepEqual(userApiAuthFor(set, pickProfile(set, "a")), { baseUrl: "https://a.cybozu.com", bearer: "cy.s.api1.fromenv" });
    assert.deepEqual(userApiAuthFor(set, pickProfile(set, "b")), { baseUrl: "https://a.cybozu.com", username: "u", password: "p" });
    assert.deepEqual(userApiAuthFor(set, pickProfile(set, "f")), { baseUrl: "https://a.cybozu.com", bearer: "cy.s.api1.inline" }, "userApiToken が先");
    assert.throws(() => userApiAuthFor(set, pickProfile(set, "c")), (e) => e instanceof ConnectionError && e.code === "no-user-api-auth");
    assert.throws(() => userApiAuthFor(set, pickProfile(set, "g")), (e) => e instanceof ConnectionError && e.code === "env-missing");
    assert.ok(!JSON.stringify(set).includes("cy.s.api1"), "ConnectionSet に秘密の値を持たない");
    if (process.platform !== "win32") {
      // 直接書いた userApiToken は権限の警告に数える
      const open = path.join(dir, "open.json");
      writeFileSync(open, JSON.stringify({ profiles: { f: { baseUrl: "https://a.cybozu.com", userApiToken: "cy.s.api1.inline" } } }), { mode: 0o644 });
      assert.equal(loadConnections(open, { workspaceRoots: [], env: {} }).warnings.length, 1);
      const envOnly = path.join(dir, "envonly.json");
      writeFileSync(envOnly, JSON.stringify({ profiles: { a: { baseUrl: "https://a.cybozu.com", userApiToken: "env:X" } } }), { mode: 0o644 });
      assert.equal(loadConnections(envOnly, { workspaceRoots: [], env: {} }).warnings.length, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("1 接続の形の User API の認証: FORMULA_USER_API_TOKEN → KINTONE_USERNAME / KINTONE_PASSWORD。アプリのトークンだけなら誤り。describeAuth", () => {
  const cwd = realpathSync(mkdtempSync(path.join(os.tmpdir(), "formula-uat-env-")));
  try {
    const base = { KINTONE_BASE_URL: "https://x.cybozu.com" };
    assert.deepEqual(loadUserApiAuth({ cwd, env: { ...base, FORMULA_USER_API_TOKEN: "cy.s.api1.t", KINTONE_USERNAME: "u", KINTONE_PASSWORD: "p" } }), { baseUrl: "https://x.cybozu.com", bearer: "cy.s.api1.t" });
    assert.deepEqual(loadUserApiAuth({ cwd, env: { ...base, KINTONE_USERNAME: "u", KINTONE_PASSWORD: "p", KINTONE_API_TOKEN: "app" } }), { baseUrl: "https://x.cybozu.com", username: "u", password: "p" });
    assert.throws(() => loadUserApiAuth({ cwd, env: { ...base, KINTONE_API_TOKEN: "app" } }), (e) => e instanceof AuthError && /FORMULA_USER_API_TOKEN/.test(e.message));
    assert.throws(() => loadUserApiAuth({ cwd, env: {} }), (e) => e instanceof AuthError && /KINTONE_BASE_URL/.test(e.message));
    writeFileSync(path.join(cwd, ".env"), "KINTONE_BASE_URL=https://y.cybozu.com\nFORMULA_USER_API_TOKEN=\"cy.s.api1.file\"\n");
    assert.deepEqual(loadUserApiAuth({ cwd, env: {} }), { baseUrl: "https://y.cybozu.com", bearer: "cy.s.api1.file" });
    assert.equal(describeAuth({ baseUrl: "x", bearer: "t" }), "cybozu.com 共通の API トークン");
    assert.equal(describeAuth({ baseUrl: "x", token: "t" }), "API トークン");
    assert.equal(describeAuth({ baseUrl: "x", username: "u", password: "p" }), "ログインユーザー");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
