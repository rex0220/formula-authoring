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
