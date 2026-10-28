/**
 * 項目検証のコマンド（fv normalize / check / summary / diff / pull と CLI）を、本物の計算式の zip のエンジンと架空のアプリ（fixtures/fv）で確かめる
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import { fvNormalizeSettings } from "../src/fv/normalize.ts";
import { fvCheckSettings, validateFvEvents } from "../src/fv/check.ts";
import { fvDiffSettings, fvSummarizeSettings } from "../src/fv/summary.ts";
import { fvPullSettings } from "../src/fv/pull.ts";
import { fvApplySource, fvPropsOf, fvRowsOf } from "../src/fv/rows.ts";
import { fvBuildSaved, fvDerive } from "../src/fv/derive.ts";
import { fvSourceOf } from "../src/fv/model.ts";
import { defaultUsersInfo } from "../src/users/index.ts";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const FIX = path.join(import.meta.dirname, "fixtures", "fv");
const read = (name) => JSON.parse(readFileSync(path.join(FIX, name), "utf8"));
const APP = 900;
const FIELDS = () => ({ tool: "formula-authoring fields", fetchedAt: "2026-10-28T00:00:00.000Z", baseUrl: "https://example.cybozu.com", appId: APP, appName: "架空の申請", preview: false, lang: "ja", revision: "1", properties: read("fields.json").properties, layout: read("layout.json").layout });
const envelope = (infos, extra = {}) => ({ date: "2026-10-28 09:00:00", pluginName: "項目検証プラグイン", pluginID: "rex0220 field validation plugin", PluginVersion: "72", appId: APP, appName: "架空の申請", pluginEnable: true, pluginInfos: infos, ...extra });
const GOOD = [
  { fieldcode: "氏名", state: true, formulaSet: "1", disabledSet: '区分 = "B"', hideSet: "", init: false, condInfos: [{ state: true, condSet: '氏名 = "test"', jaSet: '"test は使えません"', enSet: "", zhSet: "" }] },
  { fieldcode: "金額", state: true, formulaSet: '区分 = "A"', disabledSet: "", hideSet: "", init: false, condInfos: [] },
  { fieldcode: "備考", state: true, formulaSet: "", disabledSet: "", hideSet: '区分 = "B"', init: true, condInfos: [] }
];
const normalize = async (settings, opt = {}) => fvNormalizeSettings({ settingsText: JSON.stringify(settings), settingsFile: "settings/fv.json", fields: FIELDS(), engine: await loadEngine(), now: () => new Date(2026, 9, 28, 9, 0, 0), ...opt });
const rules = (r, level) => r.findings.items.filter((f) => f.level === level).map((f) => f.rule);

test("fv normalize: 正しい設定はエラー 0。出力は元の値の封筒（フォームで必須の行を補い、レイアウトの順）。出力をもう一度 --check すると差 0", { skip }, async () => {
  const r = await normalize(envelope(GOOD));
  assert.deepEqual(rules(r, "error"), [], r.summary);
  assert.equal(r.output.pluginID, "rex0220 field validation plugin");
  assert.equal(r.output.PluginVersion, "72");
  assert.deepEqual(r.output.pluginInfos.map((i) => i.fieldcode), ["氏名", "金額", "備考"]);
  assert.ok(!("pluginFields" in r.output), "保存値のキーは出さない");
  assert.ok(r.saved.pluginFields.length === 3 && r.saved.pluginHideCheck === true);
  const again = await normalize(r.output, { check: true });
  assert.deepEqual(again.checkDiffs, [], again.summary);
});

test("fv normalize: 設定画面のダウンロード（保存値つき）も読める。派生値のキーは捨てて情報", { skip }, async () => {
  const first = await normalize(envelope(GOOD));
  const download = { ...first.output, ...first.saved, pluginLastUpdate: "2026-10-28 09:00:00", pluginUpdater: "x" };
  const r = await normalize(download);
  assert.deepEqual(rules(r, "error"), [], r.summary);
  assert.ok(rules(r, "info").includes("schema.derived") && rules(r, "info").includes("schema.screen-keys"));
});

test("fv normalize: 封筒・キー・型・同じ項目の行のエラー（評価の前に止める）", { skip }, async () => {
  const r = await normalize({ ...envelope([{ fieldcode: "金額", state: "yes", hideset: "1" }, { fieldcode: "金額", state: true }]), pluginID: "rex0220 formula plugin", PluginVersion: "71", appId: 901, extra: 1 });
  assert.deepEqual([...new Set(rules(r, "error"))].sort(), ["envelope.app", "envelope.plugin", "envelope.version", "schema.duplicate", "schema.type", "schema.unknown-key"].sort(), r.summary);
  assert.equal(r.output, undefined);
});

test("fv normalize: 更新系の関数は評価せずに止める（「使う」がオフの行・メッセージ・テーブル内非表示も）。走査の間は dq を呼ばない", { skip }, async () => {
  const engine = await loadEngine();
  const before = engine.dqCount();
  const r = await normalize(envelope([
    { fieldcode: "金額", state: false, hideSet: "COUNTROW(TLTABLE(明細, TPKEY(品名), TPVAL(数量), TPOUT(品名, 数量))) > 0" },
    { fieldcode: "氏名", state: true, condInfos: [{ state: true, condSet: "1", jaSet: 'FSET(金額, 1) & "x"' }] },
    { fieldcode: "明細", state: true, tblfields: [{ fieldcode: "品名", state: true, hideSet: "COUNTROW(TABLE_SORT(明細)) > 1" }] }
  ]), { engine });
  assert.deepEqual(rules(r, "error"), ["formula.update", "formula.update", "formula.update"], r.summary);
  assert.equal(engine.dqCount(), before, "評価していない");
});

test("fv normalize: アプリに無い行、置けない型の列、式の誤り、空の検証条件", { skip }, async () => {
  const r = await normalize(envelope([
    { fieldcode: "消えた項目", state: true, formulaSet: "1" },
    { fieldcode: "計算", state: true, formulaSet: "1", disabledSet: "1" },
    { fieldcode: "グループ1", state: true, condInfos: [{ state: true, condSet: "1", jaSet: '"x"' }] },
    { fieldcode: "明細", tblfields: [{ fieldcode: "消えた子", state: true, hideSet: "1" }] }
  ]));
  assert.deepEqual([...new Set(rules(r, "error"))].sort(), ["field.column", "field.missing"], r.summary);
  const r2 = await normalize(envelope([{ fieldcode: "金額", state: true, formulaSet: "金額 > 未知の項目" }, { fieldcode: "区分", state: true, condInfos: [{ state: true, condSet: "1", jaSet: "" }] }]));
  assert.deepEqual(rules(r2, "error").sort(), ["cond.empty", "formula.error"], r2.summary);
});

test("fv normalize: 警告（文字列の中の //、メッセージが項目の値だけ、フォームで必須の式、初期化だけ、「使う」がオフ、表示のたびに変わる関数）", { skip }, async () => {
  const r = await normalize(envelope([
    { fieldcode: "氏名", state: true, formulaSet: '区分 = "A"', condInfos: [{ state: true, condSet: '氏名 = "x"', jaSet: '"見る//メモ\n"' }, { state: true, condSet: "1", jaSet: "金額" }] },
    { fieldcode: "時刻", state: true, init: true },
    { fieldcode: "区分", state: false, hideSet: "NOW() > 0" }
  ]));
  assert.deepEqual(rules(r, "error"), [], r.summary);
  assert.deepEqual([...new Set(rules(r, "warning"))].sort(), ["formula.strip", "formula.volatile", "init.nohide", "message.form", "required.form", "state.off"].sort(), r.summary);
  // URL の文字列は // から後が消えて閉じなくなる（設定画面の保存でも止まる）: 構文のエラーと、理由の警告
  const url = await normalize(envelope([{ fieldcode: "氏名", state: true, condInfos: [{ state: true, condSet: "1", jaSet: '"https://example.com を見る"' }] }]));
  assert.deepEqual([rules(url, "error"), rules(url, "warning")], [["formula.syntax"], ["formula.strip"]], url.summary);
});

test("fv check: レコードとイベントごとの判定の表（印のある項目だけ）、イベント名と --user の検査", { skip }, async () => {
  const engine = await loadEngine();
  const normalized = await normalize(envelope(GOOD), { engine });
  const rec = (v) => Object.fromEntries(Object.entries(read("fields.json").properties).filter(([, p]) => p.type !== "GROUP").map(([c, p]) => [c, { type: p.type, value: p.type === "SUBTABLE" || p.type === "USER_SELECT" ? [] : v[c] ?? "" }]));
  const r = fvCheckSettings({ normalized, engine, fields: FIELDS(), appId: APP, records: [{ id: "1", record: rec({ 区分: "A" }) }, { id: "2", record: rec({ 区分: "B", 氏名: "山田", 備考: "メモ" }) }], events: ["app.record.create.show", "app.record.edit.submit"], usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" } });
  assert.equal(r.failed, true);
  assert.match(r.text, /更新していません（判定の模擬）/);
  assert.match(r.text, /レコード 1（app\.record\.create\.show）: 誤り 2 項目/);
  assert.match(r.text, /  金額: 必須、誤り「必須項目」/);
  assert.match(r.text, /レコード 2（app\.record\.edit\.submit）: 誤りなし/);
  assert.match(r.text, /  備考: 非表示、保存の前に "既定の備考" を入れる/);
  assert.match(r.text, /  氏名: 入力不可/);
  assert.match(r.contextLine, /ログインユーザー authoring/);
  assert.throws(() => validateFvEvents(["app.record.edit.change"]), /イベント名が違う/);
  assert.deepEqual(validateFvEvents(["mobile.app.record.edit.change.金額", "app.record.index.edit.submit"]).length, 2);
  assert.throws(() => fvCheckSettings({ normalized, engine, fields: FIELDS(), appId: APP, records: [], user: "nobody", usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" } }), /--user nobody/);
});

test("fv summary / fv diff: 行ごとの式の有無と短い式、--field で全文、行と列の差", () => {
  const a = envelope(GOOD);
  const s = fvSummarizeSettings(a, "settings/a.json");
  assert.match(s, /項目検証 Ver\.72、アプリ 900 架空の申請/);
  assert.match(s, /○ 氏名: 必須条件 1、入力不可 区分 = "B"、検証条件 1\/1/);
  assert.match(fvSummarizeSettings(a, "a", { field: "氏名" }), /検証条件 1（オン）: 条件 氏名 = "test"/);
  const b = envelope([{ ...GOOD[0], hideSet: '区分 = "C"' }, GOOD[2], { fieldcode: "時刻", state: true, hideSet: "1", init: true, condInfos: [] }], { pluginPreHide: true });
  const d = fvDiffSettings(a, b, { before: "a", after: "b" });
  assert.deepEqual(d.changed.sort(), ["時刻", "氏名", "金額"].sort());
  assert.ok(d.lines.some((l) => /^共通 pluginPreHide: false → true/.test(l)), d.lines.join("\n"));
  assert.ok(d.lines.some((l) => /^    非表示: （なし） → 区分 = "C"/.test(l)), d.lines.join("\n"));
  assert.ok(d.lines.some((l) => /^- ○ 金額/.test(l)) && d.lines.some((l) => /^\+ ○ 時刻/.test(l)));
});

test("fv pull: 保存値（compress 2）を元の値の封筒に。設定が空ならエラー", { skip }, async () => {
  const engine = await loadEngine();
  const { pp, crec } = fvPropsOf(read("fields.json").properties);
  const rows = fvRowsOf(pp, read("layout.json").layout);
  const source = fvSourceOf({ pluginInfos: GOOD });
  fvApplySource(rows, source);
  fvDerive({ engine, pp, crec }, rows);
  const stored = await engine.api.writeConfig(fvBuildSaved(rows, pp, source), "compressed");
  const calls = [];
  const client = (config) => ({ baseUrl: "https://example.cybozu.com", async get(api, params) { calls.push([api, params]); return api === "app" ? { appId: String(APP), name: "架空の申請" } : { config, revision: "5" }; } });
  const r = await fvPullSettings(client(stored), engine, { app: APP, now: () => new Date(2026, 9, 28, 9, 0, 0) });
  assert.deepEqual(calls.map((c) => c[0]), ["app", "app/plugin/config"]);
  assert.equal(calls[1][1].id, "iciolillbpdfcppoeibhnpfbhmbghkbo");
  assert.equal(r.envelope.pluginID, "rex0220 field validation plugin");
  assert.deepEqual(r.envelope.pluginInfos.map((i) => i.fieldcode), ["氏名", "金額", "備考"]);
  assert.ok(!("pluginFields" in r.envelope));
  const check = await normalize(r.envelope, { engine, check: true });
  assert.deepEqual(check.checkDiffs, [], check.summary);
  await assert.rejects(fvPullSettings(client({}), engine, { app: APP }), /項目検証プラグインの設定が空/);
});

test("CLI（1 接続の形）: fv normalize --out → fv summary → fv diff → fv check（records/）", { skip }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fv-cli-"));
  try {
    for (const d of ["fields", "settings", "records"]) mkdirSync(path.join(root, d));
    writeFileSync(path.join(root, "fields", `${APP}.json`), JSON.stringify(FIELDS()));
    writeFileSync(path.join(root, "settings", "fv.json"), JSON.stringify(envelope(GOOD)));
    const props = read("fields.json").properties;
    const record = Object.fromEntries(Object.entries(props).filter(([, p]) => p.type !== "GROUP").map(([c, p]) => [c, { type: p.type, value: p.type === "SUBTABLE" || p.type === "USER_SELECT" ? [] : c === "区分" ? "A" : "" }]));
    writeFileSync(path.join(root, "records", `${APP}-1.json`), JSON.stringify({ appId: APP, id: 1, record }));
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KINTONE_|KSQL_|FORMULA_)/.test(k)));
    const run = (...args) => spawnSync(process.execPath, ["--no-warnings", cli, ...args], { encoding: "utf8", cwd: root, env: { ...env, FORMULA_PLUGIN_ZIP: PLUGIN_ZIP, FORMULA_NO_WORKER: "1" } });
    let r = run("fv", "normalize", "settings/fv.json", "--out", "settings/fv-out.json");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /エラー 0/);
    assert.match(r.stdout, /取り込み方（全置換 \/ 項目の置換）/);
    r = run("fv", "summary", "settings/fv-out.json");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /○ 金額: 必須条件 区分 = "A"/);
    r = run("fv", "diff", "settings/fv.json", "settings/fv-out.json");
    assert.equal(r.status, 0, r.stderr);
    r = run("fv", "check", "settings/fv-out.json", "--app", String(APP), "--id", "1", "--event", "app.record.create.show,app.record.create.submit");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /レコード 1（app\.record\.create\.submit）: 誤り 2 項目/);
    r = run("fv", "check", "settings/fv-out.json", "--app", String(APP), "--id", "1", "--event", "app.record.edit.change");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /イベント名が違う/);
    r = run("fv", "nothing");
    assert.equal(r.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
