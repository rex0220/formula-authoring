import { test } from "node:test";
import assert from "node:assert/strict";
import { scanFormula, scanFormulas } from "../src/scan.ts";

test("走査: 関数の呼び出し（入れ子も）、識別子、文字列、文字列の中の関数名は拾わない", () => {
  const r = scanFormula('IF(数量 > 0, SUM(金額, 税) + LET(x, 1, FSET(x, x + 1)), "FSET(a) と \\"引用\\"") & 顧客名');
  assert.deepEqual(r.functions, { IF: 1, SUM: 1, LET: 1, FSET: 1 });
  assert.deepEqual([...r.identifiers].sort(), ["x", "数量", "税", "金額", "顧客名"].sort());
  assert.deepEqual(r.strings, ['FSET(a) と \\"引用\\"']);
  assert.deepEqual(r.problems, []);
});

test("走査: 数値・true / false は識別子にしない。空白を挟んだ呼び出し、$id、閉じていない括弧と文字列", () => {
  const r = scanFormula('ROUND (1.5) + $id + true + "abc');
  assert.deepEqual(r.functions, { ROUND: 1 });
  assert.deepEqual([...r.identifiers], ["$id"]);
  assert.ok(r.problems.some((p) => /閉じていない文字列/.test(p)));
  const r2 = scanFormula("IF(1, (2 + 3");
  assert.ok(r2.problems.some((p) => /閉じていない \(/.test(p)));
  assert.ok(scanFormula("1) + 2").problems.some((p) => /対応しない \)/.test(p)));
});

test("走査: 複数の式の合計", () => {
  const { byField, functions } = scanFormulas([{ fieldcode: "a", formula: "SUM(x)" }, { fieldcode: "b", formula: "SUM(y) + RAND()" }]);
  assert.deepEqual(functions, { SUM: 2, RAND: 1 });
  assert.deepEqual([...byField.get("b").identifiers], ["y"]);
});
