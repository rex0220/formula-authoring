/** try の架空の項目と値（try-data.ts。計画 25.3）: 項目を足す、簡略形の値を kintone の形に、誤りは名指し。zip は要らない */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SAMPLE_APP } from "../src/sample-app.ts";
import { applyData, canonicalType, checkDataList, convertValue, emptyRecordOf, extendFields, fillMissing, TRY_MAX_EXTRA_FIELDS } from "../src/commands/try-data.ts";
import { defaultUsersInfo } from "../src/users/index.ts";
import { InputError } from "../src/input.ts";

const users = defaultUsersInfo();
const fields = () => SAMPLE_APP.fields;
const throwsInput = (fn, re) => assert.throws(fn, (e) => e instanceof InputError && re.test(e.message), String(re));

test("項目を足す: テーブルの外、選択肢つき、既存のテーブルの子、新しいテーブル（子つき）。レイアウトにも入る。元は変えない", () => {
  const { fields: f, added } = extendFields(fields(), [
    { code: "単価", type: "number" },
    { code: "分類", type: "DROP_DOWN", options: ["明細", "小計"], label: "分類ラベル" },
    { code: "T1_金額", type: "NUMBER", table: "テーブル1" },
    { code: "明細", type: "TABLE", fields: [{ code: "品名", type: "TEXT" }, { code: "区分", type: "CHECKBOX", options: ["A"] }] }
  ]);
  assert.deepEqual(added, ["単価（NUMBER）", "分類（DROP_DOWN: 明細 / 小計）", "T1_金額（NUMBER。テーブル1 の子）", "明細（SUBTABLE: 品名, 区分）"]);
  assert.equal(f.properties["単価"].type, "NUMBER");
  assert.deepEqual(Object.keys(f.properties["分類"].options), ["明細", "小計"]);
  assert.equal(f.properties["分類"].label, "分類ラベル");
  assert.equal(f.properties["テーブル1"].fields["T1_金額"].type, "NUMBER");
  assert.deepEqual(Object.keys(f.properties["明細"].fields), ["品名", "区分"]);
  assert.equal(f.properties["明細"].fields["品名"].type, "SINGLE_LINE_TEXT");
  const rows = f.layout.slice(-3);
  assert.deepEqual(rows.map((r) => [r.type, r.code ?? r.fields[0].code]), [["ROW", "単価"], ["ROW", "分類"], ["SUBTABLE", "明細"]]);
  const t1 = f.layout.find((r) => r.type === "SUBTABLE" && r.code === "テーブル1");
  assert.ok(t1.fields.some((c) => c.code === "T1_金額"));
  assert.equal(fields().properties["単価"], undefined, "元の標本は変えない");
  assert.equal(fields().layout.length, f.layout.length - 3);
});

test("項目を足す: 誤りは名指し（重複、形、型、選択肢、テーブル、上限）", () => {
  throwsInput(() => extendFields(fields(), [{ code: "数値1", type: "NUMBER" }]), /数値1 は既にある項目/);
  throwsInput(() => extendFields(fields(), [{ code: "T1_数値", type: "NUMBER" }]), /T1_数値 は既にある項目/);
  throwsInput(() => extendFields(fields(), [{ code: "a", type: "NUMBER" }, { code: "a", type: "TEXT" }]), /fields\[1\]: a は既にある/);
  throwsInput(() => extendFields(fields(), [{ code: "1x", type: "NUMBER" }]), /数字で始まらない/);
  throwsInput(() => extendFields(fields(), [{ code: "a b", type: "NUMBER" }]), /フィールドコード/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "FILE" }]), /型 "FILE" は足せない/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "DROP_DOWN" }]), /options（選択肢の配列）が要る/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "DROP_DOWN", options: ["a", "a"] }]), /options が重複/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "NUMBER", options: ["a"] }]), /NUMBER に options は付けない/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "NUMBER", table: "数値1" }]), /テーブルでない/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "SUBTABLE" }]), /fields（子の配列。1 つ以上）が要る/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "SUBTABLE", table: "テーブル1", fields: [{ code: "y", type: "NUMBER" }] }]), /テーブルの中にテーブルは置けない/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "SUBTABLE", fields: [{ code: "y", type: "SUBTABLE" }] }]), /テーブルの子にできない/);
  throwsInput(() => extendFields(fields(), [{ code: "x", type: "NUMBER", fields: [] }]), /type SUBTABLE のときだけ/);
  throwsInput(() => extendFields(fields(), Array.from({ length: TRY_MAX_EXTRA_FIELDS + 1 }, (_, i) => ({ code: `f${i}`, type: "NUMBER" }))), /20 個まで/);
  // 先に足したテーブルの子として足せる
  const { added } = extendFields(fields(), [{ code: "t", type: "SUBTABLE", fields: [{ code: "a", type: "NUMBER" }] }, { code: "b", type: "TEXT", table: "t" }]);
  assert.deepEqual(added, ["t（SUBTABLE: a）", "b（SINGLE_LINE_TEXT。t の子）"]);
  assert.equal(canonicalType("text"), "SINGLE_LINE_TEXT");
});

test("簡略形の値 → kintone の形: 型ごとの変換と検査", () => {
  const p = fields().properties;
  const w = "data[0].x";
  assert.equal(convertValue(p["数値1"], 100, w, users), "100");
  assert.equal(convertValue(p["数値1"], " -12.5 ", w, users), "-12.5");
  assert.equal(convertValue(p["数値1"], null, w, users), "");
  throwsInput(() => convertValue(p["数値1"], "abc", w, users), /NUMBER は数か数字の文字列/);
  throwsInput(() => convertValue(p["数値1"], Infinity, w, users), /有限の数/);
  assert.equal(convertValue(p["文字列1"], 12, w, users), "12");
  assert.equal(convertValue(p["文字列複数行1"], "a\nb", w, users), "a\nb");
  throwsInput(() => convertValue(p["文字列1"], { a: 1 }, w, users), /文字列を書く/);
  throwsInput(() => convertValue(p["文字列1"], "x".repeat(2001), w, users), /2000 文字まで/);
  assert.equal(convertValue(p["日付1"], "2026-03-31", w, users), "2026-03-31");
  throwsInput(() => convertValue(p["日付1"], "2026/03/31", w, users), /DATE は "YYYY-MM-DD"/);
  assert.equal(convertValue(p["時刻1"], "09:30", w, users), "09:30");
  throwsInput(() => convertValue(p["時刻1"], "9:30", w, users), /TIME は "HH:mm"/);
  assert.equal(convertValue(p["日時1"], "2026-03-31T00:30:00Z", w, users), "2026-03-31T00:30:00Z");
  assert.equal(convertValue(p["日時1"], "2026-03-31T09:30+09:00", w, users), "2026-03-31T09:30+09:00");
  throwsInput(() => convertValue(p["日時1"], "2026-03-31", w, users), /DATETIME は/);
  assert.equal(convertValue(p["ドロップダウン1"], "A", w, users), "A");
  assert.equal(convertValue(p["ドロップダウン1"], "", w, users), "");
  throwsInput(() => convertValue(p["ドロップダウン1"], "Z", w, users), /選択肢に無い値 "Z"（A \/ B \/ C）/);
  assert.deepEqual(convertValue(p["複数選択1"], "A", w, users), ["A"]);
  assert.deepEqual(convertValue(p["チェック1"], ["A", "B"], w, users), ["A", "B"]);
  throwsInput(() => convertValue(p["チェック1"], ["Z"], w, users), /\[0\]: 選択肢に無い値/);
  assert.deepEqual(convertValue(p["ユーザー1"], "demo_user02", w, users), [{ code: "demo_user02", name: users.userCodes.demo_user02.name }], "名前はテストデータから");
  assert.deepEqual(convertValue(p["ユーザー1"], [{ code: "someone", name: "誰か" }, "unknown"], w, users), [{ code: "someone", name: "誰か" }, { code: "unknown", name: "unknown" }]);
  throwsInput(() => convertValue(p["ユーザー1"], [1], w, users), /コード（文字列）か \{ code, name\? \}/);
  assert.deepEqual(convertValue(p["組織1"], "demo_hq", w, users), [{ code: "demo_hq", name: users.orgCodes.demo_hq.name }]);
  assert.deepEqual(convertValue(p["作成者"], "demo_user03", w, users), { code: "demo_user03", name: users.userCodes.demo_user03.name });
  throwsInput(() => convertValue(p["作成者"], ["a", "b"], w, users), /ユーザーのコード 1 つ/);
  assert.deepEqual(convertValue(p["添付1"], ["a.pdf"], w, users), [{ contentType: "application/octet-stream", fileKey: "", name: "a.pdf", size: "0" }]);
  assert.deepEqual(convertValue(p["カテゴリー"], "c1", w, users), ["c1"]);
  assert.equal(convertValue(p["ステータス"], "処理中", w, users), "処理中");
  throwsInput(() => convertValue(p["テーブル1"], [], w, users), /テーブルは行の配列/);
  throwsInput(() => convertValue(p["グループ枠1"], 1, w, users), /GROUP は値を持たない/);
});

test("レコードを合成する: 空のレコード、土台への当てはめ（テーブルの行、足した項目の補い）、誤りは名指し", () => {
  const f = fields();
  const empty = emptyRecordOf(f, "7");
  assert.deepEqual(empty.$id, { type: "__ID__", value: "7" });
  assert.deepEqual([empty["レコード番号"].value, empty["数値1"].value, empty["チェック1"].value, empty["テーブル1"].value, empty["作成者"].value, empty["作成日時"].value], ["7", "", [], [], { code: "", name: "" }, "2026-01-15T00:00:00Z"]);
  assert.equal("グループ枠1" in empty, false, "グループ枠はレコードに無い");
  const rec = applyData(f, SAMPLE_APP.records[2].record, { 数値1: 1, テーブル1: [{ T1_数値: 10, T1_文字列: "a" }, {}], ユーザー1: "demo_user01" }, "data[0]", users);
  assert.equal(rec["数値1"].value, "1");
  assert.equal(rec["数値2"].value, SAMPLE_APP.records[2].record["数値2"].value, "書かない項目は土台のまま");
  assert.equal(rec["テーブル1"].value.length, 2);
  assert.deepEqual([rec["テーブル1"].value[0].id, rec["テーブル1"].value[0].value["T1_数値"], rec["テーブル1"].value[0].value["T1_文字列"].value, rec["テーブル1"].value[1].value["T1_数値"].value], ["1", { type: "NUMBER", value: "10" }, "a", ""]);
  assert.equal(Object.keys(rec["テーブル1"].value[1].value).length, Object.keys(f.properties["テーブル1"].fields).length, "書かない子は空で補う");
  assert.equal(SAMPLE_APP.records[2].record["数値1"].value, "", "土台は変えない");
  const ext = extendFields(f, [{ code: "単価", type: "NUMBER" }, { code: "T1_金額", type: "NUMBER", table: "テーブル1" }]).fields;
  const filled = fillMissing(ext, SAMPLE_APP.records[0].record);
  assert.deepEqual(filled["単価"], { type: "NUMBER", value: "" });
  assert.deepEqual(filled["テーブル1"].value[0].value["T1_金額"], { type: "NUMBER", value: "" });
  const rec2 = applyData(ext, SAMPLE_APP.records[0].record, { 単価: 5, テーブル1: [{ T1_金額: 9 }] }, "data[1]", users);
  assert.deepEqual([rec2["単価"].value, rec2["テーブル1"].value[0].value["T1_金額"].value], ["5", "9"]);
  throwsInput(() => applyData(f, empty, { 無い: 1 }, "data[0]", users), /data\[0\]\.無い: 無い項目/);
  throwsInput(() => applyData(f, empty, { T1_数値: 1 }, "data[0]", users), /テーブルの子はテーブルの行の中に書く（テーブル1: \[\{ T1_数値: … \}\]）/);
  throwsInput(() => applyData(f, empty, { テーブル1: [{ 無い: 1 }] }, "data[0]", users), /data\[0\]\.テーブル1\[0\]\.無い: テーブル テーブル1 に無い子/);
  throwsInput(() => applyData(f, empty, { テーブル1: {} }, "data[0]", users), /テーブルは行の配列/);
  throwsInput(() => applyData(f, empty, { テーブル1: Array.from({ length: 21 }, () => ({})) }, "data[0]", users), /20 行まで/);
  throwsInput(() => applyData(f, empty, [], "data[0]", users), /レコードはオブジェクト/);
  throwsInput(() => checkDataList([]), /data が空/);
  throwsInput(() => checkDataList([{}, {}, {}, {}, {}, {}]), /5 件まで/);
  throwsInput(() => checkDataList({}), /配列/);
});
