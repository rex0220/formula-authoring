/**
 * 汎用の入口の pull（src/generic/pull.ts）: アプリに保存されているプラグインの設定を読んで、ほどく。
 *   ほどく処理: compress "2"（分割あり・なし）、壊れた値・大きすぎる値・扱わない形 / kit の writeConfig が書いた値との往復（隣に kit があるとき）
 *   読む処理: GET だけ・呼ぶ API とパラメーター・動作テスト環境と運用環境・空の設定・API を呼べないとき
 *   zip の toSource に渡せる（隣に項目書式の zip があるとき）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import * as G from "../src/generic.ts";
import { RestError } from "../src/kintone-rest.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT_STORE = path.resolve(HERE, "../../../../plugin-config-kit/src/config-store.ts");
const FF_ZIP = path.resolve(HERE, "../../../field-format/dist/field-format-plugin16.zip");
const FF = G.genericPlugin("field-format");

/** compress "2" の値（base64( zlib( utf8( encodeURIComponent(JSON) ) ) )） */
const pack = (data) => deflateSync(Buffer.from(encodeURIComponent(JSON.stringify(data)), "utf8")).toString("base64");
const stored2 = (data) => ({ compress: "2", json: pack(data) });
const splitOf = (b64, n) => {
  const size = Math.ceil(b64.length / n);
  const out = { compress: "2", json: "split", split: String(n) };
  for (let i = 0; i < n; i++) out[`json${i}`] = b64.slice(i * size, (i + 1) * size);
  return out;
};
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof G.StoredConfigError, `StoredConfigError のはず: ${e}`);
    return e.code;
  }
  return "(no error)";
};

const SAMPLE = { pluginEnable: true, pluginComment: "メモ <b>&\"'</b> 100%", pluginInfos: [{ fieldcode: "期限", state: true, cond: 'AND(期限!="",DATE_FORMAT(期限)<TODAY())' }], pluginUpdater: "山田" };

test("decodeStoredConfig: compress \"2\" をほどく（分割なし・分割あり。日本語と記号がそのまま戻る）", () => {
  assert.deepEqual(G.decodeStoredConfig(stored2(SAMPLE)), SAMPLE);
  const b64 = pack(SAMPLE);
  for (const n of [1, 2, 3, 8]) assert.deepEqual(G.decodeStoredConfig(splitOf(b64, n)), SAMPLE, `split ${n}`);
  // 余分なキー（設定画面が足す覚え書きなど）があっても、json / compress / split / jsonN だけを見る
  assert.deepEqual(G.decodeStoredConfig({ ...stored2(SAMPLE), other: "x" }), SAMPLE);
  // base64 の中の空白は読み飛ばす（kit と同じ）
  assert.deepEqual(G.decodeStoredConfig({ compress: "2", json: b64.replace(/(.{20})/g, "$1\n") }), SAMPLE);
});

test("decodeStoredConfig: 形が違う・壊れている・大きすぎる・扱わない形は、分けて止める", () => {
  assert.equal(codeOf(() => G.decodeStoredConfig(null)), "bad-shape");
  assert.equal(codeOf(() => G.decodeStoredConfig([])), "bad-shape");
  assert.equal(codeOf(() => G.decodeStoredConfig({})), "empty");
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: 1 })), "bad-shape");
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: "" })), "empty");
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2" })), "empty");
  // 扱わない形: 平文（compress なし）、昔の "Y"
  assert.equal(codeOf(() => G.decodeStoredConfig({ json: JSON.stringify(SAMPLE) })), "unsupported-compress");
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "Y", json: pack(SAMPLE) })), "unsupported-compress");
  // 分割の誤り
  const b64 = pack(SAMPLE);
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: "split" })), "bad-split");
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: "split", split: "0", json0: b64 })), "bad-split");
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: "split", split: "2", json0: b64 })), "bad-split");
  assert.equal(codeOf(() => G.decodeStoredConfig({ ...splitOf(b64, 2), split: "9" })), "bad-split");
  // 壊れた値
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: "これは base64 ではない" })), "bad-base64");
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: "QUJD" })), "bad-compressed"); // base64 だが zlib でない
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: deflateSync(Buffer.from("%E3%81", "utf8")).toString("base64") })), "bad-compressed"); // decodeURIComponent に通らない
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: deflateSync(Buffer.from(encodeURIComponent("{壊れた JSON"), "utf8")).toString("base64") })), "bad-json");
  assert.equal(codeOf(() => G.decodeStoredConfig(stored2([1, 2, 3]))), "bad-json"); // オブジェクトでない
  // 大きすぎる: 1 値の長さ、ほどいた後の長さ（よく縮む値 = zip bomb の形）
  assert.equal(codeOf(() => G.decodeStoredConfig({ compress: "2", json: "A".repeat(65536) })), "too-large");
  const bomb = stored2({ a: "x".repeat(200000) });
  assert.ok(bomb.json.length < 2000, "よく縮む");
  assert.equal(codeOf(() => G.decodeStoredConfig(bomb, { ...G.STORED_LIMITS, maxDecodedLength: 100000 })), "too-large");
  assert.deepEqual(G.decodeStoredConfig(bomb).a.length, 200000, "既定の上限（4 MB）なら読める");
});

test("decodeStoredConfig: kit の writeConfig（設定画面の保存）が書いた値をほどける。大きい設定は分割される", { skip: existsSync(KIT_STORE) ? false : `kit が無い: ${KIT_STORE}` }, async () => {
  const kit = await import(pathToFileURL(KIT_STORE).href);
  const small = await kit.writeConfig(SAMPLE, "compressed");
  assert.equal(small.compress, "2");
  assert.deepEqual(G.decodeStoredConfig(small), SAMPLE);
  // 縮みにくい大きい値（乱数の文字）で、1 値の上限（65,535 字）を超えて分割させる
  let seed = 12345;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const noise = Array.from({ length: 90000 }, () => String.fromCharCode(0x3041 + (rand() % 80))).join("");
  const big = { ...SAMPLE, pluginDescription: noise };
  const storedBig = await kit.writeConfig(big, "compressed");
  assert.equal(storedBig.json, "split");
  assert.ok(Number(storedBig.split) >= 2, `分割された: ${storedBig.split}`);
  assert.deepEqual(G.decodeStoredConfig(storedBig), big);
  // kit の readConfig と同じ値になる
  assert.deepEqual(G.decodeStoredConfig(storedBig), (await kit.readConfig(storedBig)).data);
});

/** 代役の接続（呼ばれた API を覚える） */
function fakeClient(answers) {
  const calls = [];
  return {
    calls,
    baseUrl: "https://example.cybozu.com",
    async get(api, params, guestSpaceId) {
      calls.push({ api, params, guestSpaceId });
      const a = answers[api];
      if (a instanceof Error) throw a;
      if (a === undefined) throw new Error(`呼ばないはずの API: ${api}`);
      return a;
    }
  };
}

test("fetchStoredConfig: アプリの名前とプラグインの設定を GET で読んで、ほどく（既定は運用環境、preview で動作テスト環境）", async () => {
  const live = fakeClient({ app: { name: "問合せ" }, "app/plugin/config": { config: stored2(SAMPLE), revision: 6 } });
  const r = await G.fetchStoredConfig(live, FF, { app: 4434 });
  assert.deepEqual(r, { data: SAMPLE, appName: "問合せ", revision: "6", preview: false });
  assert.deepEqual(live.calls, [
    { api: "app", params: { id: 4434 }, guestSpaceId: undefined },
    { api: "app/plugin/config", params: { app: 4434, id: FF.kintonePluginId }, guestSpaceId: undefined }
  ]);
  const pre = fakeClient({ app: { name: "問合せ" }, "preview/app/plugin/config": { config: stored2(SAMPLE), revision: "7" } });
  const p = await G.fetchStoredConfig(pre, FF, { app: 4434, preview: true, guestSpaceId: 15 });
  assert.equal(p.preview, true);
  assert.equal(p.revision, "7");
  assert.deepEqual(pre.calls.map((c) => [c.api, c.guestSpaceId]), [["app", 15], ["preview/app/plugin/config", 15]]);
});

test("fetchStoredConfig: 設定が空・ほどけない・API を呼べないときは、代わりの道（設定をダウンロード）を添えて止める", async () => {
  for (const config of [{}, undefined, null, []]) {
    const c = fakeClient({ app: { name: "A" }, "app/plugin/config": { config, revision: 1 } });
    await assert.rejects(G.fetchStoredConfig(c, FF, { app: 1 }), (e) => e instanceof G.StoredConfigError && e.code === "empty" && /項目書式プラグインの設定が空/.test(e.message) && /運用環境に反映/.test(e.message));
  }
  const pre = fakeClient({ app: { name: "A" }, "preview/app/plugin/config": { config: {} } });
  await assert.rejects(G.fetchStoredConfig(pre, FF, { app: 1, preview: true }), (e) => e instanceof G.StoredConfigError && e.code === "empty" && /動作テスト環境/.test(e.message));
  const plain = fakeClient({ app: { name: "A" }, "app/plugin/config": { config: { json: "{}" } } });
  await assert.rejects(G.fetchStoredConfig(plain, FF, { app: 1 }), (e) => e instanceof G.StoredConfigError && e.code === "unsupported-compress" && /設定をダウンロード/.test(e.message));
  // API ラボが無効・権限が無い: kintone の誤りを、代わりの道を添えた誤りにする（プラグインの設定の API だけ。アプリを読めない誤りはそのまま）
  const off = fakeClient({ app: { name: "A" }, "app/plugin/config": new RestError("not found", 404, "GAIA_XX01", "/k/v1/app/plugin/config.json") });
  await assert.rejects(G.fetchStoredConfig(off, FF, { app: 1 }), (e) => e instanceof G.GenericPullError && e.status === 404 && e.code === "GAIA_XX01" && /API ラボ/.test(e.hint) && /設定をダウンロード/.test(e.hint) && /レコードの閲覧と追加/.test(e.hint));
  const offPre = fakeClient({ app: { name: "A" }, "preview/app/plugin/config": new RestError("forbidden", 403, "CB_NO02") });
  await assert.rejects(G.fetchStoredConfig(offPre, FF, { app: 1, preview: true }), (e) => e instanceof G.GenericPullError && /アプリ管理/.test(e.hint));
  const noApp = fakeClient({ app: new RestError("no app", 404, "GAIA_AP01") });
  await assert.rejects(G.fetchStoredConfig(noApp, FF, { app: 1 }), (e) => e instanceof RestError && !(e instanceof G.GenericPullError));
  assert.equal(noApp.calls.length, 1, "アプリを読めなければ、設定は読みに行かない");
});

test("ほどいた保存値は、zip の authoring API の toSource にそのまま渡せる（項目書式）", { skip: existsSync(FF_ZIP) && existsSync(KIT_STORE) ? false : "項目書式の zip か kit が無い" }, async () => {
  const kit = await import(pathToFileURL(KIT_STORE).href);
  const call = (method, args) => G.callGeneric({ plugin: "field-format", zip: FF_ZIP, method, args }, { timeoutSec: 60 });
  // zip が作った保存値の形（空の設定から、取り込み用の値）を、設定画面と同じ形で保存したことにして読む
  const empty = await call("newSource", ["ja"]);
  const row = await call("newRow", ["ja"]);
  const source = { common: { pluginComment: "メモ" }, rows: [{ ...row, field: "期限", state: true, value: [{ state: true, formula: "1", theme: "", color: "#ffffff", bcolor: "#ff0000", fsize: "", fstyle: "bold" }] }] };
  assert.deepEqual(empty.rows, []);
  const defs = { own: { properties: { 期限: { type: "DATE", code: "期限", label: "対応期限" } }, layout: [{ type: "ROW", fields: [{ type: "DATE", code: "期限", size: { width: "120" } }] }] }, appNames: {}, apps: {} };
  const checked = await call("check", [source, defs, {}]);
  assert.deepEqual(checked.issues.filter((x) => x.severity === "error"), []);
  const stored = await kit.writeConfig(checked.body, "compressed");
  const client = fakeClient({ app: { name: "問合せ" }, "preview/app/plugin/config": { config: stored, revision: 3 } });
  const got = await G.fetchStoredConfig(client, FF, { app: 4434, preview: true });
  const back = await call("toSource", [got.data, "ja"]);
  assert.equal(back.common.pluginComment, "メモ");
  assert.equal(back.rows.length, 1);
  assert.equal(back.rows[0].field, "期限");
  assert.deepEqual(back.rows[0].value.map((c) => [c.formula, c.color, c.bcolor, c.fstyle]), [["1", "#ffffff", "#ff0000", "bold"]]);
});
