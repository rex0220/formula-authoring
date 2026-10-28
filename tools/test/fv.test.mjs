/**
 * 項目検証の規則（src/fv/）を、本物の計算式の zip のエンジンと架空のアプリ（fixtures/fv）で確かめる。
 * 項目検証の本物のコードとの照合は kit の test/plugins/fv-authoring-compare.test.mjs（非公開のコードを読むので kit に置く）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import { fvSourceOf } from "../src/fv/model.ts";
import { fvApplySource, fvPropsOf, fvRowsOf } from "../src/fv/rows.ts";
import { fvBuildSaved, fvDerive, fvStrip } from "../src/fv/derive.ts";
import { fvJudgeRecord } from "../src/fv/judge.ts";
import { FV_SNAPSHOT_RE, engineOfFv, fvUpdateFunctions } from "../src/fv/meta.ts";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const FIX = path.join(import.meta.dirname, "fixtures", "fv");
const read = (name) => JSON.parse(readFileSync(path.join(FIX, name), "utf8"));

/** 架空のアプリに置く設定（元の値。足りないキーは fvSourceOf が補う） */
const SOURCE = {
  pluginInfos: [
    { fieldcode: "氏名", state: true, disabledSet: '区分 = "B"', condInfos: [{ state: true, condSet: '氏名 = "test"', jaSet: '"test は使えません" // 予約の名前', enSet: "", zhSet: "" }] },
    { fieldcode: "金額", state: true, formulaSet: '区分 = "A"' },
    { fieldcode: "備考", state: true, hideSet: '区分 = "B"', init: true },
    { fieldcode: "時刻", state: true, hideSet: '区分 = "B"', init: true },
    { fieldcode: "参照", state: true, hideSet: '区分 = "B"', init: true },
    { fieldcode: "明細", state: true, tblfields: [{ fieldcode: "数量", state: true, hideSet: "金額 > 500" }] },
    { fieldcode: "数量", state: true, formulaSet: '品名 <> ""', condInfos: [{ state: true, condSet: "数量 > 50", jaSet: '"多すぎます"', enSet: '"Too many"', zhSet: "" }] },
    { fieldcode: "明細($ADD)", state: true, hideSet: "金額 > 800" },
    { fieldcode: "(note)", state: true, hideSet: 'UINFO(LOGIN_CODE(), "name") = ""' }
  ]
};

async function build(sourceRaw = SOURCE) {
  const engine = await loadEngine();
  const { pp, crec } = fvPropsOf(read("fields.json").properties);
  const rows = fvRowsOf(pp, read("layout.json").layout);
  const source = fvSourceOf(sourceRaw);
  const applied = fvApplySource(rows, source);
  const errors = fvDerive({ engine, pp, crec }, rows);
  return { engine, rows, applied, errors, saved: fvBuildSaved(rows, pp, source) };
}

/** 架空のアプリのレコード（kintone の形） */
function record(values = {}, lines = []) {
  const rec = {};
  for (const [code, p] of Object.entries(read("fields.json").properties)) {
    if (p.type === "GROUP") continue;
    if (p.type === "SUBTABLE") {
      rec[code] = { type: "SUBTABLE", value: lines.map((l, i) => ({ id: String(i + 1), value: { 品名: { type: "SINGLE_LINE_TEXT", value: l.品名 ?? "" }, 数量: { type: "NUMBER", value: l.数量 ?? "" } } })) };
      continue;
    }
    rec[code] = { type: p.type, value: values[code] ?? (p.type === "USER_SELECT" ? [] : "") };
  }
  return rec;
}

test("fvSourceOf: 既定値、旧い形のキー、枠線の正規化", () => {
  const s = fvSourceOf({ pluginInfos: [{ fieldcode: "a", formula: "1", hide: "x", condInfos: [{ state: "1", cond: "c", ja: '"m"' }] }, { nocode: true }], pluginBorderInfo: { borderList: [{ state: 1, width: 9, color: "abc" }, {}, {}, {}] } });
  assert.equal(s.pluginEnable, true);
  assert.deepEqual(s.pluginInfos, [{ fieldcode: "a", state: false, formulaSet: "1", disabledSet: "", hideSet: "x", init: false, condInfos: [{ state: true, condSet: "c", jaSet: '"m"', enSet: "", zhSet: "" }] }]);
  assert.deepEqual(s.pluginBorderInfo.borderList.map((b) => [b.state, b.width, b.color]), [[true, 5, "#aabbcc"], [false, 5, "#7bd6af"], [false, 5, "#e74c3c"]]);
  assert.equal(fvSourceOf({ pluginEnable: false }).pluginEnable, false);
});

test("fvRowsOf: 行の種類（一番上・要素 ID・ルックアップ・テーブルと子・ボタン・グループの中）と ptcode", () => {
  const { pp } = fvPropsOf(read("fields.json").properties);
  const rows = fvRowsOf(pp, read("layout.json").layout);
  const brief = rows.map((r) => [r.fieldcode, r.ptcode, r.type2]);
  assert.deepEqual(brief, [
    ["氏名", "", "SINGLE_LINE_TEXT"], ["金額", "", "NUMBER"], ["(note)", "", "LABEL"],
    ["区分", "", "DROP_DOWN"], ["備考", "", "MULTI_LINE_TEXT"], ["(sp1)", "", "SPACER"],
    ["時刻", "", "TIME"], ["参照", "", "SINGLE_LINE_TEXT\n(LOOKUP)"], ["計算", "", "CALC"],
    ["明細", null, "SUBTABLE"], ["品名", "明細", "SINGLE_LINE_TEXT"], ["数量", "明細", "NUMBER"], ["明細($ADD)", "明細", "$ADD_BUTTON"], ["明細($DEL)", "明細", "$DEL_BUTTON"],
    ["グループ1", null, "GROUP"], ["担当", null, "USER_SELECT"], ["(line1)", null, "HR"]
  ]);
  assert.equal(rows[0].formulaSet, "1", "フォームで必須の項目の必須条件は 1");
  assert.equal(rows[0].constrain, "required, maxLen:10, minLen:2");
  assert.deepEqual(rows[9].tblfields.map((t) => t.fieldcode), ["品名", "数量"]);
  assert.equal(pp.品名.ptcode, "明細");
});

test("fvApplySource: アプリに無い行・子、同じ項目の行が 2 つ、フォームで必須の '1' は変えない", () => {
  const { pp } = fvPropsOf(read("fields.json").properties);
  const rows = fvRowsOf(pp, read("layout.json").layout);
  const r = fvApplySource(rows, fvSourceOf({ pluginInfos: [
    { fieldcode: "氏名", state: true, formulaSet: '区分 = "A"' }, { fieldcode: "消えた項目", state: true },
    { fieldcode: "明細", tblfields: [{ fieldcode: "消えた子", state: true }] }, { fieldcode: "金額", state: true }, { fieldcode: "金額", state: false }
  ] }));
  assert.deepEqual(r, { missing: ["消えた項目"], missingChildren: ["明細.消えた子"], duplicates: ["金額"] });
  assert.equal(rows.find((x) => x.fieldcode === "氏名").formulaSet, "1");
  assert.equal(rows.find((x) => x.fieldcode === "金額").state, false, "後のものが勝つ");
});

test("fvStrip: 実体参照、// から行末、改行（文字列の中の // も消える）", () => {
  assert.equal(fvStrip('A &amp;&gt; B // メモ\nC'), "A &> B C");
  assert.equal(fvStrip('"https://example.com"'), '"https:');
  assert.equal(fvStrip(null), "");
});

test("fvDerive / fvBuildSaved: 読む項目、検証条件の cond / ja / en / zh、テーブル内非表示、フラグ、内部番号は空", { skip }, async () => {
  const { errors, saved } = await build();
  assert.deepEqual(errors, []);
  const byCode = Object.fromEntries(saved.pluginFields.map((f) => [f.fieldcode, f]));
  assert.deepEqual(Object.keys(byCode), ["氏名", "金額", "(note)", "備考", "時刻", "参照", "明細", "数量", "明細($ADD)"], "レイアウトの行の順");
  assert.equal(byCode.氏名.formula, "1");
  assert.ok("区分" in byCode.氏名.usedFields && "氏名" in byCode.氏名.usedFields, "必須条件・入力不可・検証条件の和");
  const c = byCode.氏名.condInfos[0];
  assert.deepEqual([c.cond, c.ja, c.en, c.zh], ['氏名 = "test"', '"test は使えません" ', '"test は使えません" ', '"test は使えません" ']);
  assert.equal(byCode.氏名.condDesc, "Y");
  assert.equal(byCode.明細.condDesc, "Y");
  assert.deepEqual(byCode.明細.tblfields.map((t) => [t.fieldcode, t.hide, t.fieldno]), [["品名", "", undefined], ["数量", "金額 > 500", ""]]);
  assert.ok("金額" in byCode.明細.usedFieldsTable);
  assert.equal(byCode.氏名.fieldno, "");
  assert.equal(saved.pluginHideCheck, true);
  assert.equal(saved.pluginUOG, true, "UINFO を使う");
  assert.ok(!("$UGO$" in byCode["(note)"].usedFields), "保存の pluginFields からは印を除く");
  assert.equal(saved.pluginPP.品名.ptcode, "明細");
  assert.equal(saved.pluginPP.参照.lookup, true);
  assert.deepEqual(saved.pluginInfos.map((i) => i.fieldcode).slice(0, 2), ["氏名", "金額"]);
});

test("fvDerive: 式の誤り、空の検証条件、「使う」がオフの行の誤りは on: false", { skip }, async () => {
  const { errors } = await build({ pluginInfos: [
    { fieldcode: "金額", state: true, formulaSet: "NO_SUCH_FUNC(1)" },
    { fieldcode: "氏名", state: true, condInfos: [{ state: true, condSet: "1", jaSet: "" }] },
    { fieldcode: "区分", state: false, condInfos: [{ state: true, condSet: "", jaSet: '"x"' }] },
    { fieldcode: "明細", state: true, tblfields: [{ fieldcode: "品名", state: true, hideSet: "" }] }
  ] });
  assert.deepEqual(errors.map((e) => [e.fieldcode, e.column, e.index ?? null, e.part ?? null, e.on]), [
    ["氏名", "condInfos", 0, "jaSet", true],
    ["金額", "formulaSet", null, null, true],
    ["区分", "condInfos", 0, "condSet", false],
    ["明細", "tblfields", 0, "品名", true]
  ]);
});

test("fvJudgeRecord: 必須・入力不可・制約の文・検証条件・非表示と初期化・ルックアップの解除・テーブル・行のボタン", { skip }, async () => {
  const { engine, saved } = await build();
  const judge = (rec, opt) => fvJudgeRecord(engine, saved, rec, opt);

  let r = judge(record({ 区分: "A" }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.fields.氏名, { hidden: false, disabled: false, required: true, errors: ["1文字より長くなければなりません。"] }, "制約の文は必須より先");
  assert.deepEqual(r.fields.金額.errors, ["必須項目"]);
  assert.equal(judge(record({ 区分: "A" }), { lang: "en" }).fields.金額.errors[0], "Required.");

  r = judge(record({ 区分: "A", 氏名: "test", 金額: "5" }));
  assert.deepEqual(r.fields.氏名.errors, ["test は使えません"]);
  r = judge(record({ 区分: "B", 氏名: "test", 金額: "5" }));
  assert.deepEqual([r.fields.氏名.disabled, r.fields.氏名.required, r.fields.氏名.errors], [true, false, []], "入力不可なら必須でなく、検証条件も見ない");

  // 隠れて初期化がオン: 保存の前だけ初期値。ルックアップは値があればイベントによらず解除
  const hidden = record({ 区分: "B", 氏名: "山田", 備考: "メモ", 時刻: "12:30", 参照: "K1" });
  r = judge(hidden);
  assert.deepEqual([r.fields.備考.hidden, r.fields.備考.reset, r.fields.参照.reset], [true, undefined, { value: "", lookup: "CLEAR" }]);
  r = judge(hidden, { type: "app.record.edit.submit" });
  assert.deepEqual([r.fields.備考.reset, r.fields.時刻.reset, r.fields.参照.reset], [{ value: "既定の備考" }, { value: "09:00" }, { value: "", lookup: "CLEAR" }]);
  assert.equal(r.ok, true);

  // テーブル: 列の非表示、行ごとの必須・制約・検証条件、行のボタン
  r = judge(record({ 区分: "B", 氏名: "山田", 金額: "100" }, [{ 品名: "x", 数量: "60" }, { 品名: "", 数量: "" }, { 品名: "y", 数量: "200" }]));
  assert.deepEqual(r.tables.明細.map((l) => [l.数量.required, l.数量.errors]), [[true, ["多すぎます"]], [false, []], [true, ["100以下である必要があります。"]]]);
  assert.deepEqual(r.tables.明細[0].$ADD_BUTTON, { hidden: false });
  r = judge(record({ 区分: "B", 氏名: "山田", 金額: "900" }, [{ 品名: "x", 数量: "60" }]), { lang: "en" });
  assert.deepEqual([r.tables.明細[0].数量.hidden, r.tables.明細[0].数量.errors, r.tables.明細[0].$ADD_BUTTON], [true, [], { hidden: true }]);

  const rec = record({ 区分: "A" }, [{ 品名: "x" }]);
  const before = JSON.stringify(rec);
  judge(rec, { type: "app.record.index.edit.submit" });
  assert.equal(JSON.stringify(rec), before, "レコードを書き換えない");
});

test("meta: 更新系の関数、版の表、ダウンロードの名前", () => {
  const update = fvUpdateFunctions(["FSET", "BUTTON"]);
  assert.ok(update.has("TLTABLE") && update.has("CSV_TVAL") && update.has("FSET"));
  assert.ok(!update.has("TABLE_DIC") && !update.has("SUMIF"));
  assert.equal(engineOfFv(72)?.formulaVersion, 102);
  assert.equal(engineOfFv(80)?.formulaVersion, 102);
  assert.equal(engineOfFv(71), undefined);
  assert.ok(FV_SNAPSHOT_RE.test("rex0220-field-validation-app4376-20261028-101500.json"));
  assert.ok(!FV_SNAPSHOT_RE.test("rex0220-formula-app4376-20261028-101500.json"));
});
