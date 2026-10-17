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
