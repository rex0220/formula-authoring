import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSettings, bodyOf, rowsOf } from "../src/commands/summary.ts";
import { diffSettings } from "../src/commands/diff.ts";
import { EXPORT } from "./fixtures.mjs";

test("summary: 封筒の見出し、件数、ランク順の一覧（80 字で切る）、--field で全文", () => {
  const env = EXPORT();
  const s = summarizeSettings(env, "settings/a.json");
  assert.match(s, /^settings\/a\.json: 計算式プラグイン Ver\.100、アプリ 2305 テーブル内集計/);
  assert.match(s, /項目 \d+、計算式あり \d+（有効 \d+、無効 \d+）/);
  assert.match(s, /計算式（計算の順 = ランクの大きい順/);
  assert.ok(!/pluginFields|pluginPP/.test(s), "派生値は出さない");
  const one = summarizeSettings(env, "settings/a.json", { field: "金額合計" });
  assert.match(one, /金額合計: 有効/);
  assert.match(one, /計算式:\n/);
  assert.throws(() => summarizeSettings(env, "a.json", { field: "無い項目" }), /項目 無い項目 の設定が無い/);
  assert.equal(rowsOf(bodyOf(env), "a.json").length, env.pluginInfos.length);
});

test("diff: 項目の追加・削除・変更と共通の設定の差。計算式が変わった項目に ★", () => {
  const a = EXPORT();
  const b = JSON.parse(JSON.stringify(a));
  const row = b.pluginInfos.find((r) => r.fieldcode === "金額合計");
  row.formulaSet = row.formulaSet + " + 1";
  const no = b.pluginInfos.find((r) => r.fieldcode === "No");
  no.hide = !no.hide;
  b.pluginInfos.push({ fieldcode: "新規", state: true, formulaSet: "1", edit: false, hide: false, rank: "" });
  b.pluginMiscInfo.async = !b.pluginMiscInfo.async;
  const r = diffSettings(a, b, { before: "a.json", after: "b.json" });
  const by = Object.fromEntries(r.fields.map((f) => [f.fieldcode, f]));
  assert.deepEqual(by["金額合計"].keys, ["formulaSet"]);
  assert.equal(by["金額合計"].affectsRecords, true);
  assert.deepEqual(by["No"].keys, ["hide"]);
  assert.equal(by["No"].affectsRecords, false);
  assert.equal(by["新規"].kind, "added");
  assert.ok(r.common.some((c) => c.startsWith("pluginMiscInfo.async:")));
  assert.ok(r.lines.some((l) => l.startsWith("★ = 既存レコードの値に影響する項目（2）")));
  assert.deepEqual(diffSettings(a, a, { before: "a", after: "b" }).fields, []);
});
