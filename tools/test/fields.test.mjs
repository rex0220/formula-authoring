import { test } from "node:test";
import assert from "node:assert/strict";
import { listFields, summarizeFields, contextTargetsOf } from "../src/commands/fields.ts";
import { FIELDS_FILE } from "./fixtures.mjs";

test("fields --summary: レイアウトの順、テーブルの子は字下げ、○ / － の印、一覧の数", () => {
  const file = FIELDS_FILE();
  const s = listFields(file, { targetTypes: new Set(["NUMBER", "SINGLE_LINE_TEXT", "SUBTABLE", "CALC"]) });
  assert.match(s, /^アプリ 2305 テーブル内集計（preview、lang=ja/);
  assert.match(s, /○ = 計算式を設定できる型/);
  assert.ok(/\n  \S+.*NUMBER/.test(s), "テーブルの子が字下げ");
  assert.ok(/  ○/.test(s) && /  －/.test(s));
  const plain = listFields(file);
  assert.ok(!/○ = /.test(plain), "targetTypes が無ければ印なし");
  assert.match(summarizeFields(file), /項目 11（/);
  // テーブルの子はレイアウトの順（左から右 = ランクなしの計算順）。properties の順（API はオブジェクトなので順が違うことがある）ではない
  const t = {
    ...file, appId: 1, appName: "t",
    properties: { テーブル: { type: "SUBTABLE", code: "テーブル", label: "テーブル", fields: { 備考: { type: "SINGLE_LINE_TEXT", code: "備考", label: "備考" }, 金額: { type: "NUMBER", code: "金額", label: "金額" }, 日付: { type: "DATE", code: "日付", label: "日付" } } } },
    layout: [{ type: "SUBTABLE", code: "テーブル", fields: [{ type: "DATE", code: "日付" }, { type: "NUMBER", code: "金額" }] }]
  };
  const lines = listFields(t).split("\n").filter((l) => l.startsWith("  "));
  assert.deepEqual(lines.map((l) => l.trim().split(/\s+/)[0]), ["日付", "金額", "備考"], "レイアウトの順、レイアウトに無い子は後ろ");
});

test("contextTargetsOf: ルックアップ先と関連レコード一覧の先", () => {
  const props = {
    顧客: { type: "SINGLE_LINE_TEXT", code: "顧客", label: "顧客", lookup: { relatedApp: { app: "77" }, relatedKeyField: "名前", fieldMappings: [] } },
    関連: { type: "REFERENCE_TABLE", code: "関連", label: "関連", referenceTable: { relatedApp: { app: "88" } } },
    権限なし: { type: "REFERENCE_TABLE", code: "権限なし", label: "権限なし", referenceTable: null },
    明細: { type: "SUBTABLE", code: "明細", label: "明細", fields: { 品: { type: "SINGLE_LINE_TEXT", code: "品", label: "品", lookup: { relatedApp: { app: "99" } } } } }
  };
  assert.deepEqual(contextTargetsOf(props), { lookupTargets: { 顧客: 77, 品: 99 }, relatedTargets: { 関連: 88 } });
});
