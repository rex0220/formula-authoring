/**
 * tools の版と、扱う計算式プラグインの zip の決まり（formula/doc/internal/オーサリングツール_実装計画.md 1 章・9 章の工程 0）。
 * 計算式エンジンと authoring API は利用者の zip から読むので、ビルド時に埋めるのは tools の版と commit だけ。プラグインの版は実行時に zip から分かる。
 * zip のコードを実行してよいかは、外側の zip の PUBKEY から出るプラグイン ID が計算式プラグインのもの（FORMULA_PLUGIN_ID）かで決める
 * （print-craft と同じ。2026-10-17 Takashi「2 OK」。SIGNATURE は検証しない）。版は MIN_PLUGIN_VERSION 以上、API の版は SUPPORTED_API_VERSIONS のどれか（engine.ts）。
 * 計算式プラグインの AUTHORING_API_VERSION が上がったら SUPPORTED_API_VERSIONS に足す（formula の CLAUDE.md）。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AUTHORING_ROOT } from "./paths.ts";

declare const __FORMULA_TOOLS_META__: string | undefined;

/** 計算式プラグインの kintone のプラグイン ID（PUBKEY の SHA-256 から。plugin-zip.ts の pluginIdOf。5 変種とも同じ鍵。工程 0 の spike で確認） */
export const FORMULA_PLUGIN_ID = "dhgihghfgfmibkdldkeibboabfnmdpke";
/** tools が扱う計算式プラグインの版の下限（manifest.json の version。authoring API を同梱したのが Ver.101） */
export const MIN_PLUGIN_VERSION = 101;
/** tools が対応する authoring API の版（formula の src/authoring/api.ts の AUTHORING_API_VERSION） */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];

/** 計算式プラグインの版として扱えるか（整数で MIN_PLUGIN_VERSION 以上） */
export function isSupportedPluginVersion(version: string): boolean {
  return /^[1-9]\d{0,5}$/.test(version) && Number(version) >= MIN_PLUGIN_VERSION;
}

/** tools が使う authoring API のキーと型（契約。zip の API がこの形でなければ止める。Ver.101 の 57 キーのうち tools が呼ぶもの） */
export const REQUIRED_API: Record<string, "function" | "object" | "string" | "number"> = {
  apiVersion: "number", pluginVersion: "string", pluginId: "string",
  CONFIG_SCHEMA: "object", CONFIG_LIMITS: "object", TARGET_TYPES: "object", MISC_KEYS: "object", MISC_DEFAULTS: "object", SOURCE_KEYS: "object", DERIVED_KEYS: "object",
  defaultSource: "function", normalizeSource: "function", toSource: "function", toExportBody: "function", sourceInfosOf: "function",
  isTargetType: "function", createCheckRecord: "function", buildLayoutRows: "function", applySaved: "function", rankOf: "function",
  stripFormula: "function", checkFormula: "function", deriveSemantic: "function", formulaFunctionNames: "function", createChecker: "function", createRunner: "function",
  FUNCTION_TAGS: "object", functionTagsOf: "function",
  calcRecord: "function", convertRecord: "function", fieldsToFetch: "function", BULK_MAX_TABLE_ROWS: "number",
  planFieldImport: "function", mergeSource: "function",
  validate: "function", parseJsonSafely: "function", ValidationError: "function", parseImport: "function", ImportError: "function",
  buildExportData: "function", writeConfig: "function", readConfig: "function", DEFAULT_LIMITS: "object", ConfigStoreError: "function"
};

export function requiredApiFor(_apiVersion: number): Record<string, "function" | "object" | "string" | "number"> {
  return REQUIRED_API;
}

export interface ToolsMeta {
  toolsVersion: string;
  /** 扱う計算式プラグインの zip のプラグイン ID */
  pluginId: string;
  /** 扱う計算式プラグインの版の下限 */
  minPluginVersion: number;
  supportedApiVersions: number[];
  /** tools のリポジトリ（formula-authoring）の commit（作業ツリーに変更があれば +dirty） */
  commit: string;
  builtAt: string;
  mode: "build" | "dev";
}

/** RegExp を文字列にして JSON にする（CONFIG_SCHEMA の pattern を落とさない） */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (x instanceof RegExp ? `/${x.source}/${x.flags}` : x));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** CONFIG_SCHEMA のハッシュ（先頭 12 桁）。プラグインの API から受けた schema で計算する */
export function schemaRevisionOf(schema: unknown): string {
  return sha256Hex(stableJson(schema)).slice(0, 12);
}

export function gitCommit(dir: string): string {
  try {
    const head = execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}

export function devMeta(): ToolsMeta {
  const pkg = JSON.parse(readFileSync(path.join(AUTHORING_ROOT, "package.json"), "utf8")) as { version: string };
  return { toolsVersion: pkg.version, pluginId: FORMULA_PLUGIN_ID, minPluginVersion: MIN_PLUGIN_VERSION, supportedApiVersions: [...SUPPORTED_API_VERSIONS], commit: gitCommit(AUTHORING_ROOT), builtAt: "", mode: "dev" };
}

export function toolsMeta(): ToolsMeta {
  if (typeof __FORMULA_TOOLS_META__ === "string") return JSON.parse(__FORMULA_TOOLS_META__) as ToolsMeta;
  return devMeta();
}
