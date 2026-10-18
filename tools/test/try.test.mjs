/** try（式の試し計算。計画 25 章）: 同梱のサンプルアプリに 1 行だけの設定を組んで normalize → calc。本物の zip（formula の dist の Ver.101）で確かめる */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import { SAMPLE_APP, describeSampleApp, sampleApp } from "../src/sample-app.ts";
import { TRY_MAX_FORMULAS, buildTryEnvelope, resolveTryTarget, spacersOf, trySettings } from "../src/commands/try.ts";
import { runEval } from "../src/worker/run.ts";
import { DEFAULT_USERS, defaultUsersInfo } from "../src/users/index.ts";
import { DEFAULT_POLICY, parsePolicy } from "../src/normalize/policy.ts";
import { InputError } from "../src/input.ts";
import { FIELDS_FILE } from "./fixtures.mjs";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const run = async (formulas, opt = {}) => {
  const engine = await loadEngine();
  return trySettings({ engine, formulas, usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" }, ...opt });
};
const values = (r) => r.values.map((v) => v.value);

test("サンプルアプリ: 全項目タイプ × 2、テーブル 2 つ（子 17）、レコード 3 件（典型 / 端 / 空）。実在の接続先・ユーザーは無い。写しは元を変えない", () => {
  const { fields, records } = SAMPLE_APP;
  assert.equal(fields.baseUrl, "https://example.cybozu.com");
  assert.equal(Object.keys(fields.properties).length, 47);
  const tables = Object.values(fields.properties).filter((p) => p.type === "SUBTABLE");
  assert.deepEqual(tables.map((t) => t.code).sort(), ["テーブル1", "テーブル2"]);
  assert.equal(Object.keys(tables[0].fields).length, 17);
  for (const type of ["SINGLE_LINE_TEXT", "NUMBER", "DATE", "DATETIME", "TIME", "DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "LINK", "RICH_TEXT", "MULTI_LINE_TEXT"]) {
    assert.ok(Object.values(fields.properties).filter((p) => p.type === type).length >= 2, type);
  }
  assert.deepEqual(records.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(records.map((r) => r.record["テーブル1"].value.length), [3, 1, 0]);
  const text = JSON.stringify(SAMPLE_APP);
  assert.doesNotMatch(text, /cybozu\.com/g.source === "cybozu\\.com" ? /[a-z0-9-]+\.cybozu\.com/.source && /(?<!example)\.cybozu\.com/ : /x/, "実在のホスト名が無い");
  assert.deepEqual(records[0].record["ユーザー1"].value.map((u) => u.code), ["demo_user01"], "ユーザーは既定のテストデータのコード");
  const copy = sampleApp();
  copy.records[0].record["数値1"].value = "changed";
  assert.equal(SAMPLE_APP.records[0].record["数値1"].value, "1234");
  const d = describeSampleApp(new Set(["NUMBER"]));
  assert.match(d, /数値1  NUMBER  ○/);
  assert.match(d, /1: 典型/);
  assert.deepEqual(spacersOf(fields), ["sp1"], "要素 ID のあるスペース項目（2026-10-18 に足した）");
  assert.match(d, /スペース項目（要素 ID。.*）: sp1/);
});

test("対象の決め方: 型は式が参照していない項目を優先（数値1 を使えば 数値2）、別名（TEXT）、項目コード、テーブルの子（table 省略でも探す）、計算式を置けない型は誤り", async () => {
  const engine = await loadEngine();
  const types = new Set(engine.api.TARGET_TYPES);
  const f = SAMPLE_APP.fields;
  assert.deepEqual(resolveTryTarget(f, types, "NUMBER", undefined, new Set(["数値1"])), { code: "数値2", type: "NUMBER" });
  assert.deepEqual(resolveTryTarget(f, types, "number", undefined), { code: "数値1", type: "NUMBER" });
  assert.deepEqual(resolveTryTarget(f, types, undefined, undefined), { code: "文字列1", type: "SINGLE_LINE_TEXT" }, "既定は TEXT");
  assert.deepEqual(resolveTryTarget(f, types, "日付2", undefined), { code: "日付2", type: "DATE" });
  assert.deepEqual(resolveTryTarget(f, types, "NUMBER", "テーブル2"), { code: "T2_数値", type: "NUMBER", table: "テーブル2" });
  assert.deepEqual(resolveTryTarget(f, types, "T1_文字列", undefined), { code: "T1_文字列", type: "SINGLE_LINE_TEXT", table: "テーブル1" });
  assert.throws(() => resolveTryTarget(f, types, "FILE", undefined), (e) => e instanceof InputError && /FILE の項目には計算式を設定できない/.test(e.message));
  assert.throws(() => resolveTryTarget(f, types, "計算1", undefined), (e) => e instanceof InputError && /CALC には計算式を設定できない/.test(e.message));
  assert.throws(() => resolveTryTarget(f, types, "NUMBER", "数値1"), (e) => e instanceof InputError && /テーブルでない/.test(e.message));
  assert.throws(() => resolveTryTarget(f, types, "ZZZ", undefined), (e) => e instanceof InputError && /型でも項目コードでもない/.test(e.message));
  for (const as of ["SPACER", "sp1", "(sp1)"]) assert.deepEqual(resolveTryTarget(f, types, as, undefined), { code: "(sp1)", type: "SPACER", elementId: "sp1" }, as);
  assert.throws(() => resolveTryTarget(f, types, "sp1", "テーブル1"), (e) => e instanceof InputError && /テーブルの中に置けない/.test(e.message));
  const env = buildTryEnvelope(engine, f, "数値2", "1 + 1", "ja");
  assert.equal(env.pluginID, "rex0220 formula plugin");
  assert.equal(env.PluginVersion, engine.source.pluginVersion);
  assert.equal(env.toolEnable, true);
  assert.equal(env.pluginMiscInfo.circular_refer, true);
  assert.deepEqual(env.pluginInfos, [{ fieldcode: "数値2", state: true, formulaSet: "1 + 1", edit: false, hide: false, rank: "" }]);
});

test("試し計算: 数値・文字列・日付・テーブルの中・集計の値（型に入れた後の値と生の値）。式ごとに独立（誤りの式はほかを止めない）。自分の封筒の情報は出さない", { skip }, async () => {
  const r = await run([
    { formula: "ROUND(数値1 / 3, 2)", as: "NUMBER" },
    { formula: "数値1 + 数値2" },
    { formula: "T1_数値 * 2", as: "NUMBER", table: "テーブル1" },
    { formula: "SUM(T1_数値)", as: "NUMBER" },
    { formula: 'DATE_FORMAT(日付1, "YYYY/MM/DD")' },
    { formula: "NOSUCH(1)" },
    { formula: "1", as: "FILE" },
    { formula: "ARRAY_FOR(3, i, i * 2)" }
  ]);
  assert.equal(r.app.appId, 4329);
  assert.deepEqual([r.app.source, r.app.records, r.app.extraFields], ["sample", ["1", "2", "3"], []]);
  assert.match(r.summary, /試し計算 8 式: ok 6、エラー 2/);
  assert.match(r.contextLine, /アプリ 4329、ログインユーザー authoring/);
  const [round, add, row, sum, date, unknown, file, arr] = r.results;
  assert.deepEqual([round.status, round.target], ["ok", { code: "数値2", type: "NUMBER" }], "数値1 を使う式の対象は 数値2");
  assert.deepEqual(values(round), ["411.33", "0", ""]);
  assert.equal(round.values[0].raw, 411.33, "生の値は数");
  assert.equal(round.values[2].raw, undefined, "空は同じなので生の値を出さない");
  assert.deepEqual([add.target.code, values(add)], ["文字列1", ["1290.78", "-12.345", ""]]);
  assert.deepEqual([row.target, values(row)], [{ code: "T1_数値", type: "NUMBER", table: "テーブル1" }, [["200", "400", "600"], ["0"], []]], "テーブルの中は行ごと");
  assert.deepEqual(row.values[0].raw, [200, 400, 600]);
  assert.deepEqual(values(sum), ["600", "0", "0"]);
  assert.deepEqual(values(date), ["2026/01/15", "2026/02/28", ""]);
  assert.equal(unknown.status, "invalid");
  assert.ok(unknown.findings.some((f) => f.level === "error" && f.rule === "formula.unknown-function"), JSON.stringify(unknown.findings));
  assert.deepEqual(unknown.values, []);
  assert.equal(file.status, "invalid");
  assert.ok(file.findings.some((f) => f.rule === "try.target"));
  assert.deepEqual(values(arr), ["0,2,4", "0,2,4", "0,2,4"]);
  assert.deepEqual(arr.values[0].raw, [0, 2, 4]);
  for (const x of r.results) {
    assert.ok(!x.findings.some((f) => ["misc.changed", "tool.disabled", "fieldno.screen", "size.bytes"].includes(f.rule)), `${x.index}: ${JSON.stringify(x.findings)}`);
    assert.ok(!x.findings.some((f) => f.rule === "formula.circular"), "自己参照でも circular_refer で検査を通す");
    if (x.index !== 3) assert.ok(!x.findings.some((f) => f.rule === "try.self-reference"), `${x.index}: 式が参照しない項目を選ぶので自己参照にならない`);
  }
  assert.ok(row.findings.some((f) => f.rule === "try.self-reference" && /行ごとに 1 回/.test(f.message)), "テーブルの中の NUMBER は T1_数値 だけなので自己参照（行ごとに 1 回なので値は 1 回分）");
  assert.match(r.text, /\[1\] 数値2（NUMBER）← ROUND\(数値1 \/ 3, 2\)\n    レコード 1: "411.33"（生の値 411.33）/);
  assert.match(r.text, /\[6\] 文字列1（SINGLE_LINE_TEXT）← NOSUCH\(1\)\n    エラー formula.unknown-function/);
});

test("試し計算: 文脈（ユーザー情報の印、APP_URL は既定の接続先で評価、イベント、records の絞り込み）、policy の副作用、自己参照、上限", { skip }, async () => {
  const r = await run([
    { formula: 'UINFO("demo_user02", "name")' },
    { formula: "LOGIN_CODE()" },
    { formula: "APP_URL()" },
    { formula: 'EV_INFO("type")' },
    { formula: "数値1 * 2", as: "数値1" },
    { formula: "FSET(数値2, 1)" }
  ], { records: [2, 1], evType: "app.record.create.show", user: "demo_user03" });
  assert.deepEqual(r.app.records, ["2", "1"]);
  const [uinfo, login, url, ev, self, fset] = r.results;
  assert.deepEqual(uinfo.values.map((v) => v.record), ["2", "1"], "records の順");
  assert.equal(uinfo.status, "ok", JSON.stringify(uinfo));
  assert.ok(uinfo.values[0].value !== "" && uinfo.values[0].value !== "[object Object]", JSON.stringify(uinfo.values));
  assert.ok(uinfo.marks.some((m) => /ユーザー情報/.test(m)));
  assert.deepEqual(values(login), ["demo_user03", "demo_user03"], "--user のログインユーザー");
  assert.deepEqual(values(url), ["https://example.cybozu.com/", "https://example.cybozu.com/"], "接続先が無くても既定の接続先で止まらない");
  assert.deepEqual(values(ev), ["app.record.create.show", "app.record.create.show"]);
  assert.deepEqual([self.status, self.target.code, values(self)], ["ok", "数値1", ["0", "4936"]], "項目コードを指定した自己参照は circular_refer で通る（テーブルの外は 1 段目と 2 段目で 2 回計算 = 1234 × 2 × 2。実機と同じ）");
  assert.ok(self.findings.some((f) => f.rule === "try.self-reference" && f.level === "warning"), JSON.stringify(self.findings));
  assert.equal(fset.status, "invalid");
  assert.ok(fset.findings.some((f) => f.rule === "formula.side-effect" && f.level === "error"), "副作用は policy の承認が無ければ評価しない");
  const ok = await run([{ formula: "FSET(数値2, 1)" }], { policy: parsePolicy('{"allowFunctions":["FSET"]}', "policy") });
  assert.equal(ok.results[0].status, "ok", JSON.stringify(ok.results[0]));
  assert.ok(ok.results[0].findings.some((f) => f.rule === "formula.side-effect" && f.level === "warning"));
  await assert.rejects(run(Array.from({ length: TRY_MAX_FORMULAS + 1 }, () => ({ formula: "1" }))), (e) => e instanceof InputError && /10 個まで/.test(e.message));
  await assert.rejects(run([{ formula: "1" }], { records: [9] }), (e) => e instanceof InputError && /records は 1〜3/.test(e.message));
  await assert.rejects(run([]), InputError);
  const empty = await run([{ formula: "   " }, { formula: "x".repeat(4001) }]);
  assert.deepEqual(empty.results.map((x) => [x.status, x.findings[0].rule]), [["invalid", "try.formula"], ["invalid", "try.formula"]]);
});

test("Worker: kind try の仕事（設定ファイル・項目定義なし）で結果の try が戻る。normalize は集計（ok でない式があれば hasErrors）", { skip }, async () => {
  const job = { kind: "try", pluginZip: PLUGIN_ZIP, mode: "dev", usersSource: DEFAULT_USERS, usersOrigin: { kind: "default" }, policy: DEFAULT_POLICY, try: { formulas: [{ formula: "数値1 + 1", as: "NUMBER" }, { formula: "NOSUCH()" }], records: [1] } };
  const out = await runEval(job, { timeoutSec: 60 });
  assert.ok(out.try);
  assert.deepEqual(out.try.results.map((x) => x.status), ["ok", "invalid"]);
  assert.deepEqual(out.try.results[0].values, [{ record: "1", value: "1235", raw: 1235 }]);
  assert.equal(out.normalize.hasErrors, true);
  assert.match(out.normalize.summary, /ok 1、エラー 1/);
  assert.deepEqual(out.normalize.findings, []);
  await assert.rejects(runEval({ ...job, try: undefined }, { timeoutSec: 30 }), (e) => e.kind === "input" && /式が無い/.test(e.message));
  await assert.rejects(runEval({ ...job, kind: "normalize" }, { timeoutSec: 30 }), (e) => e.kind === "input" && /設定か項目定義が無い/.test(e.message));
});

test("架空の項目と値（案 1・案 2）: 標本に項目を足し、簡略形の値のレコードで計算。標本のレコードにも足した項目を補う。data があれば標本のレコードは records で選んだものだけ", { skip }, async () => {
  const r = await run([
    { formula: "単価 * 数量", as: "NUMBER" },
    { formula: 'SUMIF(分類 = "明細", 金額)', as: "NUMBER" },
    { formula: "ユーザー1" },
    { formula: "単価", as: "単価" }
  ], {
    fields: [{ code: "単価", type: "NUMBER" }, { code: "数量", type: "NUMBER" }, { code: "明細", type: "SUBTABLE", fields: [{ code: "分類", type: "DROP_DOWN", options: ["明細", "小計"] }, { code: "金額", type: "NUMBER" }] }],
    data: [{ 単価: 100, 数量: "3", 明細: [{ 分類: "明細", 金額: 200 }, { 分類: "明細", 金額: 600 }, { 分類: "小計", 金額: 800 }], ユーザー1: "demo_user02" }, { 単価: 0 }],
    records: [1]
  });
  assert.deepEqual([r.app.source, r.app.records, r.app.extraFields], ["sample", ["1", "d1", "d2"], ["単価（NUMBER）", "数量（NUMBER）", "明細（SUBTABLE: 分類, 金額）"]]);
  const [mul, sumif, user, self] = r.results;
  assert.equal(mul.status, "ok", JSON.stringify(mul));
  assert.equal(mul.target.code, "数値1", "式が使わない NUMBER（短いコードの順）");
  assert.deepEqual(values(mul), ["", "300", ""]);
  assert.deepEqual([sumif.target.code, values(sumif)], ["単価", ["0", "800", "0"]], "標本のレコード 1 には足した項目（空のテーブル）が入るので 0");
  assert.deepEqual(values(user), ["架空 社長", "架空 営業部長", ""]);
  assert.deepEqual([self.target.code, values(self)], ["単価", ["", "100", "0"]]);
  assert.match(r.text, /足した項目（架空）: 単価（NUMBER）、数量（NUMBER）、明細（SUBTABLE: 分類, 金額）/);
  assert.match(r.text, /レコード d1: 架空の値（単価, 数量, 明細, ユーザー1）/);
  const only = await run([{ formula: "数値1 + 1", as: "NUMBER" }], { data: [{ 数値1: 1 }], base: 1 });
  assert.deepEqual(only.app.records, ["d1"], "data があれば標本のレコードは入らない");
  assert.deepEqual(only.results[0].values, [{ record: "d1", value: "2", raw: 2 }]);
  const base1 = await run([{ formula: "数値2" }], { data: [{}], base: 1 });
  assert.deepEqual(values(base1.results[0]), ["56.78"], "base 1 の値が土台");
  for (const [bad, re] of [
    [{ data: [{ 無い: 1 }] }, /data\[0\]\.無い: 無い項目/],
    [{ data: [{ 数値1: "abc" }] }, /NUMBER は数か数字の文字列/],
    [{ fields: [{ code: "数値1", type: "NUMBER" }] }, /既にある項目/],
    [{ data: [{}], base: 9 }, /base は標本のレコードの番号/],
    [{ fields: {} }, /fields は項目/]
  ]) await assert.rejects(run([{ formula: "1" }], bad), (e) => e instanceof InputError && re.test(e.message), String(re));
});

test("利用者のアプリの項目定義（案 3）: fixture 2305 に架空の値。標本のレコードは使えず data が要る。足した項目も使える", { skip }, async () => {
  const r = await run([
    { formula: 'SUMIF(分類="小計", 金額)', as: "金額合計" },
    { formula: "数量 * 単価", as: "金額" },
    { formula: 'IF(CONTAINS(商品セット, "A"), "セット", "単品")' },
    { formula: "APP_URL()" }
  ], {
    appFields: FIELDS_FILE(),
    fields: [{ code: "備考", type: "TEXT" }],
    data: [{ テーブル: [{ 分類: "明細", 数量: 2, 単価: 100, 金額: 200 }, { 分類: "小計", 金額: 200 }], 商品セット: ["A"], 備考: "x" }, {}]
  });
  assert.deepEqual([r.app.source, r.app.appId, r.app.records, r.app.extraFields], ["app", 2305, ["d1", "d2"], ["備考（SINGLE_LINE_TEXT）"]]);
  const [sumif, mul, set, url] = r.results;
  assert.deepEqual([sumif.target.code, values(sumif)], ["金額合計", ["200", "0"]]);
  assert.deepEqual([mul.target, values(mul)], [{ code: "金額", type: "NUMBER", table: "テーブル" }, [["200", ""], []]]);
  assert.deepEqual([set.target.code, values(set)], ["備考", ["セット", "単品"]], "TEXT の対象は足した項目（式が使わない中で短い）");
  assert.deepEqual(values(url), ["https://example.cybozu.com/", "https://example.cybozu.com/"]);
  assert.match(r.summary, /アプリ 2305「テーブル内集計」の項目定義（値は架空）/);
  assert.match(r.notice, /利用者のアプリの項目定義に架空の値/);
  await assert.rejects(run([{ formula: "1" }], { appFields: FIELDS_FILE() }), (e) => e instanceof InputError && /data（架空の値のレコード）が要る/.test(e.message));
  await assert.rejects(run([{ formula: "1" }], { appFields: FIELDS_FILE(), data: [{}], records: [1] }), (e) => e instanceof InputError && /records）は使えない/.test(e.message));
  await assert.rejects(run([{ formula: "1" }], { appFields: FIELDS_FILE(), data: [{ 数値1: 1 }] }), (e) => e instanceof InputError && /data\[0\]\.数値1: 無い項目/.test(e.message));
});

test("スペース項目（SPACER。要素 ID sp1）: 設定画面と同じく式を置ける（normalize が止めない）。レコードに値が無いので式の返り値をそのまま返す（配列 / HTML）", { skip }, async () => {
  const r = await run([
    { formula: 'ARRAY("年齢", "", IF(日付1, DATE_DIFF(日付1, "TODAY", "years") & " 才"), "text-align:right;")', as: "sp1" },
    { formula: 'IF(日付1, ARRAY("年齢", "", "x", ""), ARRAY())', as: "SPACER" },
    { formula: 'TAGS_HTML(TAG("div", 文字列1))', as: "(sp1)" },
    { formula: "NOSUCH(1)", as: "sp1" }
  ], { data: [{ 日付1: "1996-01-15", 文字列1: "架空商事" }, { 日付1: "", 文字列1: "" }] });
  const [age, hide, html, bad] = r.results;
  assert.deepEqual([age.status, age.target], ["ok", { code: "(sp1)", type: "SPACER", elementId: "sp1" }], JSON.stringify(age.findings));
  assert.ok(!age.findings.some((f) => f.rule === "field.type"), "SPACER の行の計算式を field.type で止めない");
  assert.deepEqual(age.values.map((v) => v.value), [["年齢", "", "30 才", "text-align:right;"], ["年齢", "", "", "text-align:right;"]], "返り値の配列そのまま。年齢は 2026 年の評価");
  assert.ok(age.marks.some((m) => /スペース項目/.test(m)));
  assert.deepEqual(hide.values.map((v) => v.value), [["年齢", "", "x", ""], []], "ARRAY() は非表示");
  assert.deepEqual(html.values.map((v) => v.value), ["<div>架空商事</div>", "<div></div>"]);
  assert.equal(bad.status, "invalid");
  assert.match(r.text, /\[1\] スペース項目 sp1（SPACER）← ARRAY/);
});
