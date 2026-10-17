/**
 * 利用者の承認（docs/authoring-plan.md 12.3、Codex BLOCKER 1。1-10 レビュー MAJOR 5 で形の検証とパスの正規化を足した）。
 * 承認は AI が書けない場所 policy/authoring-policy.json に置く（テンプレートの .claude/settings.json で policy/ への書き込みを許可しない。
 * 利用者が手で編集する）。場所は固定で、CLI から別のファイルを指定できない（1-10 レビュー BLOCKER 5）。
 * {
 *   "allowExternal": [
 *     { "origin": "https://cdn.example.com", "files": ["settings/見積書.json"], "note": "社印の画像" },
 *     { "url": "https://example.com/logo.png" }
 *   ],
 *   "allowExternalRefs": ["settings/見積書.json"]
 * }
 * allowExternal: 外部 URL の承認。origin か url のどちらかで照合し、files があればその設定ファイル（リポジトリのルートからの相対パス）に限る。
 *   Web フォントの Google Fonts（fonts.googleapis.com / fonts.gstatic.com）は既定で許す。
 *   印刷屋 Ver.6 は帳票の HTML / CSS の kintone 以外への読み込みを描画の前に除くので、この承認が効くのは Web フォント（fontInfo.cssUrl。印刷屋は除かない）と、
 *   externalRefs を "allow" にした設定の HTML / CSS だけ（既定の "block" では外部 URL はエラー。承認しても帳票に出ない）
 * allowExternalRefs: 共通の設定「外部参照」を "allow"（Ver.5 と同じく何も除かない。自己責任）にしてよい設定ファイルの一覧（Takashi 2026-10-04）。
 *   無い設定ファイルの "allow" はエラー
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { jsonErrorWhere } from "../json-error.ts";
import path from "node:path";
import { cleanUrl } from "./css-check.ts";

export interface AllowRule {
  origin?: string;
  url?: string;
  files?: string[];
  note?: string;
}

export interface Policy {
  allowExternal: AllowRule[];
  /** externalRefs: "allow" を許す設定ファイル（正規化した相対パス） */
  allowExternalRefs?: string[];
  /** 読んだファイル（無ければ undefined） */
  file?: string;
}

export class PolicyError extends Error {}

export const POLICY_FILE = path.join("policy", "authoring-policy.json");
export const DEFAULT_ALLOWED_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_RULES = 200;
const MAX_FILES = 100;

/** 相対パスの正規化（\ → /、./ を外す、連続する / を 1 つに。Windows は小文字に）。.. や絶対パスは使えない */
export function normalizeRel(p: string): string {
  let s = String(p).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s) || s.split("/").includes("..")) throw new PolicyError(`files は作業フォルダーからの相対パスで書く（.. や絶対パスは使えない）: ${p}`);
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function fail(file: string, where: string, msg: string): never {
  throw new PolicyError(`${file} の形が不正（${where}）: ${msg}`);
}

/** policy の JSON を検証して読む（未知のキー、型、件数、URL の形） */
export function parsePolicy(text: string, file: string): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(file, "$", `JSON として読めない${jsonErrorWhere(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(file, "$", "最上位はオブジェクト");
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== "allowExternal" && k !== "allowExternalRefs") fail(file, `$.${k}`, "使えるキーは allowExternal と allowExternalRefs だけ");
  let allowExternalRefs: string[] | undefined;
  if (obj.allowExternalRefs !== undefined) {
    const files = obj.allowExternalRefs;
    if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) fail(file, "$.allowExternalRefs", "設定ファイルの相対パスの配列で書く");
    if (files.length > MAX_FILES) fail(file, "$.allowExternalRefs", `${MAX_FILES} 件まで`);
    allowExternalRefs = (files as string[]).map((f) => {
      try {
        return normalizeRel(f);
      } catch (e) {
        return fail(file, "$.allowExternalRefs", (e as Error).message);
      }
    });
  }
  const list = obj.allowExternal ?? [];
  if (!Array.isArray(list)) fail(file, "$.allowExternal", "配列で書く");
  if (list.length > MAX_RULES) fail(file, "$.allowExternal", `${MAX_RULES} 件まで`);
  const rules: AllowRule[] = [];
  list.forEach((r, i) => {
    const at = `$.allowExternal[${i}]`;
    if (!r || typeof r !== "object" || Array.isArray(r)) fail(file, at, "オブジェクトで書く");
    const o = r as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["origin", "url", "files", "note"].includes(k)) fail(file, `${at}.${k}`, "使えるキーは origin / url / files / note");
    const rule: AllowRule = {};
    if (o.origin !== undefined) {
      if (typeof o.origin !== "string") fail(file, `${at}.origin`, "文字列で書く");
      let u: URL;
      try {
        u = new URL(o.origin);
      } catch {
        fail(file, `${at}.origin`, `URL として読めない: ${o.origin}`);
      }
      if (u.protocol !== "https:" || u.username || u.password || u.origin !== o.origin.replace(/\/$/, "")) fail(file, `${at}.origin`, `https のオリジンだけを書く（例 https://cdn.example.com）: ${o.origin}`);
      rule.origin = u.origin;
    }
    if (o.url !== undefined) {
      if (typeof o.url !== "string") fail(file, `${at}.url`, "文字列で書く");
      let u: URL;
      try {
        u = new URL(o.url);
      } catch {
        fail(file, `${at}.url`, `URL として読めない: ${o.url}`);
      }
      if (u.protocol !== "https:" || u.username || u.password) fail(file, `${at}.url`, `https の完全な URL を書く: ${o.url}`);
      rule.url = u.href;
    }
    if (rule.origin === undefined && rule.url === undefined) fail(file, at, "origin か url のどちらかが要る");
    if (o.files !== undefined) {
      if (!Array.isArray(o.files) || o.files.some((f) => typeof f !== "string")) fail(file, `${at}.files`, "文字列の配列で書く");
      if (o.files.length > MAX_FILES) fail(file, `${at}.files`, `${MAX_FILES} 件まで`);
      rule.files = (o.files as string[]).map((f) => {
        try {
          return normalizeRel(f);
        } catch (e) {
          return fail(file, `${at}.files`, (e as Error).message);
        }
      });
    }
    if (o.note !== undefined) {
      if (typeof o.note !== "string") fail(file, `${at}.note`, "文字列で書く");
      rule.note = o.note;
    }
    rules.push(rule);
  });
  return { allowExternal: rules, ...(allowExternalRefs ? { allowExternalRefs } : {}), file };
}

/** 設定ファイルが externalRefs: "allow" を使ってよいか（settingsFile は cwd からの相対パス。分からなければ許さない） */
export function isExternalRefsAllowed(policy: Policy, settingsFile?: string): boolean {
  if (!policy.allowExternalRefs?.length || !settingsFile) return false;
  try {
    return policy.allowExternalRefs.includes(normalizeRel(settingsFile));
  } catch {
    return false;
  }
}

/** リポジトリ（cwd）の policy/authoring-policy.json を読む。無ければ承認なし */
export function loadPolicy(opt: { cwd: string }): Policy {
  const file = path.join(opt.cwd, POLICY_FILE);
  if (!existsSync(file)) return { allowExternal: [] };
  if (statSync(file).size > MAX_POLICY_BYTES) throw new PolicyError(`${file} が大きすぎる（${MAX_POLICY_BYTES} バイトまで）`);
  return parsePolicy(readFileSync(file, "utf8"), file);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hrefOf(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

/** URL が承認済みか（settingsFile は cwd からの相対パス） */
export function isAllowed(policy: Policy, url: string, settingsFile?: string): boolean {
  const u = cleanUrl(url);
  const origin = originOf(u);
  const href = hrefOf(u);
  if (origin && DEFAULT_ALLOWED_ORIGINS.includes(origin)) return true;
  let rel: string | undefined;
  if (settingsFile) {
    try {
      rel = normalizeRel(settingsFile);
    } catch {
      rel = undefined;
    }
  }
  for (const r of policy.allowExternal) {
    const hit = (r.url && href && r.url === href) || (r.origin && origin && r.origin === origin);
    if (!hit) continue;
    if (r.files && r.files.length) {
      if (!rel) continue;
      if (!r.files.includes(rel)) continue;
    }
    return true;
  }
  return false;
}
