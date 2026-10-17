/**
 * .env の読み方（docs/authoring-plan.md 12.2、12.9 の 4・8・9）。テンプレートが使う kintone 公式 MCP（@kintone/mcp-server）と同じ変数名で、.env は 1 つで済む。
 *   KINTONE_BASE_URL   例 https://example.cybozu.com（必須。*.cybozu.com / *.kintone.com / *.cybozu.cn だけ。kintone-url.ts）
 *   KINTONE_API_TOKEN  API トークン（閲覧権限だけのものを第一候補にする。カンマ区切りで複数可）
 *   KINTONE_USERNAME / KINTONE_PASSWORD   ログインユーザー（トークンが無いとき）
 *   FORMULA_PLUGIN_ZIP  計算式プラグインの zip（計算式エンジンと authoring API をここから読む。プラグイン ID が計算式プラグインのものでなければ読まない。engine.ts）
 *   FORMULA_KINTONE_CONFIG  kintone の接続のファイル（複数の profile。connections.ts。工程 1 の後半）
 *   FORMULA_USER_API_TOKEN  cybozu.com 共通管理の API トークン（users --pull の User API に Bearer で使う。1 接続の形のとき。無ければ KINTONE_USERNAME / KINTONE_PASSWORD）
 * dashboard の authoring テンプレートの KSQL_* も読む（KINTONE_* が無いとき）。OS の環境変数が優先され、.env は足りない分を埋める。値はログや例外の文言に出さない。
 * .env の場所はリポジトリのルート（cwd）に固定。CLI から別の場所を指定できない（1-10 レビュー BLOCKER 5。AI が書けるファイルを .env として読ませない）。
 * 注意: kintone 公式 MCP はトークンとユーザーの両方があるとユーザーを使う。tools はトークンを使う。どちらか 1 つだけ書くのがよい。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { KintoneUrlError, normalizeKintoneBaseUrl } from "./kintone-url.ts";

export interface KintoneAuth {
  baseUrl: string;
  /** kintone アプリの API トークン（X-Cybozu-API-Token。kintone REST API だけ） */
  token?: string;
  username?: string;
  password?: string;
  /** cybozu.com 共通管理の API トークン（Authorization: Bearer。User API だけ。kintone REST API には使わない） */
  bearer?: string;
}

const NAMES = {
  baseUrl: ["KINTONE_BASE_URL", "KSQL_BASE_URL"],
  token: ["KINTONE_API_TOKEN", "KSQL_TOKEN"],
  username: ["KINTONE_USERNAME", "KSQL_USERNAME"],
  password: ["KINTONE_PASSWORD", "KSQL_PASSWORD"],
  pluginZip: ["FORMULA_PLUGIN_ZIP"],
  kintoneConfig: ["FORMULA_KINTONE_CONFIG"],
  userApiToken: ["FORMULA_USER_API_TOKEN"]
} as const;

/** 前後の空白と、対になった外側の " / ' を外す（.env の値と、OS の環境変数の場所・URL。Windows の「パスのコピー」で付く引用符。引用符の中の空白は値のうち） */
export function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) return value.slice(1, -1);
  return value;
}

/** .env の形（KEY=VALUE。# の行と空行は無視。両端の " ' は外す。export KEY=… も可） */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

export interface LoadAuthOptions {
  /** テスト用。CLI からは渡さない（.env は cwd のものだけ） */
  envFile?: string;
  /** 作業フォルダー（.env の場所。WorkContext.root） */
  cwd: string;
  /** 環境変数（WorkContext.env）。中核は process.env を直接読まない */
  env: Readonly<Record<string, string | undefined>>;
}

export class AuthError extends Error {}

/** 値と、その出所（OS の環境変数か .env か）。相対パスの解決の起点を出所で変えるため（段階 0-2 の段 2） */
export interface Picked {
  value: string;
  /** process = OS の環境変数（print-craft MCP では設定項目から作った環境変数）、file = .env */
  source: "process" | "file";
  /** source が file のときの .env のパス */
  file?: string;
}

/**
 * unquoteProcess: OS の環境変数の値から外側の引用符も外す（場所と URL だけ。Windows の「パスのコピー」で付く。
 * 認証情報は外さない＝引用符で始まって終わるパスワードの意味を変えない。Codex 再レビュー MINOR 6）。.env の値は parseDotEnv が外す
 */
function pickerWithSource(opt: LoadAuthOptions, unquoteProcess = false): (names: readonly string[]) => Picked | undefined {
  const osEnv = opt.env;
  const file = envFileOf(opt);
  const fromFile = existsSync(file) ? parseDotEnv(readFileSync(file, "utf8")) : {};
  return (names) => {
    for (const [src, source] of [[osEnv, "process"], [fromFile, "file"]] as const) {
      for (const n of names) {
        const raw = src[n] ?? "";
        const v = source === "process" && unquoteProcess ? unquote(raw) : raw.trim();
        if (v) return { value: v, source, ...(source === "file" ? { file } : {}) };
      }
    }
    return undefined;
  };
}

function picker(opt: LoadAuthOptions, unquoteProcess = false): (names: readonly string[]) => string | undefined {
  const pick = pickerWithSource(opt, unquoteProcess);
  return (names) => pick(names)?.value;
}

export function envFileOf(opt: LoadAuthOptions): string {
  return opt.envFile ?? path.join(opt.cwd, ".env");
}

/** 接続先の URL（検証済み。無ければ undefined） */
export function baseUrlFromEnv(opt: LoadAuthOptions): string | undefined {
  const raw = picker(opt, true)(NAMES.baseUrl);
  if (!raw) return undefined;
  try {
    return normalizeKintoneBaseUrl(raw);
  } catch (e) {
    throw new AuthError(`KINTONE_BASE_URL が不正: ${e instanceof KintoneUrlError ? e.message : String(e)}（https://<サブドメイン>.cybozu.com の形で書く）`);
  }
}

export function loadAuth(opt: LoadAuthOptions): KintoneAuth {
  const pick = picker(opt);
  const file = envFileOf(opt);
  const baseUrl = baseUrlFromEnv(opt);
  if (!baseUrl) throw new AuthError(`KINTONE_BASE_URL が無い（OS の環境変数か .env: ${file}。kintone 公式 MCP と同じ変数。dashboard の KSQL_BASE_URL でもよい）`);
  const token = pick(NAMES.token);
  const username = pick(NAMES.username);
  const password = pick(NAMES.password);
  if (!token && !(username && password)) throw new AuthError("KINTONE_API_TOKEN か、KINTONE_USERNAME と KINTONE_PASSWORD の両方が要る（OS の環境変数か .env）");
  return { baseUrl, token, username: token ? undefined : username, password: token ? undefined : password };
}

/**
 * User API（users --pull）の認証（1 接続の形）: FORMULA_USER_API_TOKEN（cybozu.com 共通管理の API トークン。Bearer）があればそれ、
 * 無ければ KINTONE_USERNAME と KINTONE_PASSWORD（2 要素認証のないアカウント）。kintone アプリの API トークン（KINTONE_API_TOKEN）では User API を呼べない
 */
export function loadUserApiAuth(opt: LoadAuthOptions): KintoneAuth {
  const pick = picker(opt);
  const baseUrl = baseUrlFromEnv(opt);
  if (!baseUrl) throw new AuthError(`KINTONE_BASE_URL が無い（OS の環境変数か .env: ${envFileOf(opt)}）`);
  const bearer = pick(NAMES.userApiToken);
  if (bearer) return { baseUrl, bearer };
  const username = pick(NAMES.username);
  const password = pick(NAMES.password);
  if (username && password) return { baseUrl, username, password };
  throw new AuthError("User API（users --pull）は FORMULA_USER_API_TOKEN（cybozu.com 共通管理の API トークン）か、KINTONE_USERNAME と KINTONE_PASSWORD（2 要素認証のないアカウント）で呼ぶ。kintone アプリの API トークン（KINTONE_API_TOKEN）では呼べない");
}

/**
 * 計算式プラグインの zip の場所（OS の環境変数か .env の FORMULA_PLUGIN_ZIP。無ければ undefined = 開発中の formula を探す）。
 * .env に書いた相対パスは .env のフォルダーから解決する（今までどおり）。OS の環境変数（print-craft MCP では設定項目）の値は
 * 絶対パスだけを受け付ける（相対パスの起点が起動の場所に左右されるため。Desktop の起動の場所は / や C:\Windows\System32。段階 0-2 の段 2）
 */
export function pluginZipPath(opt: LoadAuthOptions): string | undefined {
  const picked = pickerWithSource(opt, true)(NAMES.pluginZip);
  if (!picked) return undefined;
  if (picked.source === "file") return path.resolve(path.dirname(picked.file ?? envFileOf(opt)), picked.value);
  if (!path.isAbsolute(picked.value)) throw new AuthError(`FORMULA_PLUGIN_ZIP（OS の環境変数）は絶対パスで書く: ${picked.value}（.env に書くなら .env のフォルダーからの相対パスでもよい）`);
  return path.normalize(picked.value);
}

/**
 * kintone の接続のファイルの場所（FORMULA_KINTONE_CONFIG。print-craft MCP の実装案 15.9）。OS の環境変数が先で、OS の値は絶対パスだけ。
 * 無ければ作業フォルダーの .env の値（.env のフォルダーからの相対か絶対）。設定されていなければ undefined、設定されていて空なら ""
 * （空・読めないのは誤りにする。1 接続の形に戻らない）。存在するかは確かめない（connections.ts が読む）
 */
export function kintoneConfigPath(opt: LoadAuthOptions): string | undefined {
  const name = NAMES.kintoneConfig[0];
  const osRaw = opt.env[name];
  if (osRaw !== undefined) {
    const v = unquote(osRaw);
    if (!v) return "";
    if (!path.isAbsolute(v)) throw new AuthError(`${name}（OS の環境変数）は絶対パスで書く（.env に書くなら .env のフォルダーからの相対パスでもよい）`);
    return path.normalize(v);
  }
  const file = envFileOf(opt);
  if (!existsSync(file)) return undefined;
  const vars = parseDotEnv(readFileSync(file, "utf8"));
  if (!Object.prototype.hasOwnProperty.call(vars, name)) return undefined;
  const v = vars[name].trim();
  return v ? path.resolve(path.dirname(file), v) : "";
}

/** 認証の種類だけを文言にする（値もユーザー名も出さない） */
export function describeAuth(auth: KintoneAuth): string {
  return auth.token ? "API トークン" : auth.bearer ? "cybozu.com 共通の API トークン" : "ログインユーザー";
}
