/**
 * kintone/ の下を変える前の許可（print-craft-authoring tools 2.0.0 の写し。print-craft-authoring-mcp の実装案 15.5〜15.7）: profile の形のときだけ、
 * 接続のファイルにある profile のフォルダー、印が今の接続のもの、操作 × 場所、ダウンロードのファイルは書き換えない、フォルダーを作れるのは fields と snapshot、
 * 確定の前に接続のファイルを読み直す（connection-changed）。計算式の tools には preview / out/ が無い
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertChangeAllowed, classOfAppPath, PermissionError } from "../src/permission.ts";
import { ConnectionError } from "../src/connections.ts";
import { APP_MARKER, modeOf } from "../src/workspace.ts";
import { CONN, makeConnWorkspace } from "./conn-helper.mjs";

const SNAP = "rex0220-formula-app2305-20261005-125115.json";
const EDIT = SNAP.replace(".json", "-edit.json");

const denied = (fn, re) => assert.throws(fn, (e) => e instanceof PermissionError && re.test(e.message));
const conflict = (fn, code) => assert.throws(fn, (e) => e instanceof ConnectionError && e.code === code);

test("classOfAppPath: アプリのフォルダーの中の場所。. で始まる名前（印）はどの操作でも書けない。out/ は無い", () => {
  assert.equal(classOfAppPath(SNAP), "snapshot");
  assert.equal(classOfAppPath(EDIT), "edit");
  assert.equal(classOfAppPath("新しい設定.json"), "newsettings");
  assert.equal(classOfAppPath("fields.json"), "fields");
  assert.equal(classOfAppPath("records/3.json"), "record");
  assert.equal(classOfAppPath("records/sub/3.json"), "other");
  assert.equal(classOfAppPath("records/x.txt"), "other");
  assert.equal(classOfAppPath("out/x.html"), "other");
  assert.equal(classOfAppPath("sub/a.json"), "other");
  assert.equal(classOfAppPath("a.txt"), "other");
  assert.equal(classOfAppPath(APP_MARKER), "other");
  assert.equal(classOfAppPath(".hidden.json"), "other");
  assert.equal(classOfAppPath("records/.x.json"), "other");
  assert.equal(classOfAppPath("rex0220-print-craft-app1-20261005-125115.json"), "newsettings", "印刷屋のダウンロードの名前はただの json");
});

test("profile の形: 操作ごとに書ける場所だけ。ダウンロード / pull のファイルの書き換えと印は拒否。kintone/ の外は形に依らない", () => {
  const t = makeConnWorkspace();
  try {
    const mode = t.mode();
    const dir = t.appFolder("dev", 2305, "テーブル内集計");
    const f = (n) => path.join(dir, n);
    assertChangeAllowed(t.root, f(EDIT), "settings", mode);
    assertChangeAllowed(t.root, f("新しい設定.json"), "settings", mode);
    assertChangeAllowed(t.root, f("fields.json"), "fields", mode);
    assertChangeAllowed(t.root, f("records/3.json"), "record", mode);
    assertChangeAllowed(t.root, f(SNAP), "snapshot", mode);
    denied(() => assertChangeAllowed(t.root, f("fields.json"), "settings", mode), /この操作でアプリのフォルダーに書けるのは/);
    denied(() => assertChangeAllowed(t.root, f("out/x.html"), "settings", mode), /書けるのは/);
    denied(() => assertChangeAllowed(t.root, f(APP_MARKER), "settings", mode), /書けるのは/);
    denied(() => assertChangeAllowed(t.root, f(APP_MARKER), "fields", mode), /書けるのは/);
    writeFileSync(f(SNAP), "{}");
    denied(() => assertChangeAllowed(t.root, f(SNAP), "snapshot", mode), /ダウンロード \/ pull のファイルは書き換えない/);
    denied(() => assertChangeAllowed(t.root, f(SNAP), "settings", mode), /ダウンロード \/ pull のファイルは書き換えない/);
    assertChangeAllowed(t.root, path.join(t.root, "settings", "a.json"), "settings", mode);
    assertChangeAllowed(t.root, path.join(t.root, "settings", "a.json"), "settings", { kind: "single" });
  } finally {
    t.cleanup();
  }
});

test("1 接続の形・未設定・移行で止まっている形では kintone/ の下をいつも変えない", () => {
  const t = makeConnWorkspace();
  try {
    const file = path.join(t.root, "kintone", "dev", "2305-テーブル内集計", "a.json");
    denied(() => assertChangeAllowed(t.root, file, "settings", { kind: "single" }), /接続のファイルがあるときだけ/);
    denied(() => assertChangeAllowed(t.root, file, "fields", { kind: "not-configured" }), /接続のファイルがあるときだけ/);
    conflict(() => assertChangeAllowed(t.root, file, "fields", { kind: "legacy-blocked" }), "legacy-config-present");
    writeFileSync(path.join(t.root, "environments.json"), "{}");
    assert.equal(modeOf(t.root, { configFile: undefined, workspaceRoots: [t.root], env: {}, surface: "cli" }).kind, "legacy-blocked");
  } finally {
    t.cleanup();
  }
});

test("接続のファイルに無い profile のフォルダー、アプリのフォルダーの外は denied。フォルダーを作れるのは fields と snapshot だけ", () => {
  const t = makeConnWorkspace();
  try {
    const mode = t.mode();
    denied(() => assertChangeAllowed(t.root, path.join(t.root, "kintone", "stage", "2305-x", "a.json"), "settings", mode), /profile「stage」は接続のファイル/);
    denied(() => assertChangeAllowed(t.root, path.join(t.root, "kintone", "x.cybozu.com", "2305-x", "a.json"), "settings", mode), /アプリのフォルダー/);
    denied(() => assertChangeAllowed(t.root, path.join(t.root, "kintone", "dev", "a.json"), "settings", mode), /アプリのフォルダー/);
    const fresh = path.join(t.root, "kintone", "dev", "101-新しい");
    assertChangeAllowed(t.root, path.join(fresh, "fields.json"), "fields", mode);
    assertChangeAllowed(t.root, path.join(fresh, SNAP.replace("2305", "101")), "snapshot", mode);
    for (const [name, op] of [["a.json", "settings"], ["records/3.json", "record"]]) {
      denied(() => assertChangeAllowed(t.root, path.join(fresh, name), op, mode), /アプリのフォルダーが無い/);
    }
  } finally {
    t.cleanup();
  }
});

test("印: 無い・壊れている・別の接続（アプリ・ゲストスペース・接続先）は conflict。印の無いフォルダーは採用しない", () => {
  const t = makeConnWorkspace();
  try {
    const mode = t.mode();
    const bare = path.join(t.root, "kintone", "dev", "2305-テーブル内集計");
    mkdirSync(bare, { recursive: true });
    conflict(() => assertChangeAllowed(t.root, path.join(bare, "a.json"), "settings", mode), "app-marker-missing");
    conflict(() => assertChangeAllowed(t.root, path.join(bare, "fields.json"), "fields", mode), "app-marker-missing");
    writeFileSync(path.join(bare, APP_MARKER), "{ broken");
    conflict(() => assertChangeAllowed(t.root, path.join(bare, "a.json"), "settings", mode), "app-marker-invalid");
    writeFileSync(path.join(bare, APP_MARKER), JSON.stringify({ schemaVersion: 1, profile: "dev", origin: "https://dev-x.cybozu.com", guestSpaceId: null, appId: 101 }));
    conflict(() => assertChangeAllowed(t.root, path.join(bare, "a.json"), "settings", mode), "app-identity-conflict");
    writeFileSync(path.join(bare, APP_MARKER), JSON.stringify({ schemaVersion: 1, profile: "dev", origin: "https://other.cybozu.com", guestSpaceId: null, appId: 2305 }));
    conflict(() => assertChangeAllowed(t.root, path.join(bare, "a.json"), "settings", mode), "app-identity-conflict");
    writeFileSync(path.join(bare, APP_MARKER), JSON.stringify({ schemaVersion: 1, profile: "dev", origin: "https://dev-x.cybozu.com", guestSpaceId: 15, appId: 2305 }));
    conflict(() => assertChangeAllowed(t.root, path.join(bare, "a.json"), "settings", mode), "app-identity-conflict");
    writeFileSync(path.join(bare, APP_MARKER), JSON.stringify({ schemaVersion: 1, profile: "dev", origin: "https://dev-x.cybozu.com", guestSpaceId: null, appId: 2305 }));
    assertChangeAllowed(t.root, path.join(bare, "a.json"), "settings", mode);
  } finally {
    t.cleanup();
  }
});

test("確定の前に接続のファイルを読み直す: 選んだ profile の接続先・トークンが変われば connection-changed。ほかの profile だけの書き換えでは止めない", () => {
  const t = makeConnWorkspace();
  try {
    const mode = t.mode();
    const dir = t.appFolder("dev", 2305, "テーブル内集計");
    const file = path.join(dir, "a.json");
    t.writeConn({ ...CONN, profiles: { ...CONN.profiles, prod: { ...CONN.profiles.prod, baseUrl: "https://y.cybozu.com" } } });
    assertChangeAllowed(t.root, file, "settings", mode);
    t.writeConn({ ...CONN, profiles: { ...CONN.profiles, dev: { ...CONN.profiles.dev, tokenMap: { ...CONN.profiles.dev.tokenMap, APP2305: "rotated" } } } });
    conflict(() => assertChangeAllowed(t.root, file, "settings", mode), "connection-changed");
    t.writeConn({ ...CONN, profiles: { ...CONN.profiles, dev: { ...CONN.profiles.dev, baseUrl: "https://dev-y.cybozu.com" } } });
    conflict(() => assertChangeAllowed(t.root, file, "settings", mode), "connection-changed");
    t.writeConn({ profiles: { prod: CONN.profiles.prod } });
    conflict(() => assertChangeAllowed(t.root, file, "settings", mode), "connection-changed");
    rmSync(t.connFile);
    assert.throws(() => assertChangeAllowed(t.root, file, "settings", mode), (e) => e instanceof ConnectionError && e.code === "unreadable", "読めなければ前の値に戻らない");
  } finally {
    t.cleanup();
  }
});
