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
  await assert.rejects(runEval(job(EXPORT(), { pluginZip: PLUGIN_ZIP + ".missing" }), { timeoutSec: 30 }), (e) => e instanceof EvalError && e.innerName === "PluginZipError" && e.code === "missing" && e.kind === "zip");
  const out = await runEval(job({ not: "settings" }, { kind: "calc", calc: { appId: 2305, records: [] } }), { timeoutSec: 30 });
  assert.equal(out.normalize.hasErrors, true);
  assert.equal(out.calc, undefined);
});

// ---- tools 0.2.0（計画 24.4 / 24.5）: 結果の findings と calc の行、Worker の入口（workerFile）、出力の受け取り（captureOutput）、vendorDir ----
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("Worker: 結果に findings（検査の一覧）と calc のレコードごとの行が入る（MCP が構造のまま返す）", { skip }, async () => {
  const record = { $id: { type: "RECORD_NUMBER", value: "1" }, 商品セット: { type: "CHECK_BOX", value: [] }, 金額合計: { type: "NUMBER", value: "" }, テーブル: { type: "SUBTABLE", value: [] } };
  const out = await runEval(job(EXPORT(), { kind: "calc", calc: { appId: 2305, records: [{ id: "1", record }] } }), { timeoutSec: 60 });
  assert.equal(out.normalize.hasErrors, false, out.normalize.summary);
  assert.ok(out.normalize.findings.some((f) => f.level === "info" && f.rule === "envelope.version"), "findings");
  assert.equal(out.normalize.appId, 2305);
  assert.ok(out.normalize.size && out.normalize.size.bytes > 0);
  assert.ok(out.calc);
  assert.equal(out.calc.records.length, 1);
  assert.equal(out.calc.records[0].id, "1");
  assert.ok(out.calc.records[0].lines.some((l) => l.fieldcode === "金額合計"), JSON.stringify(out.calc.records[0].lines));
  assert.equal(typeof out.calc.contextLine, "string");
  assert.equal(typeof out.calc.notice, "string");
});

test("Worker: workerFile で入口を指定でき、captureOutput で Worker の標準出力・標準エラーを受け取る（親の標準出力に流さない）。入口が無ければ誤り", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "formula-worker-"));
  try {
    const entry = path.join(dir, "fake-worker.mjs");
    writeFileSync(entry, [
      'import { parentPort } from "node:worker_threads";',
      'console.log("noise-from-worker");',
      'process.stderr.write("warn-from-worker\\n");',
      'setTimeout(() => parentPort.postMessage({ ok: true, outcome: { normalize: { summary: "fake", hasErrors: false, warnings: 0, findings: [] }, engineWarnings: [] } }), 50);'
    ].join("\n"));
    const got = [];
    const out = await runEval(job(EXPORT()), { timeoutSec: 10, workerFile: entry, captureOutput: (chunk, stream) => got.push([stream, chunk.trim()]) });
    assert.equal(out.normalize.summary, "fake");
    assert.ok(got.some(([s, c]) => s === "stdout" && c === "noise-from-worker"), JSON.stringify(got));
    assert.ok(got.some(([s, c]) => s === "stderr" && c === "warn-from-worker"), JSON.stringify(got));
    await assert.rejects(runEval(job(EXPORT()), { timeoutSec: 10, workerFile: path.join(dir, "none.mjs") }), /Worker の入口が無い/);
    await assert.rejects(runEval(job(EXPORT()), { timeoutSec: 10, workerFile: "relative/worker.mjs" }), /絶対パス/);
    void pathToFileURL;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Worker: 本物の入口でも captureOutput を付けて結果が戻る。vendorDir は job で Worker に渡る（無い場所なら moment が無い）", { skip }, async () => {
  const got = [];
  const out = await runEval(job(EXPORT()), { timeoutSec: 60, captureOutput: (chunk, stream) => got.push([stream, chunk]) });
  assert.equal(out.normalize.hasErrors, false, out.normalize.summary);
  const dir = mkdtempSync(path.join(os.tmpdir(), "formula-vendor-"));
  try {
    await assert.rejects(runEval(job(EXPORT(), { vendorDir: dir }), { timeoutSec: 60 }), (e) => e instanceof EvalError && /moment が無い/.test(e.message) && e.message.includes(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Worker の中の誤りの種類（kind）は instanceof で決まる: name を偽装した Error は other、中核の InputError は input（Codex の r2 レビュー R1）", async () => {
  const { classifyEvalError } = await import("../src/worker/eval-run.ts");
  const { InputError } = await import("../src/input.ts");
  const { PluginZipError } = await import("../src/plugin-zip.ts");
  const forged = Object.assign(new Error("RECORD-VALUE in message"), { name: "InputError" });
  assert.deepEqual(classifyEvalError(forged), { kind: "other", name: "Error", message: "RECORD-VALUE in message" }, "name は使わない（固定の名前）");
  // name と constructor.name に値を入れた例外（zip のコードができること）も、名前は組み込みの種類だけ（Codex の r3 レビュー N1）
  const t = Object.assign(new TypeError("x"), { name: "SECRET-IN-NAME" });
  assert.deepEqual(classifyEvalError(t), { kind: "other", name: "TypeError", message: "x" });
  class Evil extends RangeError {}
  Object.defineProperty(Evil, "name", { value: "SECRET-CTOR" });
  assert.deepEqual(classifyEvalError(new Evil("y")), { kind: "other", name: "RangeError", message: "y" });
  assert.equal(classifyEvalError({ name: "SECRET", message: "z", constructor: { name: "SECRET" } }).name, "Error");
  assert.deepEqual(classifyEvalError(new InputError("fields が要る")), { kind: "input", name: "InputError", message: "fields が要る" });
  assert.deepEqual(classifyEvalError(new PluginZipError("zip が無い", "missing")), { kind: "zip", name: "PluginZipError", message: "zip が無い", code: "missing" });
  assert.equal(classifyEvalError("x").kind, "other");
  // inline でも同じ形（kind 付きの EvalError）
  await assert.rejects(runEval(job({ not: "settings" }, { pluginZip: PLUGIN_ZIP + ".missing" }), { inline: true, timeoutSec: 5 }), (e) => e instanceof EvalError && e.kind === "zip");
});
