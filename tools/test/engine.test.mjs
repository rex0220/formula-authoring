/**
 * 計算式プラグインの zip（fixture: formula の dist の Ver.101）から計算式エンジンと authoring API を読み、工程 0 の spike と同じ結果を出すこと。
 * Node 22.6 以上（型の除去で src/*.ts を直接読む）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadEngine, PLUGIN_ZIP, SENTINEL_USER } from "./helpers.mjs";
import { FORMULA_PLUGIN_ID } from "../src/meta.ts";

const READY = existsSync(PLUGIN_ZIP);
const skip = READY ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;

const pp = { 金額: { code: "金額", type: "NUMBER" }, 合計: { code: "合計", type: "NUMBER" }, 承認: { code: "承認", type: "SINGLE_LINE_TEXT" }, 顧客: { code: "顧客", type: "SINGLE_LINE_TEXT", lookup: {} } };
const rec = () => ({ 金額: { type: "NUMBER", value: "21" }, 合計: { type: "NUMBER", value: "" }, 承認: { type: "SINGLE_LINE_TEXT", value: "" }, 顧客: { type: "SINGLE_LINE_TEXT", value: "" } });
const dq = (kf, expr) => { kf.usedFields({}); return kf.dq(expr); };

test("zip を読む: プラグイン ID、版、API の版、関数の数、SHA-256", { skip }, async () => {
  const engine = await loadEngine();
  assert.equal(engine.source.pluginId, FORMULA_PLUGIN_ID);
  assert.ok(Number(engine.source.pluginVersion) >= 101);
  assert.equal(engine.api.apiVersion, 1);
  assert.equal(engine.api.pluginVersion, engine.source.pluginVersion);
  assert.ok(engine.functionNames().length >= 250);
  assert.match(engine.source.engineSha256, /^[0-9a-f]{64}$/);
  assert.ok(engine.source.decimalSha256, "rex0220_decimal を読んだ");
  assert.deepEqual(engine.warnings, []);
  assert.ok(engine.api.FUNCTION_TAGS.sideEffect.includes("FSET"));
});

test("ダミー層: 既定の context（番兵、アプリ 1、既定のテストデータ 10 人）と setContext 後の新しい runner", { skip }, async () => {
  const engine = await loadEngine();
  const c = engine.context();
  assert.equal(c.loginUser, null);
  assert.equal(c.usersOrigin.kind, "default");
  assert.equal(c.usersInfo.users.length, 10);
  const kf0 = engine.runner(pp, rec(), "app.record.edit.show");
  assert.equal(dq(kf0, "LOGIN_CODE()"), SENTINEL_USER.code, "指定が無ければ番兵");
  engine.setContext({ appId: 123, loginUser: { id: "10", code: "authoring", name: "架空 オーサリング", email: "authoring@example.com", timezone: "Asia/Tokyo", language: "ja" }, lookupTargets: { 顧客: 77 } });
  const kf = engine.runner(pp, rec(), "app.record.edit.show");
  assert.equal(dq(kf, "LOGIN_CODE()"), "authoring");
  assert.equal(dq(kf, "EV_INFO(\"appId\")"), 123);
  assert.deepEqual(dq(kf, 'UINFO(LOGIN_CODE(), "#boss")'), ["demo_user03"], "カスタマイズ項目 boss");
  assert.deepEqual(dq(kf, 'UINFO(UINFO(LOGIN_CODE(), "#boss"), "name")'), ["架空 開発部長"]);
  assert.deepEqual(dq(kf, 'OUSERS("demo_dev1")'), ["demo_user06", "demo_user07", "authoring"]);
  assert.equal(dq(kf, "UINFO()").length, 10, "引数なしの UINFO は全ユーザー");
  assert.equal(dq(kf, "LOOKUP_GETID(顧客)"), 77);
  assert.equal(dq(kf, "LOOKUP_GETID(金額)"), "", "ルックアップ先が無い項目は空");
  assert.equal(dq(kf, 'APP_URL("/k/1/")'), "https://example.cybozu.com/k/1/");
  // LOGIN_* は呼ぶたびに kintone.getLoginUser() を読み、evInfo（appId / lan / mobile / guestUser）はエンジンのモジュール変数でコンストラクターごとに上書きされる
  // （インスタンスに閉じていない）。context を変えたら新しい runner を作り、1 つの runner を使っている間に別の runner を作らない
  assert.equal(dq(kf0, "LOGIN_CODE()"), "authoring", "前の runner も新しいログインユーザーを読む（呼ぶたびに読むため）");
  engine.setContext({ loginUser: null, appId: 1, lookupTargets: {} });
});

test("runner の event（プロセス管理）と calcRecord の errors、dq の回数、sink の記録", { skip }, async () => {
  const engine = await loadEngine();
  const fields = [
    { fieldcode: "合計", formula: "金額*2", fieldno: 1, tableno: 0, tablepos: 0 },
    { fieldcode: "承認", formula: 'EV_INFO("action") & "/" & EV_INFO("status") & "/" & EV_INFO("nextStatus")', fieldno: 2, tableno: 0, tablepos: 0 }
  ];
  const before = engine.dqCount();
  const r = engine.api.calcRecord(fields, pp, rec(), { maxTableRows: 100, evType: "app.record.detail.process.proceed", event: { action: { value: "承認する" }, status: { value: "未処理" }, nextStatus: { value: "承認済" } } });
  assert.equal(r.after.合計.value, "42");
  assert.equal(r.after.承認.value, "承認する/未処理/承認済");
  assert.deepEqual(r.errors, []);
  assert.ok(engine.dqCount() > before, "dq の回数が増える");
  const bad = engine.api.calcRecord([{ fieldcode: "合計", formula: "UNKNOWN_FN(1)", fieldno: 1, tableno: 0, tablepos: 0 }], pp, rec(), { maxTableRows: 100, evType: "allUpdate" });
  assert.deepEqual(bad.errors.map((e) => [e.fieldcode, e.phase]), [["合計", "top"], ["合計", "2nd"]]);
  assert.match(bad.errors[0].message, /UNKNOWN_FN/);
  engine.clearSinkCalls();
  const kf = engine.runner(pp, rec(), "app.record.edit.show");
  dq(kf, 'CLIPBORD_WRITE("x")');
  assert.deepEqual(engine.sinkCalls().map((s) => s.sink), ["clipboard.writeText"], "clipboard は呼ばれたことを記録する（エンジンは例外を握る）");
  engine.clearSinkCalls();
});

test("同じプロセスで別の zip を渡すと zip-changed", { skip }, async () => {
  await loadEngine();
  await assert.rejects(loadEngine({ pluginZip: PLUGIN_ZIP + ".other" }), (e) => e.code === "zip-changed" || e.code === "missing");
});
