import { test } from "node:test";
import assert from "node:assert/strict";
import { usedFieldCodes, narrowRecord, shapeLines } from "../src/commands/record.ts";
import { EXPORT } from "./fixtures.mjs";

test("usedFieldCodes: 設定の計算式が使う項目（有効な行の fieldcode と、計算式の識別子）", () => {
  const codes = usedFieldCodes(EXPORT());
  assert.ok(codes.has("金額合計"));
  assert.ok(codes.size >= 5);
  assert.equal(usedFieldCodes({ foo: 1 }), null);
});

test("narrowRecord と shapeLines: $id は残す、テーブルは使う子だけ、値は出さない", () => {
  const record = {
    $id: { type: "RECORD_NUMBER", value: "3" },
    金額: { type: "NUMBER", value: "100" },
    備考: { type: "SINGLE_LINE_TEXT", value: "秘密" },
    明細: { type: "SUBTABLE", value: [{ id: "1", value: { 品: { type: "SINGLE_LINE_TEXT", value: "A" }, 数: { type: "NUMBER", value: "2" } } }] }
  };
  const n = narrowRecord(record, new Set(["金額", "数"]));
  assert.deepEqual(Object.keys(n.record), ["$id", "金額", "明細"]);
  assert.deepEqual(Object.keys(n.record.明細.value[0].value), ["数"]);
  assert.deepEqual(n.kept, ["金額", "明細(数)"]);
  const lines = shapeLines(record);
  assert.ok(lines.some((l) => l.startsWith("明細  SUBTABLE  1 行")));
  assert.ok(!lines.join("\n").includes("秘密"), "値は出さない");
});
