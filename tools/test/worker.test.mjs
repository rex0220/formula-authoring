/** 評価の Worker: 結果を返す、時間上限で止める（Codex レビュー BLOCKER 1） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PLUGIN_ZIP } from "./helpers.mjs";
import { runEval, EvalTimeoutError, EvalError } from "../src/worker/run.ts";
import { DEFAULT_USERS } from "../src/users/index.ts";
import { DEFAULT_POLICY } from "../src/normalize/policy.ts";
import { EXPORT, FIELDS_FILE } from "./fixtures.mjs";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const job = (settings, extra = {}) => ({ kind: "normalize", pluginZip: PLUGIN_ZIP, mode: "dev", settingsText: JSON.stringify(settings), settingsFile: "s.json", fields: FIELDS_FILE(), usersSource: DEFAULT_USERS, usersOrigin: { kind: "default" }, policy: DEFAULT_POLICY, ...extra });

test("Worker: normalize の結果が戻る（主スレッドでは zip を読まない）", { skip }, async () => {
  const out = await runEval(job(EXPORT(), { check: true }), { timeoutSec: 60 });
  assert.equal(out.normalize.hasErrors, false, out.normalize.summary);
  assert.deepEqual(out.normalize.checkDiffs, []);
  assert.ok(out.normalize.output);
  assert.equal(globalThis.rex0220p, undefined, "主スレッドにエンジンを読まない");
});

test("Worker: 重い式は時間上限で止まる（terminate）", { skip }, async () => {
  const e = EXPORT();
  e.pluginInfos.find((r) => r.fieldcode === "金額合計").formulaSet = "ARRAY_COUNT(ARRAY_FOR(100000,i,ARRAY_FOR(100,j,i*j)))";
  const record = { $id: { type: "RECORD_NUMBER", value: "1" }, 商品セット: { type: "CHECK_BOX", value: [] }, 金額合計: { type: "NUMBER", value: "" }, テーブル: { type: "SUBTABLE", value: [] } };
  const t0 = Date.now();
  await assert.rejects(runEval(job(e, { kind: "calc", calc: { appId: 2305, records: [{ id: "1", record }] } }), { timeoutSec: 2 }), EvalTimeoutError);
  assert.ok(Date.now() - t0 < 10000, "数秒で止まる");
});

test("Worker: zip が無いなどの誤りは EvalError（元の名前つき）で戻り、normalize の検査の誤りは結果の findings で戻る", { skip }, async () => {
  await assert.rejects(runEval(job(EXPORT(), { pluginZip: PLUGIN_ZIP + ".missing" }), { timeoutSec: 30 }), (e) => e instanceof EvalError && e.innerName === "PluginZipError" && e.code === "missing");
  const out = await runEval(job({ not: "settings" }, { kind: "calc", calc: { appId: 2305, records: [] } }), { timeoutSec: 30 });
  assert.equal(out.normalize.hasErrors, true);
  assert.equal(out.calc, undefined);
});
