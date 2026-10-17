/**
 * normalize と calc を本物の zip（formula の dist の Ver.101）と fixture（Takashi のテスト用アプリ 2305）で確かめる
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import { normalizeSettings } from "../src/commands/normalize.ts";
import { calcSettings, validateEvent } from "../src/commands/calc.ts";
import { defaultUsersInfo } from "../src/users/index.ts";
import { parsePolicy } from "../src/normalize/policy.ts";
import { EXPORT, FIELDS_FILE } from "./fixtures.mjs";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const rules = (res, level) => res.findings.items.filter((f) => f.level === level).map((f) => f.rule);
const run = async (settings, opt = {}) => {
  const engine = await loadEngine();
  return normalizeSettings({ settingsText: JSON.stringify(settings), settingsFile: "settings/t.json", fields: FIELDS_FILE(), engine, usersInfo: defaultUsersInfo(), now: () => new Date("2026-10-17T00:00:00Z"), ...opt });
};
/** 元の値だけの設定（AI が書く形） */
const sourceOnly = () => {
  const e = EXPORT();
  const keep = ["pluginEnable", "pluginProductEnv", "toolEnable", "pluginComment", "pluginDescription", "pluginBtnInfo", "pluginListInfo", "authority", "pluginMiscInfo"];
  const body = Object.fromEntries(keep.map((k) => [k, e[k]]));
  body.pluginInfos = e.pluginInfos.map((r) => ({ fieldcode: r.fieldcode, state: r.state, formulaSet: r.formulaSet, edit: r.edit, hide: r.hide, rank: r.rank }));
  return { date: e.date, pluginName: e.pluginName, pluginID: e.pluginID, PluginVersion: "101", appId: e.appId, appName: e.appName, ...body };
};

test("normalize: Ver.100 のダウンロード（画面のキー・派生値つき）がエラー 0 で通り、既定値を補った封筒を出す。走査の前に dq を呼ばない", { skip }, async () => {
  const engine = await loadEngine();
  const before = engine.dqCount();
  const res = await run(EXPORT(), { check: true });
  assert.equal(res.findings.count("error"), 0, res.summary);
  assert.ok(rules(res, "info").includes("envelope.version"), "Ver.100 の設定");
  assert.ok(rules(res, "info").includes("schema.screen-keys"), "画面の行のキー（ダウンロードは派生値を含まない）");
  assert.ok(rules(res, "warning").includes("misc.changed"), "circular_refer ON / userInfo OFF");
  assert.ok(res.output && res.saved);
  assert.equal(res.output.PluginVersion, engine.source.pluginVersion);
  assert.equal(res.output.pluginID, "rex0220 formula plugin");
  assert.deepEqual(Object.keys(res.output).filter((k) => ["pluginFields", "pluginPP", "tableTrigger"].includes(k)), [], "派生値は出さない");
  assert.ok(res.saved.pluginFields.length >= 6);
  assert.ok(res.size.bytes > 0);
  assert.deepEqual(res.checkDiffs, [], "--check: 入力（元の値）と出力の差 0");
  assert.ok(engine.dqCount() > before, "検証で dq を呼ぶ");
});

test("normalize: 知らないキー、無い項目、無い関数、副作用、EV_SET、rank、別アプリ、新しい版", { skip }, async () => {
  const s = sourceOnly();
  s.extra = 1;
  s.pluginInfos[0].foo = 1;
  s.pluginInfos.push({ fieldcode: "無い項目", state: true, formulaSet: "1", edit: false, hide: false, rank: "" });
  s.pluginInfos[1].rank = 1.5;
  s.PluginVersion = "999";
  s.appId = 1;
  const res = await run(s);
  const errs = rules(res, "error");
  for (const r of ["schema.unknown-key", "rank.range", "envelope.version", "envelope.app"]) assert.ok(errs.includes(r), `${r}: ${res.summary}`);
  assert.ok(!errs.includes("field.missing"), "生 JSON の段階で止まる（行の検査は次）");
  const s2 = sourceOnly();
  s2.pluginInfos.push({ fieldcode: "無い項目", state: true, formulaSet: "1", edit: false, hide: false, rank: "" });
  s2.pluginInfos[0].formulaSet = 'NOSUCHFN(1) + FSET(金額合計, 1) + LET(w, EV_SET("lan", "en"), 1) + RAND()';
  const res2 = await run(s2);
  const errs2 = rules(res2, "error");
  for (const r of ["field.missing", "formula.unknown-function", "formula.side-effect", "event.set"]) assert.ok(errs2.includes(r), `${r}: ${res2.summary}`);
  assert.ok(rules(res2, "warning").includes("formula.volatile"));
  assert.equal(res2.output, undefined);
});

test("normalize: policy で FSET を承認すると評価する。検証の誤り（無い項目の参照）は formula.ref", { skip }, async () => {
  const s = sourceOnly();
  s.pluginInfos[0].formulaSet = "FSET(金額合計, 1)";
  const policy = parsePolicy('{"allowFunctions":["FSET"],"allowMiscChanges":true}', "policy");
  const res = await run(s, { policy });
  assert.equal(res.findings.count("error"), 0, res.summary);
  assert.ok(rules(res, "warning").includes("formula.side-effect"));
  assert.ok(rules(res, "info").includes("misc.changed"));
  const s2 = sourceOnly();
  s2.pluginInfos[0].formulaSet = "存在しない項目 + 1";
  const res2 = await run(s2);
  assert.ok(rules(res2, "error").includes("formula.ref"), res2.summary);
});

test("calc: テスト用アプリの設定を 1 レコードに当てる（No と 金額。更新しない。文脈と印）", { skip }, async () => {
  const engine = await loadEngine();
  const res = await run(sourceOnly());
  assert.equal(res.findings.count("error"), 0, res.summary);
  const row = (no, 分類, 数量, 単価) => ({ value: { No: { type: "NUMBER", value: no }, 商品: { type: "SINGLE_LINE_TEXT", value: "品" }, 分類: { type: "DROP_DOWN", value: 分類 }, 数量: { type: "NUMBER", value: 数量 }, 単価: { type: "NUMBER", value: 単価 }, 金額: { type: "NUMBER", value: "" } } });
  const record = { $id: { type: "RECORD_NUMBER", value: "1" }, 商品セット: { type: "CHECK_BOX", value: [] }, 金額合計: { type: "NUMBER", value: "" }, テーブル: { type: "SUBTABLE", value: [row("", "明細", "2", "100"), row("", "明細", "1", "50"), row("", "小計", "", "")] } };
  const r = calcSettings({ normalized: res, engine, fields: FIELDS_FILE(), appId: 2305, records: [{ id: "1", record }], usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" } });
  assert.match(r.notice, /更新していません（模擬）/);
  assert.match(r.contextLine, /イベント allUpdate/);
  const rec = r.records[0];
  assert.equal(rec.errors.length, 0, JSON.stringify(rec.errors));
  const table = rec.lines.find((l) => l.fieldcode === "テーブル");
  assert.ok(table && table.changed);
  const rows = table.after;
  assert.deepEqual(rows.map((x) => x.value.No.value), ["1", "2", "3"], "No = ROWNO+1");
  assert.equal(rows[0].value.金額.value, "200", "明細の金額 = 数量×単価");
  assert.equal(record.テーブル.value[0].value.金額.value, "", "入力のレコードは書き換えない");
  // テーブル自身の計算式（行数の制御）で行が足されたときは、入力の行数（0）からの差と、足された行の値を出す（4 回目の試用の出張管理で見つけた）
  const s5 = sourceOnly();
  s5.pluginInfos = [...s5.pluginInfos.filter((p) => p.fieldcode !== "テーブル"), { fieldcode: "テーブル", state: true, formulaSet: "3", edit: false, hide: false, rank: "" }];
  const res5 = await run(s5);
  assert.equal(res5.findings.count("error"), 0, res5.summary);
  const empty = { $id: { type: "RECORD_NUMBER", value: "9" }, 商品セット: { type: "CHECK_BOX", value: [] }, 金額合計: { type: "NUMBER", value: "" }, テーブル: { type: "SUBTABLE", value: [] } };
  const r5 = calcSettings({ normalized: res5, engine, fields: FIELDS_FILE(), appId: 2305, records: [{ id: "9", record: empty }], usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" } });
  const t5 = r5.records[0].lines.find((l) => l.fieldcode === "テーブル");
  assert.ok(t5 && t5.changed && t5.before.length === 0 && t5.after.length === 3, "0 行 → 3 行");
  assert.match(r5.text, /テーブル: テーブル 0 行 → 3 行/);
  assert.match(r5.text, /行 1（追加）: .*No "1"/);
  const { evType, event } = validateEvent("app.record.detail.process.proceed", { action: { value: "承認" } });
  assert.equal(evType, "app.record.detail.process.proceed");
  assert.equal(event.action.value, "承認");
  assert.throws(() => validateEvent("app.record.edit", undefined), /種別が違う/);
  assert.throws(() => calcSettings({ normalized: res, engine, fields: FIELDS_FILE(), appId: 2305, records: [{ id: "1", record }], user: "居ない人", usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" } }), /居ない/);
});

test("normalize: 入れ子の未知のキー、rank の範囲、計算式ツール無効、文脈の要求（LOOKUP_GETID / APP_URL / LOGIN）", { skip }, async () => {
  const s = sourceOnly();
  s.pluginMiscInfo.typo = true;
  s.pluginInfos[0].rank = 10001;
  s.toolEnable = false;
  const res = await run(s);
  const errs = rules(res, "error");
  assert.ok(errs.includes("schema.unknown-key") && res.findings.items.some((f) => /pluginMiscInfo\.typo/.test(f.message)), res.summary);
  assert.ok(errs.includes("rank.range"));
  const s2 = sourceOnly();
  s2.toolEnable = false;
  s2.pluginInfos[0].formulaSet = 'LOOKUP_GETID(金額合計) & APP_URL("/k/1/") & LOGIN_CODE()';
  const res2 = await run(s2);
  assert.equal(res2.findings.count("error"), 0, res2.summary);
  assert.ok(rules(res2, "warning").includes("tool.disabled"));
  assert.deepEqual(res2.contextNeeds.lookups, [{ fieldcode: "金額合計", arg: "金額合計" }]);
  assert.deepEqual(res2.contextNeeds.appUrl, ["金額合計"]);
  assert.deepEqual(res2.contextNeeds.login, ["金額合計"]);
  // ユーザー情報の関数は、1 つ目の引数が文字列のコードならログインユーザーは要らない（3 回目の試用で OINFO("sales") が --user 無しで止まっていた）
  const s3 = sourceOnly();
  s3.pluginMiscInfo.userInfo = true;
  s3.pluginInfos[0].formulaSet = 'OINFO("sales", "name") & OUSERS("sales")';
  const res3 = await run(s3);
  assert.equal(res3.findings.count("error"), 0, res3.summary);
  assert.deepEqual(res3.contextNeeds.login, [], "文字列のコードだけならログインユーザーは要らない");
  assert.ok(rules(res3, "warning").includes("userinfo.unknown"), "既定のテストデータに sales は無い");
  const s4 = sourceOnly();
  s4.pluginMiscInfo.userInfo = true;
  s4.pluginInfos[0].formulaSet = 'UINFO("", "name") & OINFO("sales")';
  assert.deepEqual((await run(s4)).contextNeeds.login, ["金額合計"], "引数なし（ログインユーザー）があれば要る");
});

test("calc: 文脈が足りなければ名指しで止まる。sink が呼ばれたら結果を採らない。--app の取り違え", { skip }, async () => {
  const engine = await loadEngine();
  const record = { $id: { type: "RECORD_NUMBER", value: "1" }, 商品セット: { type: "CHECK_BOX", value: [] }, 金額合計: { type: "NUMBER", value: "" }, テーブル: { type: "SUBTABLE", value: [] } };
  const base = { engine, fields: FIELDS_FILE(), appId: 2305, records: [{ id: "1", record }], usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" } };
  const s = sourceOnly();
  s.pluginInfos[0].formulaSet = 'LOOKUP_GETID(金額合計)';
  const res = await run(s);
  assert.equal(res.findings.count("error"), 0, res.summary);
  assert.throws(() => calcSettings({ ...base, normalized: res }), /ルックアップ項目でない/);
  const s2 = sourceOnly();
  s2.pluginInfos[0].formulaSet = 'APP_URL("/k/1/")';
  const res2 = await run(s2);
  engine.setContext({ baseUrl: "https://example.cybozu.com" });
  assert.throws(() => calcSettings({ ...base, normalized: res2 }), /接続先の URL が無い/);
  engine.setContext({ baseUrl: "https://real.cybozu.com" });
  assert.equal(calcSettings({ ...base, normalized: res2 }).records[0].errors.length, 0);
  engine.setContext({ baseUrl: "https://example.cybozu.com" });
  // sink: policy で CLIPBORD_WRITE を許すと評価され、実行時の sink が記録される → failed
  const s3 = sourceOnly();
  s3.pluginInfos[0].formulaSet = 'CLIPBORD_WRITE("x")';
  const res3 = await run(s3, { policy: parsePolicy('{"allowFunctions":["CLIPBORD_WRITE"]}', "policy") });
  assert.equal(res3.findings.count("error"), 0, res3.summary);
  const r3 = calcSettings({ ...base, normalized: res3 });
  assert.equal(r3.records[0].failed, true);
  assert.ok(r3.records[0].errors.some((e) => e.fieldcode === "(sink)"));
  // --app の取り違え
  assert.throws(() => calcSettings({ ...base, normalized: res3, appId: 9999 }), /--app 9999 が設定の appId 2305 と違う/);
  assert.throws(() => calcSettings({ ...base, normalized: res3, records: [{ id: "1", record, fileAppId: 7 }] }), /アプリ 7 のもの/);
});

test("engine: blockDq の間は dq が例外", { skip }, async () => {
  const engine = await loadEngine();
  const kf = engine.checker({}, {});
  engine.blockDq(true);
  assert.throws(() => kf.dq("1+1"), /遮断/);
  engine.blockDq(false);
  assert.equal(kf.dq("1+1"), 2);
});
