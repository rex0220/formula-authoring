/** 機械生成の文書（docs/ と samples/users.json）が、今の zip から作ったものと一致するか（ずれていたら tools/ で npm run gen-docs） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import { REPO_ROOT } from "../src/paths.ts";
import { DEFAULT_USERS } from "../src/users/index.ts";
import { schemaRevisionOf } from "../src/meta.ts";
import { generateDocs } from "../scripts/gen-docs.mjs";
import { generateVerification } from "../scripts/verify-patterns.mjs";
import { trySettings } from "../src/commands/try.ts";
import { defaultUsersInfo } from "../src/users/index.ts";
import { quiet } from "../src/input.ts";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;

test("docs の機械生成が最新（schema-manifest / 設定ファイル仕様 / 関数一覧 / functions.json / 既定のテストデータ / samples/users.json）", { skip }, async () => {
  const engine = await loadEngine();
  const files = generateDocs(engine, { DEFAULT_USERS, schemaRevisionOf });
  const stale = [];
  for (const [rel, text] of files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== text) stale.push(rel);
  }
  assert.deepEqual(stale, [], "tools/ で npm run gen-docs を実行して作り直す");
  const manifest = JSON.parse(files.get("docs/schema-manifest.json"));
  assert.equal(manifest.generatedFrom.schemaRevision, schemaRevisionOf(engine.api.CONFIG_SCHEMA));
  assert.ok(files.get("docs/関数一覧.md").includes("| `FSET` |"));
});

test("計算パターンの検証（docs/計算パターン_検証.md）が最新で、ケースが全部一致する（エンジンの版が変わったときの回帰検査。工程 8-4）", { skip }, async () => {
  const engine = await loadEngine();
  const v = await generateVerification({ engine, trySettings, defaultUsersInfo, quiet });
  assert.equal(v.summary.ng, 0, `期待と合わないケースがある（docs/計算パターン_検証.md の ✘ を見る）: ${v.summary.ng}`);
  assert.ok(v.summary.cases >= 20 && v.summary.formulas >= 40, JSON.stringify(v.summary));
  assert.ok(v.summary.examples.ok > 300, JSON.stringify(v.summary.examples));
  const stale = [];
  for (const [rel, text] of v.files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== text) stale.push(rel);
  }
  assert.deepEqual(stale, [], "tools/ で npm run gen-docs を実行して作り直す");
});

test("項目検証の資料（docs/項目検証/ の設定ファイル仕様・検証パターン、samples/項目検証/settings-source.json）が最新で、検証パターンが全部 ✔", { skip }, async () => {
  const engine = await loadEngine();
  const fv = Object.assign({}, ...(await Promise.all(["meta.ts", "model.ts", "normalize.ts", "check.ts"].map((f) => import(`../src/fv/${f}`)))));
  const { generateFvDocs } = await import("../scripts/gen-fv-docs.mjs");
  const r = await generateFvDocs({ engine, fv, defaultUsersInfo, repo: REPO_ROOT });
  assert.equal(r.summary.ng, 0, `期待と合わない検証パターンがある（docs/項目検証/検証パターン.md の ✘）: ${JSON.stringify(r.summary)}`);
  assert.ok(r.summary.patterns >= 14 && r.summary.checks >= 38, JSON.stringify(r.summary));
  const stale = [];
  for (const [rel, text] of r.files) {
    const abs = path.join(REPO_ROOT, rel);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== text) stale.push(rel);
  }
  assert.deepEqual(stale, [], "tools/ で npm run gen-docs を実行して作り直す");
});
