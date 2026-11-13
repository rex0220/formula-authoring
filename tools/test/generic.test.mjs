/**
 * 汎用のオーサリングの入口（src/generic.ts）。材料はアプリ集計プラグインの zip（隣の aggregate/dist/aggregate-plugin67.zip。無ければ飛ばす）。
 *   zip: プラグイン ID と署名、版、authoring API / Worker: 1 つの仕事 = 1 つの Worker、主スレッドを汚さない /
 *   元の値の操作・要約・差分 / kintone の項目定義を 2 段で読んで検査する（GET だけ）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as G from "../src/generic.ts";
import { crc32, unzip } from "../src/plugin-zip.ts";
import { PLUGIN_ZIP } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGG_ZIP = path.resolve(HERE, "../../../aggregate/dist/aggregate-plugin67.zip");
const skip = existsSync(AGG_ZIP) ? false : `アプリ集計の zip が無い: ${AGG_ZIP}`;
const AGG = G.genericPlugin("aggregate");
const call = (method, args, opt = {}) => G.callGeneric({ plugin: "aggregate", zip: AGG_ZIP, method, args }, { timeoutSec: 60, ...opt });
const caller = (method, args) => call(method, args);

/** 無圧縮の zip を作る（試験用。組み替えた zip を作るため） */
function storeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function withTemp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "generic-zip-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---- 表 ----------------------------------------------------------------------------------------
test("表: アプリ集計がある。無い名前は止める", () => {
  assert.equal(G.GENERIC_API_VERSION, 1);
  assert.deepEqual([AGG.title, AGG.toolPrefix, AGG.zipEnv, AGG.minPluginVersion], ["アプリ集計", "agg", "AGGREGATE_PLUGIN_ZIP", 67]);
  assert.throws(() => G.genericPlugin("formula"), G.UnknownPluginError);
  assert.throws(() => G.genericPlugin("constructor"), G.UnknownPluginError);
});

// ---- zip -----------------------------------------------------------------------------------------
test("zip: プラグイン ID と署名が通り、版・スクリプト・authoring API を読む", { skip }, () => {
  const src = G.readGenericZip(AGG_ZIP, AGG);
  assert.equal(src.pluginId, AGG.kintonePluginId);
  assert.ok(Number(src.pluginVersion) >= 67);
  assert.deepEqual(src.scripts.map((s) => s.entry), AGG.scripts);
  assert.ok(src.api.includes("rex0220PluginAuthoring"));
  assert.match(src.sha256.contents, /^[0-9a-f]{64}$/);
});

test("zip: 場所が無い・ファイルが無い・zip でない・別のプラグイン", { skip }, () => {
  const code = (fn) => { try { fn(); } catch (e) { return e instanceof G.GenericZipError ? e.code : `other:${e.message}`; } return "no error"; };
  assert.equal(code(() => G.readGenericZip(undefined, AGG)), "not-configured");
  assert.equal(code(() => G.readGenericZip("/no/such/file.zip", AGG)), "missing");
  withTemp((dir) => {
    const f = path.join(dir, "x.zip");
    writeFileSync(f, "not a zip");
    assert.equal(code(() => G.readGenericZip(f, AGG)), "unreadable");
  });
  if (existsSync(PLUGIN_ZIP)) assert.equal(code(() => G.readGenericZip(PLUGIN_ZIP, AGG)), "not-plugin", "計算式プラグインの zip はアプリ集計として読まない");
});

test("zip: PUBKEY と SIGNATURE を残して中身を差し替えた zip は、署名で止める", { skip }, () => {
  const outer = unzip(readFileSync(AGG_ZIP));
  const inner = unzip(outer.get("contents.zip"));
  // 中身の authoring API を 1 文字だけ変えて、contents.zip を組み直す（CRC も合った、形の正しい zip）
  const files = [...inner.entries()].map(([name, data]) => [name, name === AGG.apiEntry ? Buffer.from(data.toString("utf8").replace("rex0220PluginAuthoring", "rex0220PluginAuthorinG")) : data]);
  withTemp((dir) => {
    const f = path.join(dir, "tampered.zip");
    writeFileSync(f, storeZip([["contents.zip", storeZip(files)], ["PUBKEY", outer.get("PUBKEY")], ["SIGNATURE", outer.get("SIGNATURE")]]));
    assert.throws(() => G.readGenericZip(f, AGG), (e) => e instanceof G.GenericZipError && e.code === "bad-signature");
    // 組み直しただけ（中身は同じ）なら、同じ contents.zip ではないので署名は通らない。元の contents.zip をそのまま入れた zip は通る
    const same = path.join(dir, "same.zip");
    writeFileSync(same, storeZip([["contents.zip", outer.get("contents.zip")], ["PUBKEY", outer.get("PUBKEY")], ["SIGNATURE", outer.get("SIGNATURE")]]));
    assert.equal(G.readGenericZip(same, AGG).pluginId, AGG.kintonePluginId);
  });
});

// ---- Worker --------------------------------------------------------------------------------------
const OWN = {
  properties: {
    得意先LU: { type: "SINGLE_LINE_TEXT", code: "得意先LU", label: "得意先（ルックアップ）", lookup: { relatedApp: { app: "200" }, relatedKeyField: "顧客" } },
    得意先CD: { type: "SINGLE_LINE_TEXT", code: "得意先CD", label: "得意先コード" },
    合計: { type: "NUMBER", code: "合計", label: "受注金額の合計" },
    基準日: { type: "DATE", code: "基準日", label: "集計の基準日" }
  },
  layout: []
};
const TARGET = { properties: { 顧客: { type: "SINGLE_LINE_TEXT", code: "顧客", label: "得意先コード" }, 金額: { type: "NUMBER", code: "金額", label: "受注金額" }, 受注日: { type: "DATE", code: "受注日", label: "受注日" } }, layout: [] };
const DEFS = { own: OWN, appNames: { 200: "受注" }, apps: { 200: TARGET } };
async function sample() {
  const source = await call("newSource", ["ja"]);
  const row = await call("newRow", ["ja"]);
  Object.assign(row, { name: "受注の合計", app: { id: "", fcode: "得意先LU" }, filters: [{ state: true, field: "顧客", cond: "=", value: "得意先CD" }], fields: [{ state: true, to: "合計", summary: "sum", formula: "IF(受注日<=#基準日,金額,0)", init: true, editable: false }] });
  return G.addRow(source, row).source;
}

test("Worker: zip の状態（describe）。主スレッドには zip のコードが入らない", { skip }, async () => {
  const d = await call("describe", []);
  assert.deepEqual([d.plugin, d.title, d.contractVersion, d.hasSimulate, d.zip.signed], ["aggregate", "アプリ集計", 1, false, true]);
  assert.ok(Number(d.pluginVersion) >= 67);
  assert.equal(globalThis.rex0220p, undefined, "主スレッドにエンジンを読まない");
  assert.equal(globalThis[G.AUTHORING_GLOBAL], undefined, "主スレッドに authoring API を読まない");
});

test("Worker: 元の値を検査して保存値を作る。取り違えは止める指摘で返る", { skip }, async () => {
  const source = await sample();
  const r = await G.checkWithDefs(caller, source, DEFS);
  assert.deepEqual(r.issues, []);
  assert.equal(r.body.pluginInfos[0].appKey, "200:(得意先LU):受注");
  assert.equal(r.body.pluginInfos[0].fieldsInfo[0].toField, "受注金額の合計:合計");
  assert.match(r.digest, /^[0-9a-f]{64}$/);
  assert.equal(r.evaluation, "dummy-record");
  const again = await G.checkWithDefs(caller, source, DEFS);
  assert.equal(again.digest, r.digest, "同じ元の値は同じ印");
  const bad = G.patchRow(source, "01", { fields: [{ state: true, to: "合計", summary: "sum", formula: "IF(受注日<=基準日,金額,0)", init: true, editable: false }] });
  const ng = await G.checkWithDefs(caller, bad, DEFS);
  assert.deepEqual([ng.body, ng.digest, ng.issues.map((x) => `${x.severity}:${x.code}`)], [null, null, ["error:formula"]]);
});

test("Worker: 封筒の読み書き。誤りの種類（zip / plugin / other）", { skip }, async () => {
  const body = (await G.checkWithDefs(caller, await sample(), DEFS)).body;
  const text = await call("writeEnvelope", [{ appId: 100, appName: "集計先" }, body]);
  const env = await call("readEnvelope", [text]);
  assert.equal(env.envelope.pluginID, AGG.configPluginId);
  assert.equal(G.canonicalJson(env.body), G.canonicalJson(body));
  // プラグインの API が投げた誤り
  await assert.rejects(call("readEnvelope", [text.replace(AGG.configPluginId, "rex0220 other plugin")]), (e) => e instanceof G.GenericCallError && e.kind === "plugin");
  // zip の誤り
  await assert.rejects(G.callGeneric({ plugin: "aggregate", zip: "/no/such.zip", method: "describe", args: [] }), (e) => e instanceof G.GenericCallError && e.kind === "zip" && e.code === "missing");
  // 呼べない口
  await assert.rejects(G.callGeneric({ plugin: "aggregate", zip: AGG_ZIP, method: "constructor", args: [] }), (e) => e instanceof G.GenericCallError && e.kind === "other");
});

test("Worker: zip のコードの出力は親の標準出力に流さず、受け取れる。同時の呼び出しは別の Worker", { skip }, async () => {
  const chunks = [];
  const [a, b] = await Promise.all([call("newSource", ["ja"], { captureOutput: (c) => chunks.push(c) }), call("describe", [])]);
  assert.ok(Array.isArray(a.rows) && b.zip.signed);
  assert.ok(chunks.every((c) => typeof c === "string"));
});

// ---- 元の値の操作 ----------------------------------------------------------------------------------
const SRC = { common: { enabled: true, note: "" }, rows: [{ key: "01", state: true, name: "A", items: [{ state: true, to: "x", formula: "1" }] }, { key: "02", state: false, name: "B", items: [] }] };

test("元の値: 行を読む・直す・足す・消す・動かす（渡した値は書き換えない。キーは位置で振り直す）", () => {
  const before = JSON.stringify(SRC);
  assert.deepEqual(G.getRow(SRC, "02").name, "B");
  assert.throws(() => G.getRow(SRC, "09"), (e) => e instanceof G.SourceError && /ある行: 01, 02/.test(e.message));
  const patched = G.patchRow(SRC, "01", { name: "A2" });
  assert.deepEqual([patched.rows[0].name, patched.rows[0].key, patched.rows[0].items.length], ["A2", "01", 1]);
  const replaced = G.setRow(SRC, "02", { name: "B2", key: "99" });
  assert.deepEqual([replaced.rows[1].name, replaced.rows[1].key, replaced.rows[1].state], ["B2", "02", true], "キーは変えられない。state を省くと有効");
  const added = G.addRow(SRC, { name: "C" }, 1);
  assert.deepEqual([added.key, added.source.rows.map((r) => `${r.key}:${r.name}`)], ["02", ["01:A", "02:C", "03:B"]]);
  assert.deepEqual(G.removeRow(SRC, "01").rows.map((r) => `${r.key}:${r.name}`), ["01:B"]);
  const moved = G.moveRow(SRC, "02", 0);
  assert.deepEqual([moved.key, moved.source.rows.map((r) => `${r.key}:${r.name}`)], ["01", ["01:B", "02:A"]]);
  assert.deepEqual(G.patchCommon(SRC, { note: "メモ" }).common, { enabled: true, note: "メモ" });
  assert.equal(JSON.stringify(SRC), before);
  assert.throws(() => G.assertSource({ rows: [] }), G.SourceError);
  assert.equal(G.renumber({ common: {}, rows: Array.from({ length: 100 }, () => ({ state: true })) }).rows[99].key, "100", "100 行目のキーも重ならない");
});

test("元の値: 要約と差分（位置がずれても、中身が同じ行は変わっていないと見る）", () => {
  const text = G.summarizeSource(SRC);
  assert.match(text, /^行 2（有効 1）/);
  assert.match(text, /\[行 01\] 有効 A/);
  assert.match(text, /\[行 02\] 無効 B/);
  assert.match(text, /・1 to=x formula=1/);
  assert.equal(G.renderDiff(G.diffSource(SRC, JSON.parse(JSON.stringify(SRC)))), "差分なし");
  // 先頭に 1 行足して、元の 1 行目の式を直す
  let after = G.addRow(SRC, { name: "N", items: [] }, 0).source;
  after = G.patchRow(after, "02", { items: [{ state: true, to: "x", formula: "2" }] });
  after = G.patchCommon(after, { note: "直した" });
  const d = G.diffSource(SRC, after);
  assert.deepEqual(d.rows.map((r) => [r.change, r.before, r.after, r.name]), [["added", undefined, "01", "N"], ["changed", "01", "02", "A"]], "3 行目（元の 2 行目）は出ない");
  assert.deepEqual(d.rows[1].paths, ["items[0].formula: 1 → 2"]);
  assert.deepEqual(d.common, ["note:  → 直した"]);
  const removed = G.diffSource(SRC, G.removeRow(SRC, "01"));
  assert.deepEqual(removed.rows.map((r) => [r.change, r.before, r.name]), [["removed", "01", "A"]]);
  assert.equal(G.digestOfJson({ b: 1, a: [1, { d: 1, c: 2 }] }), G.digestOfJson({ a: [1, { c: 2, d: 1 }], b: 1 }), "キーの並びが違っても同じ印");
});

// ---- kintone の項目定義を読んで検査する ------------------------------------------------------------
function fakeClient(handlers) {
  const calls = [];
  const client = { get: async (api, params) => { calls.push(`${api} ${JSON.stringify(params)}`); const h = handlers[`${api}:${params.app ?? params.id}`]; if (!h) { const e = new Error(`403 ${api}`); throw e; } return h; } };
  // 接続はアプリごとに作る（どのアプリの接続を求められたかを控える）
  const asked = [];
  const clientFor = (appId) => { asked.push(appId); return client; };
  clientFor.calls = calls;
  clientFor.asked = asked;
  return clientFor;
}

test("項目定義: 自アプリは動作テスト環境、名前と対象アプリは運用環境を、2 段で読む（GET だけ）", { skip }, async () => {
  const client = fakeClient({
    "preview/app/form/fields:100": { properties: OWN.properties, revision: "1" }, "preview/app/form/layout:100": { layout: [], revision: "1" }, "preview/app/views:100": { views: {} },
    "app:100": { name: "集計先" }, "app:200": { name: "受注" },
    "app/form/fields:200": { properties: TARGET.properties, revision: "1" }, "app/form/layout:200": { layout: [], revision: "1" }, "app/views:200": { views: {} }
  });
  const r = await G.checkSource(client, caller, await sample(), { app: 100 });
  assert.deepEqual(r.issues, []);
  assert.deepEqual([r.apps, r.notes], [["200"], []]);
  assert.equal(r.body.pluginInfos[0].appKey, "200:(得意先LU):受注");
  const apis = client.calls.map((c) => c.split(" ")[0]);
  const at = (prefix) => client.calls.findIndex((c) => c.startsWith(prefix));
  assert.ok(at("preview/app/form/fields ") < at('app {"id":"200"}') && at('app {"id":"200"}') < at("app/form/fields "), `読む順（自アプリ → 参照先の名前 → 対象アプリの項目定義）: ${apis.join(" → ")}`);
  assert.ok(client.calls.some((c) => c.startsWith("app/form/fields") && c.includes("200")), "対象アプリは運用環境");
  assert.ok(!client.calls.some((c) => c.startsWith("preview/") && c.includes("200")), "対象アプリの動作テスト環境は読まない");
  assert.deepEqual([...new Set(client.asked)].sort(), [100, 200], "接続は自アプリと対象アプリのそれぞれで作る");
});

test("項目定義: 読めないアプリは飛ばして注記に残し、その行は API が止める", { skip }, async () => {
  const base = { "app:100": { name: "集計先" }, "preview/app/form/fields:100": { properties: OWN.properties, revision: "1" }, "preview/app/form/layout:100": { layout: [], revision: "1" }, "preview/app/views:100": { views: {} } };
  // 名前を読めない（権限が無い）
  const c1 = fakeClient(base);
  const r1 = await G.checkSource(c1, caller, await sample(), { app: 100 });
  assert.deepEqual(r1.issues.map((x) => `${x.severity}:${x.code}`), ["error:app.fcode"], "ルックアップの参照先の名前が分からないので、項目から引けない");
  assert.ok(r1.notes.some((n) => /アプリ 200 の名前を読めない/.test(n)));
  assert.equal(r1.body, null);
  // 名前は読めるが、項目定義を読めない
  const c2 = fakeClient({ ...base, "app:200": { name: "受注" } });
  const r2 = await G.checkSource(c2, caller, await sample(), { app: 100 });
  assert.deepEqual(r2.issues.map((x) => `${x.severity}:${x.code}`), ["error:app.noFields"]);
  assert.ok(r2.notes.some((n) => /アプリ 200 の項目定義を読めない/.test(n)));
});

test("項目定義: プラグインの API が返したアプリ番号をそのまま kintone に渡さない。自アプリを対象にするときは動作テスト環境", async () => {
  const client = fakeClient({
    "app:100": { name: "集計先" }, "preview/app/form/fields:100": { properties: {}, revision: "1" }, "preview/app/form/layout:100": { layout: [], revision: "1" }, "preview/app/views:100": { views: {} },
    "app:200": { name: "受注" },
    "app/form/fields:200": { properties: { x: { type: "NUMBER", code: "x", label: "x" } }, revision: "1" }, "app/form/layout:200": { layout: [], revision: "1" }, "app/views:200": { views: {} }
  });
  // 代役の API: 設定に書かれた値がそのまま出てきた、という想定（アプリ番号でないもの・負の数・大きすぎる数・重なり・自アプリ）
  const fake = async (method) => (method === "requirements" ? { needNames: [], targetAppIds: ["abc", "-1", "99999999999999999999", "0200", "200", "200", "100", "1e3"] } : null);
  const { defs, notes } = await G.fetchGenericDefs(client, fake, { common: {}, rows: [] }, { app: 100 });
  assert.deepEqual(Object.keys(defs.apps).sort(), ["100", "200"]);
  assert.deepEqual([...new Set(client.asked)].sort(), [100, 200], "アプリ番号として読めるものだけ、接続を作る（NaN を渡さない）");
  assert.equal(notes.filter((n) => /アプリ番号として読めない/.test(n)).length, 5);
  assert.equal(client.calls.filter((c) => c.startsWith("app/form/fields ") && c.includes("200")).length, 1, "同じアプリは 1 回だけ読む");
  const own = client.calls.filter((c) => /form\/(fields|layout) /.test(c) && /"app":"?100"?[,}]/.test(c));
  assert.ok(own.length >= 2 && own.every((c) => c.startsWith("preview/")), `自アプリを対象にする設定は、自アプリと同じ動作テスト環境を読む: ${own.join(" / ")}`);
  assert.deepEqual(["200", "0200", "abc", "-1", "1e3", "99999999999999999999", 200, ""].map((x) => G.isAppIdText(x)), [true, false, false, false, false, false, false, false]);
  // 名前を求めるほうも同じ検査
  let round = 0;
  const names = async (method) => (method === "requirements" ? (round++ === 0 ? { needNames: ["x y", "200"], targetAppIds: [] } : { needNames: [], targetAppIds: [] }) : null);
  const c2 = fakeClient({ "app:100": { name: "集計先" }, "preview/app/form/fields:100": { properties: {}, revision: "1" }, "preview/app/form/layout:100": { layout: [], revision: "1" }, "preview/app/views:100": { views: {} }, "app:200": { name: "受注" } });
  const r2 = await G.fetchGenericDefs(c2, names, { common: {}, rows: [] }, { app: 100 });
  assert.deepEqual([r2.defs.appNames, r2.notes.length], [{ 200: "受注" }, 1]);
});

test("Worker: 利用者・組織・グループに依る式は、代役の利用者情報でも検査を通る（検査は式の形と使う項目だけ。値は使わない）", { skip }, async () => {
  for (const formula of ['UINFO("name") != ""', 'UINFO("code") = "user1"', 'CONTAINS(OUSERS("営業部"), UINFO("code"))', 'CONTAINS(GUSERS("管理者"), UINFO("code"))']) {
    const s = await sample();
    s.common.executeCondition.formula = formula;
    const r = await G.callGeneric({ plugin: "aggregate", zip: AGG_ZIP, method: "check", args: [s, DEFS, { lang: "ja" }], context: { ownAppId: 100 } }, { timeoutSec: 60 });
    assert.deepEqual(r.issues, [], formula);
    assert.equal(r.evaluation, "dummy-record");
  }
});

// ---- 作業フォルダー（直下に JSON を置く形）----------------------------------------------------------
import { mkdirSync, symlinkSync, readdirSync } from "node:fs";

const FILE = (source = SRC) => ({ kind: G.SOURCE_FILE_KIND, plugin: "aggregate", appId: 100, appName: "集計先", source });

test("作業フォルダー: 設定ファイルを新しく置く（上書きしない）・読む・直す（digest を照合）", () => {
  withTemp((dir) => {
    const saved = G.saveNewSourceFile(dir, "agg-app100.json", FILE());
    assert.equal(saved.status, "saved");
    assert.throws(() => G.saveNewSourceFile(dir, "agg-app100.json", FILE()), (e) => e instanceof G.GenericFileError && e.status === "exists");
    const read = G.readSourceFile(dir, "agg-app100.json");
    assert.deepEqual([read.digest, read.file.plugin, read.file.appId, read.file.source.rows.length], [saved.digest, "aggregate", 100, 2]);
    // 直す
    const up = G.updateSourceFile(dir, "agg-app100.json", read.digest, (s) => G.patchRow(s, "01", { name: "A2" }));
    assert.equal(up.after.rows[0].name, "A2");
    assert.equal(G.renderDiff(G.diffSource(up.before, up.after)).includes("name: A → A2"), true);
    const again = G.readSourceFile(dir, "agg-app100.json");
    assert.deepEqual([again.digest, again.file.source.rows[0].name], [up.digest, "A2"]);
    // 読んだ後に変わっていたら conflict（古い digest では直せない）
    assert.throws(() => G.updateSourceFile(dir, "agg-app100.json", read.digest, (s) => s), (e) => e instanceof G.GenericFileError && e.status === "conflict");
    // 形の崩れた結果は書かない（ファイルはそのまま）
    assert.throws(() => G.updateSourceFile(dir, "agg-app100.json", up.digest, () => ({ rows: [] })), G.SourceError);
    assert.equal(G.readSourceFile(dir, "agg-app100.json").digest, up.digest);
    assert.deepEqual(readdirSync(dir).filter((n) => n !== "agg-app100.json"), [], "一時ファイルとロックが残らない");
  });
});

test("作業フォルダー: 直下の .json だけを読み書きする（フォルダーの区切り・..・先頭の「.」・外を指す symlink は断る）", () => {
  withTemp((dir) => {
    const denied = (name) => assert.throws(() => G.saveNewSourceFile(dir, name, FILE()), (e) => e instanceof G.GenericFileError && e.status === "denied", name);
    for (const name of ["../x.json", "sub/x.json", "/tmp/x.json", ".hidden.json", "x.txt", "", "a\\b.json"]) denied(name);
    // Windows で別の名前に化ける・開けない名前は、どの OS でも受けない（作業フォルダーを共有することがある）
    for (const name of ["CON.json", "nul.json", "com1.json", "LPT9.json", "a .json", "a..json", " a.json", "a:b.json", "a?.json", "a*.json", 'a".json', "a<b>.json", "a|b.json", "a\u0001.json"]) denied(name);
    assert.equal(G.saveNewSourceFile(dir, "console.json", FILE()).status, "saved", "予約名で始まるだけの名前はよい");
    withTemp((outside) => {
      writeFileSync(path.join(outside, "real.json"), "{}");
      symlinkSync(path.join(outside, "real.json"), path.join(dir, "link.json"));
      assert.throws(() => G.readSourceFile(dir, "link.json"), (e) => e instanceof G.GenericFileError && e.status === "denied");
      assert.throws(() => G.updateSourceFile(dir, "link.json", "x", (s) => s), (e) => e instanceof G.GenericFileError && e.status === "denied");
    });
    assert.throws(() => G.readSourceFile(dir, "none.json"), (e) => e instanceof G.GenericFileError && e.status === "missing");
    writeFileSync(path.join(dir, "bad.json"), "{");
    writeFileSync(path.join(dir, "other.json"), JSON.stringify({ kind: "x" }));
    assert.throws(() => G.readSourceFile(dir, "bad.json"), (e) => e instanceof G.GenericFileError && e.status === "invalid");
    assert.throws(() => G.readSourceFile(dir, "other.json"), (e) => e instanceof G.GenericFileError && e.status === "invalid");
    writeFileSync(path.join(dir, "unknown.json"), JSON.stringify({ ...FILE(), plugin: "formula" }));
    assert.throws(() => G.readSourceFile(dir, "unknown.json"), G.UnknownPluginError);
  });
});

test("作業フォルダー: 取り込み用のファイルは、設定ファイルが検査したときのままであることを確かめてから置く", () => {
  withTemp((dir) => {
    const saved = G.saveNewSourceFile(dir, "agg-app100.json", FILE());
    const text = JSON.stringify({ pluginID: "rex0220 aggregate records plugin", appId: 100 });
    // 検査の後に設定ファイルが直された → 古い中身から作らない
    const up = G.updateSourceFile(dir, "agg-app100.json", saved.digest, (s) => G.patchRow(s, "01", { name: "直した" }));
    assert.throws(() => G.saveNewImportFileFor(dir, "agg-app100.json", saved.digest, "aggregate-app100-20261113-090000-import.json", text), (e) => e instanceof G.GenericFileError && e.status === "conflict");
    assert.deepEqual(readdirSync(dir), ["agg-app100.json"], "取り込み用のファイルもロックも残らない");
    // そのままなら置く。同じ名前は上書きしない
    const r = G.saveNewImportFileFor(dir, "agg-app100.json", up.digest, "aggregate-app100-20261113-090000-import.json", text);
    assert.equal(r.status, "saved");
    assert.throws(() => G.saveNewImportFileFor(dir, "agg-app100.json", up.digest, "aggregate-app100-20261113-090000-import.json", text), (e) => e instanceof G.GenericFileError && e.status === "exists");
    assert.deepEqual(readdirSync(dir).sort(), ["agg-app100.json", "aggregate-app100-20261113-090000-import.json"], "ロックが残らない（次の書き込みが通る）");
    assert.equal(G.updateSourceFile(dir, "agg-app100.json", up.digest, (s) => s).status, "saved");
    // 設定ファイルが無い・外を指す名前
    assert.throws(() => G.saveNewImportFileFor(dir, "none.json", up.digest, "x-import.json", text), (e) => e instanceof G.GenericFileError && e.status === "missing");
    assert.throws(() => G.saveNewImportFileFor(dir, "../x.json", up.digest, "x-import.json", text), (e) => e instanceof G.GenericFileError && e.status === "denied");
  });
});

test("作業フォルダー: 一覧は種類（設定ファイル・保存値の封筒・そのほか）を見分ける", () => {
  withTemp((dir) => {
    G.saveNewSourceFile(dir, "b-source.json", FILE());
    writeFileSync(path.join(dir, "a-download.json"), JSON.stringify({ date: "2026-11-13 10:00:00", pluginName: "アプリ集計", pluginID: "rex0220 aggregate records plugin", PluginVersion: "67", appId: 100, appName: "集計先", pluginInfos: [] }));
    writeFileSync(path.join(dir, "c-other.json"), "[1,2]");
    writeFileSync(path.join(dir, "d-broken.json"), "{");
    writeFileSync(path.join(dir, "note.txt"), "x");
    mkdirSync(path.join(dir, "sub.json"));
    const list = G.listWorkFiles(dir);
    assert.deepEqual(list.map((f) => [f.name, f.type]), [["a-download.json", "envelope"], ["b-source.json", "source"], ["c-other.json", "other"], ["d-broken.json", "unreadable"]]);
    assert.deepEqual([list[0].pluginId, list[0].pluginVersion, list[0].appId], ["rex0220 aggregate records plugin", "67", 100]);
    assert.deepEqual([list[1].plugin, list[1].appId, list[1].rows], ["aggregate", 100, 2]);
    assert.match(G.importFileName("aggregate", 100, new Date(2026, 10, 13, 9, 5, 7)), /^aggregate-app100-20261113-090507-import\.json$/);
  });
});

test("作業フォルダー: ダウンロードした設定 → 設定ファイル → 直す → 検査 → 取り込み用のファイル、まで通す", { skip }, async () => {
  await withTempAsync(async (dir) => {
    // 設定画面でダウンロードしたファイル（保存値の封筒）を作業フォルダーに置く
    const first = await G.checkWithDefs(caller, await sample(), DEFS);
    writeFileSync(path.join(dir, "rex0220-aggregate-records-app100-20261113-090000.json"), await call("writeEnvelope", [{ appId: 100, appName: "集計先" }, first.body]));
    // 設定ファイルにする（元は残す）
    const dl = G.readWorkText(dir, "rex0220-aggregate-records-app100-20261113-090000.json");
    const env = await call("readEnvelope", [dl.text]);
    const source = await call("toSource", [env.body, "ja"]);
    const saved = G.saveNewSourceFile(dir, "agg-app100.json", { kind: G.SOURCE_FILE_KIND, plugin: "aggregate", appId: env.envelope.appId, appName: env.envelope.appName, source });
    // 直す: 集計項目の式を替える
    const up = G.updateSourceFile(dir, "agg-app100.json", saved.digest, (s) => {
      const row = G.getRow(s, "01");
      row.fields[0].formula = "金額";
      return G.setRow(s, "01", row);
    });
    // 検査（kintone から項目定義を読む）→ 取り込み用のファイル
    const client = fakeClient({
      "app:100": { name: "集計先" }, "preview/app/form/fields:100": { properties: OWN.properties, revision: "1" }, "preview/app/form/layout:100": { layout: [], revision: "1" }, "preview/app/views:100": { views: {} },
      "app:200": { name: "受注" }, "app/form/fields:200": { properties: TARGET.properties, revision: "1" }, "app/form/layout:200": { layout: [], revision: "1" }, "app/views:200": { views: {} }
    });
    const file = G.readSourceFile(dir, "agg-app100.json");
    assert.equal(file.digest, up.digest);
    const checked = await G.checkSource(client, caller, file.file.source, { app: file.file.appId });
    assert.deepEqual(checked.issues, []);
    const text = await call("writeEnvelope", [{ appId: file.file.appId, appName: file.file.appName }, checked.body]);
    const name = G.importFileName("aggregate", file.file.appId, new Date(2026, 10, 13, 9, 30, 0));
    G.saveNewImportFile(dir, name, text);
    assert.throws(() => G.saveNewImportFile(dir, name, text), (e) => e instanceof G.GenericFileError && e.status === "exists", "取り込み用のファイルも上書きしない");
    // 取り込み用のファイルは、設定画面の取り込みと同じ検査（readEnvelope）に通り、直した式が入っている
    const back = await call("readEnvelope", [G.readWorkText(dir, name).text]);
    assert.deepEqual([back.envelope.pluginID, back.envelope.appId, back.body.pluginInfos[0].fieldsInfo[0].fieldCalc], [AGG.configPluginId, 100, "金額"]);
    assert.equal(G.digestOfJson(back.body), checked.digest, "検査を通った保存値と同じ印");
    assert.deepEqual(G.listWorkFiles(dir).map((f) => f.type), ["source", "envelope", "envelope"]);
  });
});

async function withTempAsync(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "generic-work-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
