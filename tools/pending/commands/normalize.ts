/**
 * normalize <settings.json> --fields <fields.json> [--out <file>] [--check] [--dry-run] [--json]
 * AI が書いた封筒形式の設定 JSON を、設定画面と同じ手順で派生値を作り直し（derive.ts）、検査して（checks.ts）、保存値の大きさを測り（size.ts）、
 * エラーが無ければ封筒形式で書き出す（date を更新）。--check は入力の派生値と生成した値の差を出す（AI の自己点検、エクスポートの往復の確認）。
 * 印刷屋のコード（スキーマ、派生値、kit の検証）は利用者の zip の authoring API（engine.api）から。終了コード: エラーがあれば 1（書き出さない）。
 * 1-10 レビュー: 入力は kit の parseJsonSafely（4 MB、深さ、配列の上限）で読む（MAJOR 2）、派生値はスキーマで検証した値から作る（MAJOR 1。
 * 互換のために受ける "false" などの緩い真偽値を !!x で真にしない）、appId は正の整数（MAJOR 1）。
 */
import { readFileSync, statSync } from "node:fs";
import { jsonErrorText, jsonErrorWhere } from "../json-error.ts";
import path from "node:path";
import type { Engine } from "../engine.ts";
import type { FieldsFile } from "./fields.ts";
import { Findings } from "../normalize/findings.ts";
import { isSupportedPluginVersion, MIN_PLUGIN_VERSION } from "../meta.ts";
import { buildModel } from "../normalize/model.ts";
import { bodyOf, deriveBody, ENVELOPE_KEYS } from "../normalize/derive.ts";
import { checkBody } from "../normalize/checks.ts";
import { loadPolicy, type Policy } from "../normalize/policy.ts";
import { formatSize, measureStored, type StoredSize } from "../normalize/size.ts";

export const PLUGIN_NAME = "印刷屋プラグイン";
/** fields / record / 設定 JSON のファイルの上限（設定 JSON はさらに kit の 4 MB） */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export class InputError extends Error {}

export interface NormalizeInput {
  settingsText: string;
  settingsFile?: string;
  fields: FieldsFile;
  engine: Engine;
  policy?: Policy;
  check?: boolean;
  /** .env の KINTONE_BASE_URL（検証済み）。iframe の同一オリジンの判定はこちらを使い、fields の baseUrl と違えば警告 */
  baseUrl?: string;
  now?: () => Date;
}

export interface NormalizeResult {
  findings: Findings;
  output?: Record<string, unknown>;
  body?: Record<string, unknown>;
  size?: StoredSize;
  checkDiffs?: string[];
  summary: string;
}

const pad = (n: number): string => String(n).padStart(2, "0");
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 2 つの値の差を path 付きで集める（短く） */
export function jsonDiff(a: unknown, b: unknown, pathStr: string, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) jsonDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${pathStr}.${k}`, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => jsonDiff(x, b[i], `${pathStr}[${i}]`, out));
    return;
  }
  const short = (v: unknown): string => {
    const s = JSON.stringify(v);
    return s === undefined ? "undefined" : s.length > 100 ? s.slice(0, 100) + "…" : s;
  };
  out.push(`${pathStr}: ${short(a)} → ${short(b)}`);
}

export async function normalizeSettings(input: NormalizeInput): Promise<NormalizeResult> {
  const f = new Findings();
  const api = input.engine.api;
  const pluginVersion = api.pluginVersion;
  const where = input.settingsFile ?? "settings";
  let envelope: Record<string, unknown>;
  try {
    envelope = api.parseJsonSafely(input.settingsText, api.CONFIG_LIMITS) as Record<string, unknown>;
  } catch (e) {
    f.error("json", where, `JSON として読めない、または大きすぎる（${api.CONFIG_LIMITS.maxBytes.toLocaleString()} バイトまで）: ${jsonErrorText(e)}`);
    return { findings: f, summary: "JSON を読めない" };
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    f.error("json", where, "JSON の最上位はオブジェクト（封筒形式）");
    return { findings: f, summary: "封筒形式でない" };
  }
  // ---- 封筒 ----
  if (envelope.pluginID !== api.pluginId) f.error("envelope.pluginID", where, `pluginID は "${api.pluginId}": ${JSON.stringify(envelope.pluginID)}（封筒なしの素の設定は作らない）`);
  // PluginVersion（1.1.0。印刷屋の版を上げても前の版で作った設定をそのまま使えるように）: zip の版と同じか、それより古い印刷屋の版（Ver.6 以上）なら通し、
  // 書き出す封筒は zip の版にする（印刷屋の取り込みは PluginVersion を見ず、設定の形は zip の CONFIG_SCHEMA で検証する）。
  // zip より新しい版の設定は、古い zip の検査で新しいキーを落とすので止める
  const envVersion = String(envelope.PluginVersion ?? "");
  if (!isSupportedPluginVersion(envVersion)) f.error("envelope.version", where, `PluginVersion は印刷屋の版（Ver.${MIN_PLUGIN_VERSION} 以降、zip は ${pluginVersion}）: ${JSON.stringify(envelope.PluginVersion)}`);
  else if (Number(envVersion) > Number(pluginVersion)) f.error("envelope.version", where, `PluginVersion ${envVersion} の設定を、それより古い印刷屋の zip（版 ${pluginVersion}）で検査しようとしている。アプリに入れた版の zip を .env の FORMULA_PLUGIN_ZIP に書く`);
  else if (envVersion !== pluginVersion) f.info("envelope.version.upgrade", where, `PluginVersion ${envVersion} の設定を印刷屋の版 ${pluginVersion}（zip）で検査し、書き出す封筒は ${pluginVersion} にする`);
  if (envelope.appId !== undefined) {
    if (typeof envelope.appId !== "number" || !Number.isInteger(envelope.appId) || envelope.appId <= 0) f.error("envelope.appId", where, `appId は正の整数（数値）: ${JSON.stringify(envelope.appId)}`);
    else if (envelope.appId !== input.fields.appId) f.warning("envelope.appId", where, `appId ${envelope.appId} が fields のアプリ ${input.fields.appId} と違う`);
  }
  if (f.hasErrors) return { findings: f, summary: "封筒の誤り" };

  // ---- 設定本体のスキーマ ----
  const inputBody = bodyOf(envelope);
  let inputClean: Record<string, unknown>;
  try {
    inputClean = api.validate<Record<string, unknown>>(inputBody, api.CONFIG_SCHEMA, api.CONFIG_LIMITS);
  } catch (e) {
    if (e instanceof api.ValidationError) {
      f.error("schema", where, `設定のスキーマに合わない: ${e.message}`);
      return { findings: f, summary: "スキーマの誤り" };
    }
    throw e;
  }

  // ---- 派生値（検証済みの値から）→ 検査 → 大きさ ----
  const model = buildModel(input.fields, api, input.baseUrl);
  if (input.baseUrl && typeof input.fields.baseUrl === "string" && input.fields.baseUrl && model.fieldsBaseUrl !== input.baseUrl) {
    f.warning("fields.baseUrl", where, `fields の baseUrl（${input.fields.baseUrl.slice(0, 60)}）が .env の KINTONE_BASE_URL と違う。iframe の判定は .env の接続先で行う。fields を取り直すなら npx @rex0220/formula-authoring-tools fields --app ${input.fields.appId}`);
  }
  const body = deriveBody(JSON.parse(JSON.stringify(inputClean)) as Record<string, unknown>, model, input.engine, f);
  const policy = input.policy ?? { allowExternal: [] };
  await checkBody(body, model, f, { policy, settingsFile: input.settingsFile });
  let cleaned: Record<string, unknown>;
  try {
    cleaned = api.validate<Record<string, unknown>>(body, api.CONFIG_SCHEMA, api.CONFIG_LIMITS);
  } catch (e) {
    if (e instanceof api.ValidationError) {
      f.error("schema", where, `正規化した設定がスキーマに合わない: ${e.message}`);
      return { findings: f, body, summary: "スキーマの誤り" };
    }
    throw e;
  }
  const size = await measureStored(cleaned, api);
  if (!size.ok) f.error("size", where, formatSize(size));
  else f.info("size", where, formatSize(size));

  let checkDiffs: string[] | undefined;
  if (input.check) {
    checkDiffs = [];
    jsonDiff(inputClean, cleaned, "$", checkDiffs);
  }

  const rows = (cleaned.pluginInfos ?? []) as Array<{ menu: string; state: boolean }>;
  const summary = `アプリ ${input.fields.appId} ${input.fields.appName}、ボタン ${rows.length}（有効 ${rows.filter((r) => r.state).length}）`;
  if (f.hasErrors) return { findings: f, body: cleaned, size, checkDiffs, summary };
  const now = (input.now ?? (() => new Date()))();
  const output: Record<string, unknown> = {
    date: formatDate(now),
    pluginName: typeof envelope.pluginName === "string" && envelope.pluginName ? envelope.pluginName : PLUGIN_NAME,
    pluginID: api.pluginId,
    PluginVersion: pluginVersion,
    appId: input.fields.appId,
    appName: typeof envelope.appName === "string" && envelope.appName ? envelope.appName : input.fields.appName
  };
  for (const k of ENVELOPE_KEYS) if (!(k in output)) output[k] = envelope[k];
  Object.assign(output, cleaned);
  return { findings: f, output, body: cleaned, size, checkDiffs, summary };
}

/** 大きさの上限を確かめてからテキストを読む */
export function readTextLimited(file: string, maxBytes = MAX_INPUT_BYTES): string {
  const size = statSync(file).size;
  if (size > maxBytes) throw new InputError(`${file} が大きすぎる（${size.toLocaleString()} バイト。上限 ${maxBytes.toLocaleString()}）`);
  return readFileSync(file, "utf8");
}

/** 大きさの上限を確かめてから JSON を読む（最上位はオブジェクト）。読めないときの文は位置だけ（中身を入れない） */
export function readJsonLimited(file: string, maxBytes = MAX_INPUT_BYTES): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(readTextLimited(file, maxBytes));
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError(`${file} を JSON として読めない${jsonErrorWhere(e)}（中身は表示しない）`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InputError(`${file} の最上位はオブジェクト`);
  return v as Record<string, unknown>;
}

export async function readFieldsFile(file: string): Promise<FieldsFile> {
  const fields = readJsonLimited(file) as unknown as FieldsFile;
  if (!fields.properties || typeof fields.properties !== "object") throw new InputError(`${file} は fields コマンドの出力ではない（properties が無い）`);
  if (typeof fields.appId !== "number" || !Number.isInteger(fields.appId) || fields.appId <= 0) throw new InputError(`${file} の appId が正の整数でない`);
  return fields;
}

export function relativeSettingsPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return rel.startsWith("..") ? file : rel.replace(/\\/g, "/");
}

export { loadPolicy };
