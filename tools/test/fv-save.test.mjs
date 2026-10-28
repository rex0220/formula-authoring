/**
 * 項目検証の設定の保存（tools 0.6.0。formula MCP の fv_save_settings / fv_update_rows の本体。src/fv/save.ts）:
 * 新しい設定の ok / conflict / invalid / denied、行の差し替えと追加（digest、rows、common、tblfields、fv normalize のエラーでは変えない、差）、
 * アプリのフォルダー（接続のファイルの形）の -edit.json。評価は inline（主スレッド）で行い、1 件だけ Worker でも確かめる
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ZIP } from "./helpers.mjs";
import { EXPORT } from "./fixtures.mjs";
import { makeConnWorkspace } from "./conn-helper.mjs";
import { commit, digestOf } from "../src/commands/save.ts";
import { lockPathFor } from "../src/commit-file.ts";
import { fvSaveNewSettings, fvUpdateRows } from "../src/fv/save.ts";
import { DEFAULT_POLICY } from "../src/normalize/policy.ts";
import { realResolve } from "../src/safe-path.ts";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const SOURCE = { pluginZip: PLUGIN_ZIP, mode: "dev" };
const FIX = path.join(import.meta.dirname, "fixtures", "fv");
const read = (name) => JSON.parse(readFileSync(path.join(FIX, name), "utf8"));
const APP = 900;
const FIELDS = () => ({ tool: "formula-authoring fields", fetchedAt: "2026-10-28T00:00:00.000Z", baseUrl: "https://example.cybozu.com", appId: APP, appName: "架空の申請", preview: false, lang: "ja", revision: "1", properties: read("fields.json").properties, layout: read("layout.json").layout });
const envelope = (infos, extra = {}) => ({ date: "2026-10-28 09:00:00", pluginName: "項目検証プラグイン", pluginID: "rex0220 field validation plugin", PluginVersion: "72", appId: APP, appName: "架空の申請", pluginEnable: true, pluginInfos: infos, ...extra });
const GOOD = () => [
  { fieldcode: "氏名", state: true, formulaSet: "1", disabledSet: "", hideSet: "", init: false, condInfos: [{ state: true, condSet: '氏名 = "test"', jaSet: '"test は使えません"', enSet: "", zhSet: "" }] },
  { fieldcode: "金額", state: true, formulaSet: '区分 = "A"', disabledSet: "", hideSet: "", init: false, condInfos: [] }
];
const content = (infos = GOOD(), extra = {}) => JSON.stringify(envelope(infos, extra));
const rowsJson = (...rows) => JSON.stringify(rows);
const fileDigest = (file) => digestOf(readFileSync(file));
const rowOf = (file, code) => JSON.parse(readFileSync(file, "utf8")).pluginInfos.find((r) => r.fieldcode === code);

/** 1 接続の形の作業フォルダー（fields/900.json を置く） */
function makeSingle() {
  const root = realResolve(".", mkdtempSync(path.join(os.tmpdir(), "fv-save-")));
  mkdirSync(path.join(root, "fields"));
  writeFileSync(path.join(root, "fields", `${APP}.json`), JSON.stringify(FIELDS()));
  const ctx = { root, mode: { kind: "single" }, policy: DEFAULT_POLICY, source: SOURCE, run: { inline: true } };
  return { root, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("新しい設定: ok（元の値の封筒を書く。派生値なし）、同じ名前は conflict、fv normalize のエラー・計算式の封筒・expectedAbsent なしは invalid、ダウンロード / -edit.json の名前は denied", { skip }, async () => {
  const ws = makeSingle();
  try {
    const r = await fvSaveNewSettings(ws.ctx, { path: "temp/fv.json", content: content(), expectedAbsent: true });
    assert.equal(r.status, "ok", r.message);
    const file = path.join(ws.root, "temp", "fv.json");
    assert.equal(r.path, "temp/fv.json");
    assert.equal(r.digest, fileDigest(file));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.pluginID, "rex0220 field validation plugin");
    assert.ok(!("pluginFields" in saved) && !("pluginPP" in saved), "派生値は書かない");
    assert.match(r.summary, /エラー 0/);

    const again = await fvSaveNewSettings(ws.ctx, { path: "temp/fv.json", content: content(), expectedAbsent: true });
    assert.deepEqual([again.status, again.code], ["conflict", "ConflictError"]);
    assert.match(again.message, /fv_update_rows/);

    const bad = await fvSaveNewSettings(ws.ctx, { path: "settings/bad.json", content: content([{ fieldcode: "金額", state: true, formulaSet: "TLTABLE(1) > 0" }]), expectedAbsent: true });
    assert.deepEqual([bad.status, bad.code], ["invalid", "NormalizeError"]);
    assert.ok(bad.findings.some((f) => f.level === "error" && f.rule === "formula.update"), JSON.stringify(bad.findings));
    assert.ok(!existsSync(path.join(ws.root, "settings", "bad.json")));

    const formula = await fvSaveNewSettings(ws.ctx, { path: "settings/f.json", content: JSON.stringify(EXPORT()), expectedAbsent: true });
    assert.deepEqual([formula.status, formula.code], ["invalid", "InputError"]);
    assert.match(formula.message, /項目検証の設定ではない.*fml_save_settings/);
    const noFlag = await fvSaveNewSettings(ws.ctx, { path: "settings/x.json", content: content(), expectedAbsent: false });
    assert.equal(noFlag.status, "invalid");

    for (const name of [`rex0220-field-validation-app${APP}-20261028-120000.json`, `rex0220-field-validation-app${APP}-20261028-120000-edit.json`, "rex0220-formula-app900-20261028-120000.json"]) {
      const d = await fvSaveNewSettings(ws.ctx, { path: `settings/${name}`, content: content(), expectedAbsent: true });
      assert.deepEqual([d.status, d.code], ["denied", "PermissionError"], name);
    }
  } finally {
    ws.cleanup();
  }
});

test("行の差し替え・追加: digest の照合、行のキーごとの差し替え、無い行は足す（省いた値は補う）、tblfields・condInfos は丸ごと、common、差（fvDiff）", { skip }, async () => {
  const ws = makeSingle();
  try {
    const saved = await fvSaveNewSettings(ws.ctx, { path: "settings/fv.json", content: content(), expectedAbsent: true });
    assert.equal(saved.status, "ok", saved.message);
    const file = path.join(ws.root, "settings", "fv.json");

    const stale = await fvUpdateRows(ws.ctx, { path: "settings/fv.json", expectedDigest: "0".repeat(64), rows: rowsJson({ fieldcode: "金額", formulaSet: "1" }) });
    assert.deepEqual([stale.status, stale.code], ["conflict", "ConflictError"]);
    assert.match(stale.message, /fv_summary/);

    const r = await fvUpdateRows(ws.ctx, {
      path: "settings/fv.json", expectedDigest: saved.digest,
      rows: rowsJson({ fieldcode: "金額", formulaSet: '区分 = "B"' }, { fieldcode: "備考", hideSet: '区分 = "B"', init: true }, { fieldcode: "明細", tblfields: [{ fieldcode: "数量", state: true, hideSet: '区分 = "A"' }] }),
      common: JSON.stringify({ pluginComment: "メモ" })
    });
    assert.equal(r.status, "ok", r.message);
    assert.equal(r.digest, fileDigest(file));
    assert.deepEqual([...r.fvDiff.changed].sort(), ["備考", "明細", "金額"].sort(), r.fvDiff.lines.join("\n"));
    const after = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(after.pluginComment, "メモ");
    assert.equal(rowOf(file, "金額").formulaSet, '区分 = "B"');
    assert.equal(rowOf(file, "氏名").condInfos.length, 1, "触らない行はそのまま");
    assert.deepEqual([rowOf(file, "備考").hideSet, rowOf(file, "備考").init, rowOf(file, "備考").state], ['区分 = "B"', true, true], "足した行の state は省けば true、ほかは既定を補う");
    assert.deepEqual(rowOf(file, "明細").tblfields.find((t) => t.fieldcode === "数量").hideSet, '区分 = "A"');
    // condInfos は丸ごと（空にすれば検証条件が無くなる）
    const r2 = await fvUpdateRows(ws.ctx, { path: "settings/fv.json", expectedDigest: r.digest, rows: rowsJson({ fieldcode: "氏名", condInfos: [] }) });
    assert.equal(r2.status, "ok", r2.message);
    assert.deepEqual(rowOf(file, "氏名").condInfos, []);
  } finally {
    ws.cleanup();
  }
});

test("行の差し替えの誤り: 行の元の値でないキー・重複・common の封筒のキーは invalid、更新系の関数は fv normalize で止めてファイルを変えない、計算式の設定・ダウンロードのファイルは直さない", { skip }, async () => {
  const ws = makeSingle();
  try {
    const saved = await fvSaveNewSettings(ws.ctx, { path: "settings/fv.json", content: content(), expectedAbsent: true });
    const file = path.join(ws.root, "settings", "fv.json");
    const before = readFileSync(file, "utf8");
    const upd = (rows, extra = {}) => fvUpdateRows(ws.ctx, { path: "settings/fv.json", expectedDigest: saved.digest, rows, ...extra });

    const unknown = await upd(rowsJson({ fieldcode: "金額", rank: 1 }));
    assert.deepEqual([unknown.status, unknown.code], ["invalid", "InputError"]);
    assert.match(unknown.message, /行の元の値でないキーがある: rank/);
    const dup = await upd(rowsJson({ fieldcode: "金額", formulaSet: "1" }, { fieldcode: "金額", formulaSet: "" }));
    assert.match(dup.message, /重複/);
    const fixed = await upd(rowsJson({ fieldcode: "金額", formulaSet: "1" }), { common: JSON.stringify({ appId: 1 }) });
    assert.deepEqual([fixed.status, fixed.code], ["invalid", "InputError"]);
    const update = await upd(rowsJson({ fieldcode: "金額", formulaSet: 'FSET("備考", "x") = 1' }));
    assert.deepEqual([update.status, update.code], ["invalid", "NormalizeError"]);
    assert.ok(update.findings.some((f) => f.rule === "formula.update"));
    assert.equal(readFileSync(file, "utf8"), before, "ファイルは変えていない");

    writeFileSync(path.join(ws.root, "settings", "f.json"), JSON.stringify(EXPORT()));
    const formula = await fvUpdateRows(ws.ctx, { path: "settings/f.json", expectedDigest: fileDigest(path.join(ws.root, "settings", "f.json")), rows: rowsJson({ fieldcode: "金額", formulaSet: "1" }) });
    assert.deepEqual([formula.status, formula.code], ["invalid", "InputError"]);
    const snap = `rex0220-field-validation-app${APP}-20261028-120000.json`;
    writeFileSync(path.join(ws.root, "settings", snap), before);
    const d = await fvUpdateRows(ws.ctx, { path: `settings/${snap}`, expectedDigest: digestOf(before), rows: rowsJson({ fieldcode: "金額", formulaSet: "1" }) });
    assert.deepEqual([d.status, d.code], ["denied", "PermissionError"]);
  } finally {
    ws.cleanup();
  }
});

test("アプリのフォルダー（接続のファイルの形）: 同じフォルダーの fields.json で検査、-edit.json は Worker 経由で直せる、別の fields は denied", { skip }, async () => {
  const cws = makeConnWorkspace(undefined, "fv-conn-ws-");
  try {
    const dir = cws.appFolder("dev", APP, "架空の申請", FIELDS());
    const relDir = path.relative(cws.root, dir).replace(/\\/g, "/");
    const ctx = { root: cws.root, mode: cws.mode(), policy: DEFAULT_POLICY, source: SOURCE, run: { inline: true } };
    const r = await fvSaveNewSettings(ctx, { path: `${relDir}/new.json`, content: content(), expectedAbsent: true });
    assert.equal(r.status, "ok", r.message);
    const other = await fvSaveNewSettings(ctx, { path: `${relDir}/new2.json`, content: content(), fields: "fields/x.json", expectedAbsent: true });
    assert.deepEqual([other.status, other.code], ["denied", "PermissionError"]);
    const edit = `rex0220-field-validation-app${APP}-20261028-120000-edit.json`;
    writeFileSync(path.join(dir, edit), content());
    const u = await fvUpdateRows({ ...ctx, run: { timeoutSec: 60 } }, { path: `${relDir}/${edit}`, expectedDigest: digestOf(content()), rows: rowsJson({ fieldcode: "金額", formulaSet: "1" }) });
    assert.equal(u.status, "ok", u.message);
    assert.deepEqual(u.fvDiff.changed, ["金額"]);
  } finally {
    cws.cleanup();
  }
});

test("ロックを失ったときの文: 読み直すツールの名前（計算式は fml_summary、項目検証は fv_summary）を案内する（0.6.0 で計算式の文から名前が消えていたのを直した）", () => {
  const ws = makeSingle();
  try {
    mkdirSync(path.join(ws.root, "settings"));
    for (const [readAgain, args] of [["fml_summary", []], ["fv_summary", ["fv_summary"]]]) {
      const target = path.join(ws.root, "settings", `${readAgain}.json`);
      // 確定の直前の確かめの間に、別の保存がロックを取り直した
      assert.throws(() => commit(ws.ctx, target, "{}\n", "new", () => writeFileSync(lockPathFor(target), "other"), ...args), (e) => e.message.includes(`${readAgain} で読み直してやり直す`));
      assert.ok(!existsSync(target), "確定しない");
    }
  } finally {
    ws.cleanup();
  }
});
