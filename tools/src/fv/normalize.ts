/**
 * fv normalize <settings.json> [--fields fields/N.json] [--out <f>] [--check]
 * 項目検証の設定ファイル（封筒 + 元の値。設定画面のダウンロードは保存値も入っているが、取り込みは元の値だけを使う）を検査し、
 * 既定値を補った元の値の封筒を書き出す（field-validation/docs/オーサリングツール_実装計画.md 5 章）。
 * 順序: 生の JSON（封筒・未知のキー・型・同じ項目の行）→ 版 → 元の値 → 全部の式を集めて dq を止めた間に走査（更新系の関数は止める）
 * → 行と突き合わせ・列ごとの型 → 式の検査と派生値（ここで初めて dq）→ 保存値 → 大きさ。規則名は 分類.名前
 */
import type { Engine } from "../engine.ts";
import type { FieldsFile } from "../commands/fields.ts";
import { Findings } from "../normalize/findings.ts";
import { jsonDiff, quiet } from "../input.ts";
import { scanFormula, type ScanResult } from "../scan.ts";
import { defaultUsersInfo, type UsersInfoTable, type UsersOrigin } from "../users/index.ts";
import { FV_CONFIG_PLUGIN_ID, FV_ENGINES, FV_MIN_FORMULA_VERSION, FV_MIN_VERSION, engineOfFv, fvUpdateFunctions } from "./meta.ts";
import { FV_COLUMN_DENY, FV_DERIVED_KEYS, FV_ROW_KEYS, FV_SOURCE_KEYS, fvSourceOf, type FvSource, type FvSourceInfo } from "./model.ts";
import { fvApplySource, fvHasSetting, fvPropsOf, fvRowsOf, type FvProp, type FvRow } from "./rows.ts";
import { fvBuildSaved, fvDerive, fvStrip } from "./derive.ts";

/** 設定画面のダウンロードの pluginName（ja） */
export const FV_PLUGIN_NAME = "項目検証プラグイン";

const ENVELOPE_KEYS = ["date", "pluginName", "pluginID", "PluginVersion", "appId", "appName"];
/** 設定画面の保存が外枠に足すキー */
const OUTER_KEYS = ["pluginLastUpdate", "pluginUpdater", "startDate", "name", "version", "ldate", "error", "compress"];
/** 行・検証条件・テーブル内非表示のキー（元の値と、ダウンロード（保存値）にある派生・画面のキー。pqGrid の pq_* は旧い画面の残り） */
const ROW_SOURCE: readonly string[] = FV_ROW_KEYS;
const ROW_OTHER = ["formula", "disabled", "hide", "id", "row_type", "type", "type2", "fieldlabel", "constrain", "condDesc", "ptcode", "usedFields", "usedFieldsDisabled", "usedFieldsHide",
  "usedFieldsCond", "usedFieldsDuplicate", "usedFieldsTable", "dupInfos", "dupDesc", "check", "lookup", "message", "fieldno", "ptno"];
const COND_SOURCE = ["state", "condSet", "jaSet", "enSet", "zhSet"];
const COND_OTHER = ["cond", "ja", "en", "zh", "usedFields"];
const TBL_SOURCE = ["fieldcode", "state", "hideSet"];
const TBL_OTHER = ["id", "fieldlabel", "type", "usedFields", "hide", "fieldno"];
const BORDER_ITEM = ["state", "btype", "width", "color"];
const SCREEN = (k: string): boolean => k.startsWith("pq_");
/** エンジンの例外の文（直すために要る）は短くして出す。検査用のレコードは各項目の初期値なので、利用者のレコードの値は入らない */
const engineText = (s: string): string => { const t = s.replace(/[\u0000-\u001f]+/g, " "); return t.length > 200 ? `${t.slice(0, 200)}…` : t; };

export interface FvNormalizeInput {
  settingsText: string;
  settingsFile: string;
  fields: FieldsFile;
  engine: Engine;
  check?: boolean;
  usersInfo?: UsersInfoTable | null;
  usersOrigin?: UsersOrigin;
  now?: () => Date;
}

export interface FvNormalizeResult {
  findings: Findings;
  /** 既定値を補った元の値の封筒（エラーがあれば無い） */
  output?: Record<string, unknown>;
  /** 保存値（内部番号なし。fv check が使う。エラーがあれば無い） */
  saved?: Record<string, unknown>;
  source?: FvSource;
  rows?: FvRow[];
  pp?: Record<string, FvProp>;
  /** 封筒の項目検証の版（無ければ表の最新） */
  fvVersion: number;
  checkDiffs?: string[];
  appId?: number;
  size?: { bytes: number; keys: number };
  summary: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 式の置き場所（行の項目コード・列・検証条件の番号・言語。重ならない） */
interface Slot { where: string; text: string; on: boolean; message: boolean }
function slotsOf(file: string, infos: readonly FvSourceInfo[]): Slot[] {
  const out: Slot[] = [];
  for (const i of infos) {
    const at = (label: string, text: string, message = false): void => { if (text) out.push({ where: `${file} ${i.fieldcode} ${label}`, text, on: i.state, message }); };
    at("必須条件", i.formulaSet);
    at("入力不可", i.disabledSet);
    at("非表示", i.hideSet);
    i.condInfos.forEach((c, n) => {
      at(`検証条件 ${n + 1} の条件`, c.condSet);
      at(`検証条件 ${n + 1} のメッセージ（日）`, c.jaSet, true);
      at(`検証条件 ${n + 1} のメッセージ（英）`, c.enSet, true);
      at(`検証条件 ${n + 1} のメッセージ（中）`, c.zhSet, true);
    });
    for (const t of i.tblfields ?? []) at(`テーブル内非表示 ${t.fieldcode}`, t.hideSet);
  }
  return out;
}

/** 文字列定数の中の // と改行（保存の規則で消えて式が切れる） */
function cutInString(text: string): boolean {
  for (const m of text.matchAll(/"(?:\\"|[^"])*"/g)) if (m[0].includes("//") || m[0].includes("\n")) return true;
  return false;
}

export async function fvNormalizeSettings(input: FvNormalizeInput): Promise<FvNormalizeResult> {
  const { engine, fields } = input;
  const findings = new Findings();
  const file = input.settingsFile;
  let fvVersion = FV_ENGINES[FV_ENGINES.length - 1].fvVersion;
  const done = (extra: Partial<FvNormalizeResult> = {}): FvNormalizeResult => ({ findings, fvVersion, summary: findings.format(), ...extra });

  // 1. 生の JSON（封筒、未知のキー、型、同じ項目の行）
  let raw: unknown;
  try {
    raw = JSON.parse(input.settingsText.replace(/^﻿/, ""));
  } catch (e) {
    findings.error("schema.json", file, `JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }
  if (!isPlain(raw)) {
    findings.error("schema.json", file, "最上位はオブジェクト");
    return done();
  }
  if (raw.pluginID !== FV_CONFIG_PLUGIN_ID) findings.error("envelope.plugin", file, `pluginID が項目検証プラグインのものでない: ${JSON.stringify(raw.pluginID)}（${FV_CONFIG_PLUGIN_ID} が要る）`);
  const ver = String(raw.PluginVersion ?? "");
  if (!/^[1-9]\d{0,5}$/.test(ver)) findings.error("envelope.version", file, `PluginVersion が版の数でない: ${JSON.stringify(raw.PluginVersion)}`);
  else if (Number(ver) < FV_MIN_VERSION) findings.error("envelope.version", file, `Ver.${ver} の設定（tools が扱うのは Ver.${FV_MIN_VERSION} から。項目検証を Ver.${FV_MIN_VERSION} 以降にして、設定画面でダウンロードし直すか fv pull で取り直す）`);
  else fvVersion = Number(ver);
  const appId = raw.appId;
  if (typeof appId !== "number" || !Number.isInteger(appId) || appId <= 0) findings.error("envelope.app", file, `appId が正の整数でない: ${JSON.stringify(appId)}`);
  else if (appId !== fields.appId) findings.error("envelope.app", file, `appId ${appId} が fields のアプリ ${fields.appId} と違う（別のアプリの設定を当てている）`);
  const known = new Set([...ENVELOPE_KEYS, ...FV_SOURCE_KEYS, ...FV_DERIVED_KEYS, ...OUTER_KEYS]);
  const dropped: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) findings.error("schema.unknown-key", file, `知らないキー $.${k}（設定画面は黙って捨てる。書き間違いを見逃さないためにエラー）`);
    else if ((FV_DERIVED_KEYS as readonly string[]).includes(k) || OUTER_KEYS.includes(k)) dropped.push(k);
  }
  if (dropped.length) findings.info("schema.derived", file, `保存値・外枠のキーは捨てて、取り込みの後の保存で作り直す: ${dropped.join(", ")}`);
  for (const k of ["pluginEnable", "pluginPreHide", "pluginProductEnv"]) if (raw[k] !== undefined && typeof raw[k] !== "boolean") findings.error("schema.type", file, `${k} は true / false`);
  for (const k of ["pluginComment", "pluginDescription"]) if (raw[k] !== undefined && typeof raw[k] !== "string") findings.error("schema.type", file, `${k} は文字列`);
  let screenKeys = 0;
  const keysOf = (o: Record<string, unknown>, where: string, source: readonly string[], other: readonly string[]): void => {
    for (const k of Object.keys(o)) {
      if (SCREEN(k) || other.includes(k)) screenKeys++;
      else if (!source.includes(k)) findings.error("schema.unknown-key", where, `知らないキー ${k}`);
    }
  };
  const border = raw.pluginBorderInfo;
  if (border !== undefined) {
    if (!isPlain(border)) findings.error("schema.type", file, "pluginBorderInfo はオブジェクト");
    else {
      keysOf(border, `${file} pluginBorderInfo`, ["borderList"], []);
      const list = border.borderList;
      if (list !== undefined && (!Array.isArray(list) || list.length > 3)) findings.error("schema.type", file, "pluginBorderInfo.borderList は 3 行までの配列（必須で未入力・必須で入力済み・エラー）");
      else (list ?? []).forEach((b: unknown, i: number) => {
        const where = `${file} 枠線 ${i + 1} 行目`;
        if (!isPlain(b)) { findings.error("schema.type", where, "行はオブジェクト"); return; }
        keysOf(b, where, BORDER_ITEM, []);
        const w = Number(b.width);
        if (!(Number.isInteger(w) && w >= 0 && w <= 8)) findings.warning("border.value", where, `幅 ${JSON.stringify(b.width)} は 0〜8 の整数でない（既定に戻す）`);
        if (!/^#?[0-9a-fA-F]{3}$|^#?[0-9a-fA-F]{6}$/.test(String(b.color ?? "").trim())) findings.warning("border.value", where, `色 ${JSON.stringify(b.color)} は #rrggbb でない（既定に戻す）`);
      });
    }
  }
  const infos = raw.pluginInfos;
  if (infos !== undefined && !Array.isArray(infos)) findings.error("schema.rows", file, "pluginInfos は配列");
  const seen = new Set<string>();
  (Array.isArray(infos) ? infos : []).forEach((r: unknown, i: number) => {
    const where = `${file} pluginInfos[${i}]`;
    if (!isPlain(r)) { findings.error("schema.rows", where, "行はオブジェクト"); return; }
    keysOf(r, where, ROW_SOURCE, ROW_OTHER);
    if (typeof r.fieldcode !== "string" || !r.fieldcode) findings.error("schema.rows", where, "fieldcode（文字列）が要る");
    else if (seen.has(r.fieldcode)) findings.error("schema.duplicate", where, `同じ項目の行が 2 つ: ${r.fieldcode}（設定画面は後の行だけを使う）`);
    else seen.add(r.fieldcode);
    for (const k of ["state", "init"]) if (r[k] !== undefined && typeof r[k] !== "boolean") findings.error("schema.type", where, `${k} は true / false`);
    for (const k of ["formulaSet", "disabledSet", "hideSet"]) if (r[k] !== undefined && typeof r[k] !== "string") findings.error("schema.type", where, `${k} は文字列（式）`);
    if (r.condInfos !== undefined && !Array.isArray(r.condInfos)) findings.error("schema.type", where, "condInfos は配列");
    else (r.condInfos as unknown[] ?? []).forEach((c, n) => {
      const cw = `${where} condInfos[${n}]`;
      if (!isPlain(c)) { findings.error("schema.type", cw, "検証条件はオブジェクト"); return; }
      keysOf(c, cw, COND_SOURCE, COND_OTHER);
      if (c.state !== undefined && typeof c.state !== "boolean") findings.error("schema.type", cw, "state は true / false");
      for (const k of ["condSet", "jaSet", "enSet", "zhSet"]) if (c[k] !== undefined && typeof c[k] !== "string") findings.error("schema.type", cw, `${k} は文字列（式）`);
    });
    if (r.tblfields !== undefined && !Array.isArray(r.tblfields)) findings.error("schema.type", where, "tblfields は配列");
    else (r.tblfields as unknown[] ?? []).forEach((t, n) => {
      const tw = `${where} tblfields[${n}]`;
      if (!isPlain(t)) { findings.error("schema.type", tw, "テーブル内非表示の行はオブジェクト"); return; }
      keysOf(t, tw, TBL_SOURCE, TBL_OTHER);
      if (typeof t.fieldcode !== "string" || !t.fieldcode) findings.error("schema.rows", tw, "fieldcode（文字列）が要る");
      if (t.state !== undefined && typeof t.state !== "boolean") findings.error("schema.type", tw, "state は true / false");
      if (t.hideSet !== undefined && typeof t.hideSet !== "string") findings.error("schema.type", tw, "hideSet は文字列（式）");
    });
  });
  if (screenKeys) findings.info("schema.screen-keys", file, "画面・保存のキー（id / type / usedFields / cond / pq_* など）は捨てる");

  // 2. 版（計算式の zip と、項目検証の同梱のエンジン）
  const formulaVer = Number(engine.source.pluginVersion);
  if (!(formulaVer >= FV_MIN_FORMULA_VERSION)) findings.error("plugin.version", engine.source.from, `計算式プラグインの zip が Ver.${engine.source.pluginVersion}（項目検証の式の評価には Ver.${FV_MIN_FORMULA_VERSION} 以降の zip が要る。試用版でよい）`);
  if (findings.hasErrors) return done();
  const bundled = engineOfFv(fvVersion);
  if (bundled && bundled.engineSha256 !== engine.source.engineSha256) {
    findings.info("engine.differs", file, `計算式 Ver.${engine.source.pluginVersion} の zip のエンジンで評価する（項目検証 Ver.${fvVersion} の同梱は計算式 Ver.${bundled.formulaVersion} 相当。関数の結果が少し違うことがある）`);
  }
  if (fvVersion > FV_ENGINES[FV_ENGINES.length - 1].fvVersion) findings.info("envelope.version", file, `Ver.${fvVersion} の設定（tools が知る項目検証は Ver.${FV_ENGINES[FV_ENGINES.length - 1].fvVersion} まで。新しい版で増えた規則は検査しない）`);

  // 3. 元の値 → 全部の式を集めて、dq を止めた間に走査（評価の前に更新系の関数を止める）
  const source = fvSourceOf(raw);
  const slots = slotsOf(file, source.pluginInfos);
  const tags = engine.api.FUNCTION_TAGS as Record<string, readonly string[]>;
  const update = fvUpdateFunctions(tags.sideEffect ?? []);
  const functionNames = new Set(engine.functionNames());
  const codes = new Set(Object.keys(fields.properties).flatMap((c) => [c, ...Object.keys((fields.properties[c] as { fields?: object }).fields ?? {})]));
  const dqBefore = engine.dqCount();
  const scans: Array<{ slot: Slot; scan: ScanResult }> = [];
  engine.blockDq(true);
  try {
    for (const slot of slots) scans.push({ slot, scan: scanFormula(fvStrip(slot.text)) });
  } finally {
    engine.blockDq(false);
  }
  if (engine.dqCount() !== dqBefore) findings.error("tools.internal", file, "走査の間に式を評価した（tools の誤り）");
  const kinds = { context: new Set<string>(), event: new Set<string>(), users: new Set<string>() };
  for (const { slot, scan } of scans) {
    const names = Object.keys(scan.functions);
    for (const p of scan.problems) findings.error("formula.syntax", slot.where, p);
    const bad = names.filter((n) => update.has(n));
    if (bad.length) findings.error("formula.update", slot.where, `項目検証では使わない更新系の関数: ${bad.join(", ")}（表示・値の変更のたびに評価されるので、値を変える・テーブルを作る関数は置かない）${slot.on ? "" : "。「使う」がオフの行でも置かない"}`);
    const unknown = names.filter((n) => !functionNames.has(n));
    if (unknown.length) findings.error("formula.function", slot.where, `計算式 Ver.${engine.source.pluginVersion} に無い関数: ${unknown.join(", ")}`);
    const volatile = names.filter((n) => (tags.volatile ?? []).includes(n));
    if (volatile.length) findings.warning("formula.volatile", slot.where, `表示・値の変更のたびに結果が変わる関数: ${volatile.join(", ")}`);
    for (const n of names) {
      if ((tags.kintoneContext ?? []).includes(n)) kinds.context.add(n);
      if ((tags.event ?? []).includes(n)) kinds.event.add(n);
      if ((tags.userInfo ?? []).includes(n)) kinds.users.add(n);
    }
    if (cutInString(slot.text)) findings.warning("formula.strip", slot.where, "文字列定数（\"…\"）の中に // か改行がある（保存で // から行末と改行が消え、式が切れる。URL は文字列をつないで書く）");
    if (slot.message && !scan.strings.length && !names.length && scan.identifiers.size && [...scan.identifiers].every((x) => codes.has(x))) {
      findings.warning("message.form", slot.where, "メッセージが項目の値だけ（メッセージも式。文は \"…\" で囲む）");
    }
  }
  if (kinds.context.size) findings.info("formula.context", file, `ログインユーザー・アプリの文脈で変わる関数: ${[...kinds.context].join(", ")}（fv check の --user で確かめる）`);
  if (kinds.event.size) findings.info("event.depends", file, `イベントで結果が変わる関数: ${[...kinds.event].join(", ")}（fv check の --event で、表示・値の変更・保存の前を確かめる）`);
  if (kinds.users.size) findings.info("users", file, `ユーザー情報の関数: ${[...kinds.users].join(", ")}（レコードの画面でユーザー情報を読み込む。fv check は既定のテストデータか --users）`);
  if (findings.hasErrors) return done();

  // 4. 行と突き合わせ、列ごとの型
  const { pp, crec } = fvPropsOf(fields.properties as unknown as Record<string, FvProp>);
  const rows = fvRowsOf(pp, (fields.layout ?? []) as never);
  const applied = fvApplySource(rows, source);
  for (const code of applied.missing) findings.error("field.missing", `${file} ${code}`, "今のアプリに無い行（項目が消えたか、フィールドコード・要素 ID が変わった）");
  for (const code of applied.missingChildren) findings.error("field.missing", `${file} ${code}`, "テーブルに無い子（テーブル内非表示）");
  const byCode = new Map(rows.map((r) => [r.fieldcode, r]));
  for (const info of source.pluginInfos) {
    const row = byCode.get(info.fieldcode);
    if (!row) continue;
    const where = `${file} ${info.fieldcode}（${row.type}）`;
    const deny = (column: keyof typeof FV_COLUMN_DENY, label: string, set: boolean): void => {
      if (set && FV_COLUMN_DENY[column].includes(row.type)) findings.error("field.column", where, `${label}は置けない型`);
    };
    deny("formulaSet", "必須条件", !!info.formulaSet && !(row.required && info.formulaSet === "1"));
    deny("disabledSet", "入力不可", !!info.disabledSet);
    deny("init", "初期化", info.init);
    deny("condInfos", "検証条件", info.condInfos.some((c) => c.state || c.condSet || c.jaSet || c.enSet || c.zhSet));
    deny("tblfields", "テーブル内非表示", (info.tblfields ?? []).some((t) => t.state || t.hideSet));
    if (row.required && info.formulaSet && info.formulaSet !== "1") findings.warning("required.form", where, `フォームで必須の項目の必須条件は "1"（設定画面が "1" に戻す。書いた式 ${JSON.stringify(info.formulaSet.slice(0, 40))} は使われない）`);
    if (info.init && !info.hideSet) findings.warning("init.nohide", where, "初期化がオンだが非表示の式が無い（隠れないので初期化されない）");
    if (info.state && info.hideSet && info.formulaSet && !row.required) findings.info("required.hidden", where, "非表示の式と必須条件の両方がある（隠れている間は必須にならない）");
    // フォームで必須の項目の必須条件 "1" は設定画面が入れるもので、「使う」がオフでも書いてある
    const ownRequired = !!info.formulaSet && !(row.required && info.formulaSet === "1");
    if (!info.state && (ownRequired || info.disabledSet || info.hideSet || info.condInfos.some((c) => c.state))) {
      findings.warning("state.off", where, "「使う」がオフなので、式は効かない（保存値の pluginFields に入らない）");
    }
  }
  const added = rows.filter((r) => r.required && !seen.has(r.fieldcode)).map((r) => r.fieldcode);
  if (added.length) findings.info("rows.required", file, `フォームで必須の項目は、設定が無くても必須条件 "1" の行になる: ${added.join(", ")}`);
  if (findings.hasErrors) return done();

  // 5. 式の検査と派生値（ここで初めて dq。ユーザー情報は UINFO 系の検査のため既定のテストデータか --users）
  engine.setContext({ usersInfo: input.usersInfo ?? defaultUsersInfo(), usersOrigin: input.usersOrigin ?? { kind: "default" } });
  const errors = quiet(() => fvDerive({ engine, pp, crec }, rows));
  for (const e of errors) {
    const where = `${file} ${e.fieldcode} ${e.column === "condInfos" ? `検証条件 ${(e.index ?? 0) + 1}${e.part ? ` ${e.part}` : ""}` : e.column === "tblfields" ? `テーブル内非表示 ${e.part ?? ""}` : e.column}`;
    if (e.on) findings.error(e.message.startsWith("空にできない") ? "cond.empty" : "formula.error", where, engineText(e.message));
    else findings.warning("formula.off-error", where, `「使う」がオフの行の誤り（今は効かないが、オンにすると保存で止まる）: ${engineText(e.message)}`);
  }
  if (findings.hasErrors) return done({ fvVersion });

  // 6. 保存値と大きさ（内部番号は設定画面が保存のときに付ける）
  const saved = fvBuildSaved(rows, pp, source);
  let size: FvNormalizeResult["size"];
  try {
    const stored = await engine.api.writeConfig(saved as never, "compressed");
    const bytes = Object.values(stored as Record<string, string>).reduce((n, v) => n + Buffer.byteLength(String(v), "utf8"), 0);
    // 内部番号（fieldno / ptno）は pluginFields の行に入る。1 行あたり安全側に 40 バイトを上乗せして見積もる
    const margin = (saved.pluginFields as unknown[]).length * 40;
    const max = (engine.api.DEFAULT_LIMITS as { maxTotalBytes: number }).maxTotalBytes;
    size = { bytes, keys: Object.keys(stored as object).length };
    if (bytes + margin > max) {
      findings.error("size.limit", file, `保存値 ${bytes.toLocaleString()} バイト + 内部番号の見積もり ${margin.toLocaleString()} が上限 ${max.toLocaleString()} を超える（設定画面の保存で止まる）`);
      return done();
    }
    findings.info("size.bytes", file, `保存値 ${bytes.toLocaleString()} バイト（${size.keys} キー。内部番号の見積もり +${margin.toLocaleString()}。上限 ${max.toLocaleString()}）`);
  } catch {
    // 計算式の zip の kit の上限で止まった（文は zip のコードのものなので出さない）
    findings.error("size.limit", file, "保存値を作れない（大きさの上限を超えた）");
    return done();
  }
  if (saved.pluginUOG) findings.info("users", file, "pluginUOG = true（ユーザー情報を使う式がある）");
  findings.info("numbers", file, "内部番号（fieldno / ptno）は、設定画面で取り込んで保存するときに付く");

  // 7. 出力（元の値だけの封筒。設定画面で取り込むと、保存の前の行と同じになる）
  const body: Record<string, unknown> = { ...source, pluginInfos: outputInfos(rows) };
  const meta = { pluginName: FV_PLUGIN_NAME, pluginId: FV_CONFIG_PLUGIN_ID, pluginVersion: String(fvVersion), appId: fields.appId, appName: String(raw.appName ?? fields.appName) };
  const output = engine.api.buildExportData(meta, body, (input.now ?? (() => new Date()))()) as unknown as Record<string, unknown>;
  let checkDiffs: string[] | undefined;
  if (input.check) {
    checkDiffs = [];
    jsonDiff({ ...source }, body, "$", checkDiffs);
  }
  return done({ output, saved, source, rows, pp, size, checkDiffs, appId: appId as number });
}

/** 行から元の値の pluginInfos（設定のある行。設定画面の保存と同じ並び = レイアウトの順） */
export function outputInfos(rows: readonly FvRow[]): FvSourceInfo[] {
  return rows.filter(fvHasSetting).map((r) => {
    const info: FvSourceInfo = {
      fieldcode: r.fieldcode, state: r.state, formulaSet: r.formulaSet, disabledSet: r.disabledSet, hideSet: r.hideSet, init: r.init,
      condInfos: r.condInfos.map((c) => ({ state: c.state, condSet: c.condSet, jaSet: c.jaSet, enSet: c.enSet, zhSet: c.zhSet }))
    };
    if (r.tblfields) info.tblfields = r.tblfields.map((t) => ({ fieldcode: t.fieldcode, state: t.state, hideSet: t.hideSet }));
    return info;
  });
}
