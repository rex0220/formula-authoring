/** engine の vendorDir（tools 0.2.0。MCP は束ねた本体の隣の vendor/ の moment を使う。計画 24.4）: 無い場所なら読まずに止まり、その後に正しい場所で読める */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import { momentFileOf } from "../src/engine.ts";
import { VENDOR_DIR, MOMENT_FILE } from "../src/paths.ts";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;

test("momentFileOf: vendorDir があればその中の同じ名前、無ければ tools の vendor/", () => {
  assert.equal(momentFileOf({}), MOMENT_FILE);
  assert.equal(momentFileOf({ vendorDir: "/x/vendor" }), path.join("/x/vendor", path.basename(MOMENT_FILE)));
});

test("loadEngine: vendorDir に moment が無ければ zip のコードを動かす前に止まり（restart-required にならない）、正しい vendorDir で読める", { skip }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "formula-vendor-"));
  try {
    await assert.rejects(loadEngine({ vendorDir: dir }), (e) => /moment が無い/.test(e.message) && e.message.includes(dir));
    assert.equal(globalThis.rex0220p, undefined, "エンジンを読んでいない");
    const engine = await loadEngine({ vendorDir: VENDOR_DIR });
    assert.equal(engine.api.apiVersion, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
