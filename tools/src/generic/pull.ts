/**
 * アプリに保存されているプラグインの設定を kintone から読む（汎用の入口の pull）。
 *
 * - API は kintone の API ラボ「アプリに追加されているプラグインの設定情報を取得する」
 *   （GET /k/v1/app/plugin/config.json、動作テスト環境は /k/v1/preview/app/plugin/config.json。計算式の pull と同じ。tools は GET だけ）。
 *   使うには cybozu.com 共通管理者が「検討中の新機能」で有効にしている必要がある。使えない環境では、設定画面の「設定をダウンロード」を使う
 * - 保存値は、設定画面（plugin-config-kit の config-store）の compressed の形だけを読む:
 *     { compress: "2", json }  または  { compress: "2", json: "split", split: "N", json0..json(N-1) }
 *     値 = base64( zlib( utf8( encodeURIComponent(JSON) ) ) )
 *   Node の zlib でほどく（kit のコードも zip のコードも使わない。決まりは kit の joinSplit / readCompressed2 と同じ）。
 *   ほかの形（平文、昔の "Y"）は読まない（この入口が扱うプラグインは compressed だけ）
 * - ほどいた値をどう読むか（スキーマ、古い形の扱い、元の値への変換）は、プラグインの zip の authoring API（toSource）が決める。ここは決めない
 * - 返すのは、ほどいた保存値とアプリの名前・リビジョン。**保存値には更新者の名前などが入っているので、呼ぶ側はそのまま利用者や AI に返さない**（toSource に渡す）
 */
import { inflateSync } from "node:zlib";
import { RestError, type RestClient } from "../kintone-rest.ts";
import type { GenericPlugin } from "./registry.ts";

type Json = Record<string, unknown>;

/** 保存値を読むときの上限（kit の DEFAULT_LIMITS と同じ） */
export interface StoredLimits {
  /** kintone: 1 値あたり最大 65,535 文字 */
  maxValueLength: number;
  /** split の最大個数 */
  maxSplitCount: number;
  /** ほどいた後の文字列の最大長 */
  maxDecodedLength: number;
}
export const STORED_LIMITS: StoredLimits = { maxValueLength: 65535, maxSplitCount: 8, maxDecodedLength: 4 * 1024 * 1024 };

export type StoredConfigErrorCode = "empty" | "bad-shape" | "bad-split" | "too-large" | "bad-base64" | "bad-compressed" | "bad-json" | "unsupported-compress";

/** 保存値をほどけない（形が違う、壊れている、大きすぎる、扱わない形） */
export class StoredConfigError extends Error {
  readonly code: StoredConfigErrorCode;
  constructor(message: string, code: StoredConfigErrorCode) {
    super(message);
    this.name = "StoredConfigError";
    this.code = code;
  }
}

/** API で設定を読めない（API ラボが無効、権限が無い、プラグインが入っていない、など）。hint に、利用者に伝える代わりの道 */
export class GenericPullError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly hint: string;
  constructor(message: string, status: number, code: string | undefined, hint: string) {
    super(message);
    this.name = "GenericPullError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** json / json0..N をつなぐ（kit の joinSplit と同じ決まり） */
function joinStored(stored: Record<string, string>, limits: StoredLimits): string {
  if (stored.json !== "split") return stored.json ?? "";
  if (!/^[1-9][0-9]*$/.test(stored.split ?? "")) throw new StoredConfigError("保存値の split が正の整数でない", "bad-split");
  const count = Number(stored.split);
  if (count > limits.maxSplitCount) throw new StoredConfigError(`保存値の split（${count}）が上限（${limits.maxSplitCount}）を超える`, "bad-split");
  let out = "";
  for (let i = 0; i < count; i++) {
    const part = stored[`json${i}`];
    if (typeof part !== "string") throw new StoredConfigError(`保存値の json${i} が無い`, "bad-split");
    out += part;
  }
  return out;
}

/**
 * kintone のプラグインの設定（キーと文字列の値）を、保存値のオブジェクトにほどく。
 * 読むのは compress: "2" だけ。kintone には行かない
 */
export function decodeStoredConfig(stored: unknown, limits: StoredLimits = STORED_LIMITS): Json {
  if (!isObject(stored)) throw new StoredConfigError("プラグインの設定がオブジェクトでない", "bad-shape");
  if (Object.keys(stored).length === 0) throw new StoredConfigError("プラグインの設定が空", "empty");
  for (const [k, v] of Object.entries(stored)) {
    if (typeof v !== "string") throw new StoredConfigError(`プラグインの設定の値が文字列でない: ${k}`, "bad-shape");
    if (v.length > limits.maxValueLength) throw new StoredConfigError(`プラグインの設定の値が長すぎる: ${k}`, "too-large");
  }
  const s = stored as Record<string, string>;
  if (s.compress !== "2") {
    throw new StoredConfigError(`この形の保存値は読めない（compress: ${s.compress === undefined ? "なし" : JSON.stringify(s.compress)}。読めるのは "2" だけ）`, "unsupported-compress");
  }
  const b64 = joinStored(s, limits).replace(/\s+/g, "");
  if (b64 === "") throw new StoredConfigError("プラグインの設定が空", "empty");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 === 1) throw new StoredConfigError("保存値が base64 でない", "bad-base64");
  let encoded: string;
  try {
    encoded = inflateSync(Buffer.from(b64, "base64"), { maxOutputLength: limits.maxDecodedLength }).toString("utf8");
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === "ERR_BUFFER_TOO_LARGE") throw new StoredConfigError("ほどいた保存値が大きすぎる", "too-large");
    throw new StoredConfigError(`保存値をほどけない（zlib）: ${e instanceof Error ? e.message : String(e)}`, "bad-compressed");
  }
  let text: string;
  try {
    text = decodeURIComponent(encoded);
  } catch {
    throw new StoredConfigError("保存値をほどけない（decodeURIComponent）", "bad-compressed");
  }
  if (text.length > limits.maxDecodedLength) throw new StoredConfigError("ほどいた保存値が大きすぎる", "too-large");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new StoredConfigError("保存値が JSON でない", "bad-json");
  }
  if (!isObject(data)) throw new StoredConfigError("保存値がオブジェクトでない", "bad-json");
  return data;
}

export interface FetchStoredOptions {
  app: number;
  /** 動作テスト環境の設定を読む（設定画面が読むものと同じ。アプリ管理の権限が要る）。false は運用環境 */
  preview?: boolean;
  guestSpaceId?: number;
  limits?: StoredLimits;
}

export interface FetchStoredResult {
  /** ほどいた保存値（zip の authoring API の toSource に渡す。そのまま返さない） */
  data: Json;
  appName: string;
  revision: string;
  preview: boolean;
}

/** 設定を読めなかったときに伝える、代わりの道 */
const DOWNLOAD_HINT = "設定画面の「設定をダウンロード」でファイルに出し、作業フォルダーに置いて使う";

/**
 * アプリのプラグインの設定を読んで、ほどく（GET 2 回: アプリの名前、プラグインの設定）。
 * 設定が空（まだ保存していない、プラグインを入れていない）なら StoredConfigError("empty")、API を呼べなければ GenericPullError
 */
export async function fetchStoredConfig(client: RestClient, plugin: GenericPlugin, opt: FetchStoredOptions): Promise<FetchStoredResult> {
  const preview = opt.preview === true;
  const env = preview ? "動作テスト環境" : "運用環境";
  const app = await client.get<{ name?: string }>("app", { id: opt.app }, opt.guestSpaceId);
  let res: { config?: unknown; revision?: string | number };
  try {
    res = await client.get<{ config?: unknown; revision?: string | number }>(preview ? "preview/app/plugin/config" : "app/plugin/config", { app: opt.app, id: plugin.kintonePluginId }, opt.guestSpaceId);
  } catch (e) {
    if (!(e instanceof RestError)) throw e;
    throw new GenericPullError(
      `アプリ ${opt.app} の${plugin.title}プラグインの設定（${env}）を API で読めない（HTTP ${e.status}${e.code ? `、${e.code}` : ""}）: ${e.message}`,
      e.status,
      e.code,
      `この API は kintone の API ラボ（検討中の新機能）のもので、cybozu.com 共通管理者が有効にしていないと使えない。権限は、${preview ? "動作テスト環境はアプリ管理" : "運用環境はレコードの閲覧と追加"}。使えないときは、${DOWNLOAD_HINT}`
    );
  }
  const stored = isObject(res.config) ? res.config : {};
  if (Object.keys(stored).length === 0) {
    throw new StoredConfigError(
      `アプリ ${opt.app} の${plugin.title}プラグインの設定が空（${env}。設定画面でまだ保存していないか、${preview ? "" : "保存して運用環境に反映していないか、"}プラグインを追加していない）`,
      "empty"
    );
  }
  let data: Json;
  try {
    data = decodeStoredConfig(stored, opt.limits ?? STORED_LIMITS);
  } catch (e) {
    if (e instanceof StoredConfigError) throw new StoredConfigError(`アプリ ${opt.app} の${plugin.title}プラグインの設定（${env}）: ${e.message}。${DOWNLOAD_HINT}`, e.code);
    throw e;
  }
  return { data, appName: typeof app.name === "string" ? app.name : "", revision: String(res.revision ?? ""), preview };
}
