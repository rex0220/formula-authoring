/**
 * 保存の約束（tools 0.2.0。計画 24.2.1 / 24.4。formula MCP の fml_save_settings / fml_update_fields の本体）:
 * 新しい設定の ok / conflict / invalid / denied、項目の行の差し替え（digest、rows、common、normalize のエラーでは変えない、ロック）、
 * アプリのフォルダー（kintone/ の下。接続のファイルの形だけ）。評価は inline（主スレッド）で行い、1 件だけ Worker でも確かめる
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ZIP } from "./helpers.mjs";
import { EXPORT, FIELDS_FILE } from "./fixtures.mjs";
import { makeConnWorkspace } from "./conn-helper.mjs";
import { MAX_SAVE_INPUT_BYTES, MAX_UPDATE_ROWS, digestOf, saveNewSettings, updateFields } from "../src/commands/save.ts";
import { DEFAULT_POLICY } from "../src/normalize/policy.ts";
import { acquireLock } from "../src/commit-file.ts";
import { realResolve } from "../src/safe-path.ts";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const SOURCE = { pluginZip: PLUGIN_ZIP, mode: "dev" };

/** 1 接続の形の作業フォルダー（fields/2305.json を置く） */
function makeSingle() {
  const root = realResolve(".", mkdtempSync(path.join(os.tmpdir(), "formula-save-")));
  mkdirSync(path.join(root, "fields"));
  writeFileSync(path.join(root, "fields", "2305.json"), JSON.stringify(FIELDS_FILE()));
  const ctx = { root, mode: { kind: "single" }, policy: DEFAULT_POLICY, source: SOURCE, run: { inline: true } };
  return { root, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const content = (overrides = {}) => JSON.stringify({ ...EXPORT(), ...overrides });
const rowsJson = (...rows) => JSON.stringify(rows);
const fileDigest = (file) => digestOf(readFileSync(file));

test("新しい設定: ok（digest は確定したファイル。settings/ が無くても作る。既定値を補った封筒を書く）、同じ名前は conflict、normalize のエラーは invalid（書かない）", { skip }, async () => {
  const ws = makeSingle();
  try {
    const r = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content(), expectedAbsent: true });
    assert.equal(r.status, "ok", r.message);
    const file = path.join(ws.root, "settings", "a.json");
    assert.equal(r.path, "settings/a.json");
    assert.equal(r.digest, fileDigest(file));
    const saved = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(saved.pluginID, "rex0220 formula plugin");
    assert.equal(saved.PluginVersion, "101", "normalize が zip の版にする");
    assert.ok(!("pluginFields" in saved), "派生値は書かない");
    assert.ok(Array.isArray(r.findings) && r.findings.length > 0, "findings（Ver.100 の情報、misc の警告など）");
    assert.match(r.summary, /エラー 0/);

    const again = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content(), expectedAbsent: true });
    assert.deepEqual([again.status, again.code], ["conflict", "ConflictError"]);

    const e = EXPORT();
    e.pluginInfos[0].formulaSet = "不明な項目 + 1";
    const bad = await saveNewSettings(ws.ctx, { path: "settings/bad.json", content: JSON.stringify(e), expectedAbsent: true });
    assert.deepEqual([bad.status, bad.code], ["invalid", "NormalizeError"]);
    assert.ok(bad.findings.some((f) => f.level === "error" && f.rule === "formula.ref"), JSON.stringify(bad.findings));
    assert.ok(!existsSync(path.join(ws.root, "settings", "bad.json")));
  } finally {
    ws.cleanup();
  }
});

test("新しい設定の入力の誤り: expectedAbsent が無い、大きすぎる、JSON でない、最上位が配列、項目定義が無い → invalid。設定の中身は文に出さない", { skip }, async () => {
  const ws = makeSingle();
  try {
    const noAbsent = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content(), expectedAbsent: false });
    assert.deepEqual([noAbsent.status, noAbsent.code], ["invalid", "InputError"]);
    const big = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: "x".repeat(MAX_SAVE_INPUT_BYTES + 1), expectedAbsent: true });
    assert.deepEqual([big.status, big.code], ["invalid", "InputError"]);
    const notJson = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: '{"pluginID": SECRET-VALUE', expectedAbsent: true });
    assert.deepEqual([notJson.status, notJson.code], ["invalid", "InputError"]);
    assert.doesNotMatch(notJson.message, /SECRET/);
    const arr = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: "[]", expectedAbsent: true });
    assert.deepEqual([arr.status, arr.code], ["invalid", "InputError"]);
    const noFields = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content({ appId: 9999 }), expectedAbsent: true });
    assert.deepEqual([noFields.status, noFields.code], ["invalid", "InputError"]);
    assert.match(noFields.message, /fields\/9999\.json/);
    const explicit = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content({ appId: 9999 }), fields: "fields/2305.json", expectedAbsent: true });
    assert.equal(explicit.status, "invalid", "封筒の appId と項目定義の appId が違うのは normalize のエラー");
    assert.equal(explicit.code, "NormalizeError");
    assert.ok(!existsSync(path.join(ws.root, "settings", "a.json")));
  } finally {
    ws.cleanup();
  }
});

test("新しい設定の denied: 書けない場所（requirements/、..、絶対パス）、ダウンロード / pull の名前、-edit.json の名前、接続のファイルが無いときの kintone/", { skip }, async () => {
  const ws = makeSingle();
  try {
    // 作業フォルダーの中を指す絶対パスは中核が受け付ける（MCP は入口の checkRelPath で断る。print-craft と同じ）
    for (const p of ["requirements/a.json", "../a.json", "/etc/a.json"]) {
      const r = await saveNewSettings(ws.ctx, { path: p, content: content(), expectedAbsent: true });
      assert.equal(r.status, "denied", p);
      assert.equal(r.code, "PathError", p);
    }
    const snap = await saveNewSettings(ws.ctx, { path: "settings/rex0220-formula-app2305-20261018-120000.json", content: content(), expectedAbsent: true });
    assert.deepEqual([snap.status, snap.code], ["denied", "PermissionError"]);
    const edit = await saveNewSettings(ws.ctx, { path: "settings/rex0220-formula-app2305-20261018-120000-edit.json", content: content(), expectedAbsent: true });
    assert.deepEqual([edit.status, edit.code], ["denied", "PermissionError"]);
    assert.match(edit.message, /fml_edit/);
    const kin = await saveNewSettings(ws.ctx, { path: "kintone/dev/2305-x/a.json", content: content(), expectedAbsent: true });
    assert.deepEqual([kin.status, kin.code], ["denied", "PermissionError"]);
    assert.ok(!existsSync(path.join(ws.root, "kintone")));
  } finally {
    ws.cleanup();
  }
});

test("項目の行の差し替え: rows（fieldcode で差し替え。複数まとめて）と common（キーごとに置き換え）→ ok と diff。digest が違えば conflict、無ければ conflict", { skip }, async () => {
  const ws = makeSingle();
  try {
    const saved = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content(), expectedAbsent: true });
    assert.equal(saved.status, "ok", saved.message);
    const file = path.join(ws.root, "settings", "a.json");
    const r = await updateFields(ws.ctx, {
      path: "settings/a.json", expectedDigest: saved.digest,
      rows: rowsJson({ fieldcode: "金額合計", formulaSet: "SUMIF(分類=\"小計\",金額)*2", rank: 5 }, { fieldcode: "数量", state: false }),
      common: JSON.stringify({ pluginEnable: false })
    });
    assert.equal(r.status, "ok", r.message);
    assert.equal(r.digest, fileDigest(file));
    const after = JSON.parse(readFileSync(file, "utf8"));
    const row = after.pluginInfos.find((x) => x.fieldcode === "金額合計");
    assert.deepEqual([row.formulaSet, row.rank], ["SUMIF(分類=\"小計\",金額)*2", 5]);
    assert.deepEqual(Object.keys(row).sort(), ["edit", "fieldcode", "formulaSet", "hide", "rank", "state"], "確定したファイルは元の値だけ（画面の値は設定画面が項目定義から補う）");
    assert.equal(after.pluginInfos.find((x) => x.fieldcode === "数量").state, false);
    assert.equal(after.pluginEnable, false);
    assert.equal(after.pluginInfos.length, 6, "行は増えない");
    assert.deepEqual(r.diff.fields.map((f) => [f.fieldcode, f.keys.sort(), f.affectsRecords]), [["金額合計", ["formulaSet", "rank"], true], ["数量", ["state"], true]]);
    assert.ok(r.diff.common.some((l) => /pluginEnable/.test(l)), JSON.stringify(r.diff.common));

    const stale = await updateFields(ws.ctx, { path: "settings/a.json", expectedDigest: saved.digest, rows: rowsJson({ fieldcode: "金額合計", rank: 1 }) });
    assert.deepEqual([stale.status, stale.code], ["conflict", "ConflictError"]);
    assert.equal(fileDigest(file), r.digest, "変えていない");
    const missing = await updateFields(ws.ctx, { path: "settings/none.json", expectedDigest: r.digest, rows: rowsJson({ fieldcode: "金額合計", rank: 1 }) });
    assert.deepEqual([missing.status, missing.code], ["conflict", "ConflictError"]);
  } finally {
    ws.cleanup();
  }
});

test("項目の行の差し替えの invalid: rows の形（配列でない、空、上限、オブジェクトでない、fieldcode が無い、画面のキー、重複、設定に無い fieldcode）、common（封筒のキー、pluginInfos、空、知らないキー）、normalize のエラー → ファイルは変えない", { skip }, async () => {
  const ws = makeSingle();
  try {
    const saved = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content(), expectedAbsent: true });
    const file = path.join(ws.root, "settings", "a.json");
    const up = (rows, common) => updateFields(ws.ctx, { path: "settings/a.json", expectedDigest: saved.digest, rows, ...(common !== undefined ? { common } : {}) });
    const cases = [
      ["{}", undefined, /配列/],
      ["[]", undefined, /空/],
      [JSON.stringify(Array.from({ length: MAX_UPDATE_ROWS + 1 }, (_, i) => ({ fieldcode: `f${i}` }))), undefined, /行まで/],
      ["[1]", undefined, /オブジェクト/],
      [rowsJson({ state: true }), undefined, /fieldcode/],
      [rowsJson({ fieldcode: "金額合計", type: "NUMBER", fieldlabel: "x" }), undefined, /type, fieldlabel/],
      [rowsJson({ fieldcode: "金額合計", rank: 1 }, { fieldcode: "金額合計", rank: 2 }), undefined, /重複/],
      [rowsJson({ fieldcode: "存在しない", rank: 1 }), undefined, /設定に無い fieldcode: 存在しない/],
      [rowsJson({ fieldcode: "金額合計", rank: 1 }), JSON.stringify({ appId: 1 }), /変えられないキー: appId/],
      [rowsJson({ fieldcode: "金額合計", rank: 1 }), JSON.stringify({ pluginInfos: [] }), /変えられないキー: pluginInfos/],
      [rowsJson({ fieldcode: "金額合計", rank: 1 }), "{}", /空/],
      [rowsJson({ fieldcode: "金額合計", rank: 1 }), "[]", /オブジェクト/],
      ["[{\"fieldcode\": SECRET", undefined, /rows を JSON として読めない/]
    ];
    for (const [rows, common, re] of cases) {
      const r = await up(rows, common);
      assert.deepEqual([r.status, r.code], ["invalid", "InputError"], `${rows} ${common}: ${r.message}`);
      assert.match(r.message, re);
      assert.doesNotMatch(r.message, /SECRET/);
    }
    const unknownKey = await up(rowsJson({ fieldcode: "金額合計", rank: 1 }), JSON.stringify({ pluginFoo: 1 }));
    assert.deepEqual([unknownKey.status, unknownKey.code], ["invalid", "NormalizeError"]);
    assert.ok(unknownKey.findings.some((f) => f.rule === "schema.unknown-key"));
    const badFormula = await up(rowsJson({ fieldcode: "金額合計", formulaSet: "不明な項目 + 1" }));
    assert.deepEqual([badFormula.status, badFormula.code], ["invalid", "NormalizeError"]);
    assert.ok(badFormula.findings.some((f) => f.rule === "formula.ref"));
    assert.equal(fileDigest(file), saved.digest, "どれもファイルを変えていない");
    const leftovers = (await import("node:fs")).readdirSync(path.join(ws.root, "settings")).filter((n) => n !== "a.json");
    assert.deepEqual(leftovers, [], "一時ファイルとロックを残さない");
  } finally {
    ws.cleanup();
  }
});

test("項目の行の差し替えの denied / conflict: ダウンロード / pull のファイル、計算式プラグインの設定でないファイル、別の保存がロックを持っている", { skip }, async () => {
  const ws = makeSingle();
  try {
    const snapName = "rex0220-formula-app2305-20261018-120000.json";
    mkdirSync(path.join(ws.root, "settings"));
    writeFileSync(path.join(ws.root, "settings", snapName), content());
    const snap = await updateFields(ws.ctx, { path: `settings/${snapName}`, expectedDigest: digestOf(content()), rows: rowsJson({ fieldcode: "金額合計", rank: 1 }) });
    assert.deepEqual([snap.status, snap.code], ["denied", "PermissionError"]);
    writeFileSync(path.join(ws.root, "settings", "other.json"), JSON.stringify({ pluginID: "other", pluginInfos: [] }));
    const other = await updateFields(ws.ctx, { path: "settings/other.json", expectedDigest: digestOf(JSON.stringify({ pluginID: "other", pluginInfos: [] })), rows: rowsJson({ fieldcode: "x" }) });
    assert.deepEqual([other.status, other.code], ["invalid", "InputError"]);
    assert.match(other.message, /計算式プラグインの設定のファイルではない/);

    const saved = await saveNewSettings(ws.ctx, { path: "settings/a.json", content: content(), expectedAbsent: true });
    const file = path.join(ws.root, "settings", "a.json");
    const lock = acquireLock(file);
    try {
      const busy = await updateFields(ws.ctx, { path: "settings/a.json", expectedDigest: saved.digest, rows: rowsJson({ fieldcode: "金額合計", rank: 1 }) });
      assert.deepEqual([busy.status, busy.code], ["conflict", "ConflictError"]);
      assert.equal(fileDigest(file), saved.digest);
    } finally {
      lock.release();
    }
    const busyNew = (() => {
      const l = acquireLock(path.join(ws.root, "settings", "b.json"));
      return { l, run: () => saveNewSettings(ws.ctx, { path: "settings/b.json", content: content(), expectedAbsent: true }) };
    })();
    try {
      const r = await busyNew.run();
      assert.deepEqual([r.status, r.code], ["conflict", "ConflictError"]);
      assert.ok(!existsSync(path.join(ws.root, "settings", "b.json")));
    } finally {
      busyNew.l.release();
    }
  } finally {
    ws.cleanup();
  }
});

test("アプリのフォルダー（接続のファイルの形）: 同じフォルダーの fields.json で検査して保存、別の fields は denied、profile が接続のファイルに無いフォルダーは denied、Worker 経由でも同じ", { skip }, async () => {
  const cws = makeConnWorkspace();
  try {
    const dir = cws.appFolder("dev", 2305, "テーブル内集計", FIELDS_FILE());
    const relDir = path.relative(cws.root, dir).replace(/\\/g, "/");
    const ctx = { root: cws.root, mode: cws.mode(), policy: DEFAULT_POLICY, source: SOURCE, run: { inline: true } };
    const r = await saveNewSettings(ctx, { path: `${relDir}/new.json`, content: content(), expectedAbsent: true });
    assert.equal(r.status, "ok", r.message);
    assert.equal(r.path, `${relDir}/new.json`);
    const otherFields = await saveNewSettings(ctx, { path: `${relDir}/new2.json`, content: content(), fields: "fields/x.json", expectedAbsent: true });
    assert.deepEqual([otherFields.status, otherFields.code], ["denied", "PermissionError"]);
    const noProfile = await saveNewSettings(ctx, { path: "kintone/stage/2305-x/new.json", content: content(), expectedAbsent: true });
    assert.deepEqual([noProfile.status, noProfile.code], ["denied", "PermissionError"]);
    assert.ok(!existsSync(path.join(cws.root, "kintone", "stage")));
    // ダウンロードの名前は書き換えない（updateFields）。-edit.json は直せる
    const snapName = "rex0220-formula-app2305-20261018-120000.json";
    writeFileSync(path.join(dir, snapName), content());
    writeFileSync(path.join(dir, snapName.replace(/\.json$/, "-edit.json")), content());
    const snap = await updateFields(ctx, { path: `${relDir}/${snapName}`, expectedDigest: digestOf(content()), rows: rowsJson({ fieldcode: "金額合計", rank: 1 }) });
    assert.deepEqual([snap.status, snap.code], ["denied", "PermissionError"]);
    const edit = await updateFields({ ...ctx, run: { timeoutSec: 60 } }, { path: `${relDir}/${snapName.replace(/\.json$/, "-edit.json")}`, expectedDigest: digestOf(content()), rows: rowsJson({ fieldcode: "金額合計", rank: 1 }) });
    assert.equal(edit.status, "ok", edit.message);
    assert.deepEqual(edit.diff.fields.map((f) => f.fieldcode), ["金額合計"]);
  } finally {
    cws.cleanup();
  }
});
