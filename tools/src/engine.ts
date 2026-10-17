/**
 * 計算式プラグインの zip から計算式エンジンと authoring API を読み、Node で動かす（v101 固定のアダプター。Ver.102 の registry は別のアダプターで足す）。
 * print-craft-authoring の engine.ts が元（読む順、1 プロセス 1 回、zip-changed / restart-required の扱いは同じ）。計算式用に変えたもの:
 *   - 読む順: moment（vendor/）→ moment-timezone → bignumber → rex0220_decimal → KintoneFormula → authoring API（zip の manifest と同じ）
 *   - グローバル: window は globalThis（bignumber などの UMD は globalThis に置く）。happy-dom は document と DOM の型だけ借りる
 *   - ダミー層（context。オーサリングツール_実装計画.md 5 章）: ログインユーザー / アプリ番号 / mobile / ルックアップ先 / URL / ユーザー情報 を 1 か所で持つ。
 *     コンストラクターは式に関係なく getLoginUser と app.getId を読むので、値が無いときは番兵（code "__sentinel__"）を返す。式がその文脈を使うかは
 *     走査（scan.ts）で見つけて名指しで止める。実行時の sink（clipboard、kintone.api）は呼ばれたことを記録して拒否する（走査の漏れの保険）
 *   - runner は evType（EV_INFO）と event（プロセス管理の action / status / nextStatus。エンジンの 7 つ目の引数）を取る
 *   - dq の呼び出し回数を数える（走査の前に dq が呼ばれないことのテスト）
 * zip のコードはこのプロセス（Node を起動した OS ユーザーと同じ権限）で動く。sandbox ではない。読み込んでよいかは PUBKEY から出るプラグイン ID で決める（meta.ts）。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { formulaAuthoring } from "formula/src/authoring/api.ts";
import { FORMULA_CONFIG_PLUGIN_ID, FORMULA_PLUGIN_ID, MIN_PLUGIN_VERSION, SUPPORTED_API_VERSIONS, isSupportedPluginVersion, requiredApiFor, toolsMeta } from "./meta.ts";
import { MOMENT_FILE } from "./paths.ts";
import {
  API_ENTRY, BIGNUMBER_ENTRY, DECIMAL_ENTRY, ENGINE_ENTRY, MANIFEST_ENTRY, MOMENT_TZ_ENTRY, PluginZipError, type PluginSources, type PluginZipErrorInfo, readPluginZip, sha256Hex
} from "./plugin-zip.ts";
import { defaultUsersInfo, type UsersInfoTable, type UsersOrigin } from "./users/index.ts";

export type FormulaAuthoringApi = typeof formulaAuthoring;

/** 計算式エンジンのインスタンス（formula の libs.ts の KintoneFormula と同じ形） */
export interface FormulaInstance {
  funs: Record<string, unknown>;
  usedFields(init?: Record<string, unknown>): Record<string, unknown>;
  dq(expression: string): unknown;
  initTableInfo(code: string): boolean;
  currRow(index?: number): boolean | number;
}

export type FormulaCtor = new (name: string, pp: unknown, record: unknown, enabled: boolean, fieldCheck: boolean, evInfo?: unknown, event?: unknown) => FormulaInstance;

export interface LoginUser {
  id: string;
  code: string;
  name: string;
  email: string;
  timezone: string;
  language: string;
  isGuest?: boolean;
}

/** プロセス管理のイベント（エンジンの 7 つ目の引数。EV_INFO("action") / ("status") / ("nextStatus")） */
export interface CalcEvent {
  action: { value: string };
  status: { value: string };
  nextStatus: { value: string };
}

/** ダミー層の文脈（オーサリングツール_実装計画.md 5 章） */
export interface EngineContext {
  baseUrl: string;
  appId: number;
  mobile: boolean;
  /** 指定が無ければ番兵（式がログインユーザーを使うかは走査で見る） */
  loginUser: LoginUser | null;
  /** fieldcode → ルックアップ先のアプリ番号（fields から組む） */
  lookupTargets: Record<string, number>;
  /** fieldcode → 関連レコードの先のアプリ番号 */
  relatedTargets: Record<string, number>;
  /** UINFO 系が読む表。null = 各種設定「ユーザー情報」OFF と同じ（UINFO はエラー） */
  usersInfo: UsersInfoTable | null;
  usersOrigin: UsersOrigin | { kind: "none" };
}

export interface SinkCall {
  sink: "clipboard.writeText" | "clipboard.readText" | "kintone.api" | "kintone.events";
  detail: string;
}

export interface EngineSource {
  kind: "zip" | "dev";
  from: string;
  pluginVersion: string;
  engineSha256: string;
  apiSha256?: string;
  decimalSha256?: string;
  pluginId?: string;
}

export interface Engine {
  window: Record<string, unknown>;
  Ctor: FormulaCtor;
  api: FormulaAuthoringApi;
  source: EngineSource;
  warnings: string[];
  /** 文脈を変える。変えたら必ず新しい checker / runner を作る（コンストラクターで値が固定される） */
  setContext(next: Partial<EngineContext>): void;
  context(): Readonly<EngineContext>;
  /** 設定画面と同じ検証用のインスタンス（createChecker: enabled = true、fieldCheck = true） */
  checker(pp: unknown, crec: unknown): FormulaInstance;
  /** 計算用（createRunner: fieldCheck = false、evType、event） */
  runner(pp: unknown, record: unknown, evType: string, event?: CalcEvent): FormulaInstance;
  functionNames(): string[];
  /** 関数名 → 説明文の type（USER / EVENT / BUTTON / TABLE / AGGREGATE …。エンジンの desc。関数一覧の生成と normalize の分類に） */
  functionTypes(): Record<string, string[]>;
  /** 関数名 → 説明文（設定画面の ? と計算式ツールの文言。type と ja / en / zh。関数一覧の生成に） */
  functionDocs(): Record<string, { type: string[]; ja: string; en: string; zh: string }>;
  /** dq が呼ばれた回数（走査の前に評価していないことの確認） */
  dqCount(): number;
  /** true の間は dq を呼ぶと例外（normalize の走査の間。評価していないことを保証する） */
  blockDq(on: boolean): void;
  /** 実行時の sink（clipboard、kintone.api）が呼ばれた記録。評価の前に空にして、後で見る */
  sinkCalls(): SinkCall[];
  clearSinkCalls(): void;
}

export interface LoadEngineOptions {
  /** 計算式プラグインの zip。中核は環境変数を読まない（CLI は env.ts の pluginZipPath で決めて渡す） */
  pluginZip?: string;
  /** 開発中（mode dev）の読み込み元（隣の formula の prod/）。CLI は FORMULA_ALLOW_DEV_PLUGIN=1 のときだけ dev-paths.ts の formulaProdDir で決めて渡す */
  devPluginDir?: string;
  mode?: "build" | "dev";
}

export const DEFAULT_CONTEXT_BASE_URL = "https://example.cybozu.com";
/** 指定が無いときにコンストラクターへ返す番兵（式が使えば走査で止める。calc の表には「ログインユーザー: 指定なし」） */
export const SENTINEL_USER: LoginUser = { id: "0", code: "__sentinel__", name: "", email: "", timezone: "Asia/Tokyo", language: "ja", isGuest: false };

let loaded: Engine | null = null;
let loadedStamp: SourceStamp | null = null;
let loading: Promise<Engine> | null = null;
let poisoned: { code: string; info: PluginZipErrorInfo } | null = null;

interface SourceStamp {
  kind: "zip" | "dev";
  real: string;
  size?: number;
  mtimeMs?: number;
}

function requestedStamp(opt: LoadEngineOptions): SourceStamp | null | undefined {
  try {
    if (opt.pluginZip) {
      const real = realpathSync(opt.pluginZip);
      const st = statSync(real);
      return { kind: "zip", real, size: st.size, mtimeMs: st.mtimeMs };
    }
    if (opt.devPluginDir) return { kind: "dev", real: realpathSync(opt.devPluginDir) };
    return undefined;
  } catch {
    return null;
  }
}

const sameStamp = (a: SourceStamp | null | undefined, b: SourceStamp | null): boolean =>
  !!a && !!b && a.kind === b.kind && a.real === b.real && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** 読み込み元を決める: zip（引数）。開発中（mode dev + devPluginDir）だけ隣の formula の prod/ */
export function resolvePluginSources(opt: LoadEngineOptions = {}, mode: "build" | "dev" = opt.mode ?? toolsMeta().mode): PluginSources & { kind: "zip" | "dev" } {
  const zip = opt.pluginZip;
  if (zip) {
    if (!existsSync(zip)) throw new PluginZipError(`計算式プラグインの zip が無い: ${zip}（.env の FORMULA_PLUGIN_ZIP）`, "missing");
    return { ...readPluginZip(zip), kind: "zip" };
  }
  const dev = opt.devPluginDir;
  const devAllowed = mode === "dev" && !!dev;
  if (!devAllowed) {
    throw new PluginZipError(`計算式プラグインの zip の場所が分からない。.env に FORMULA_PLUGIN_ZIP=<計算式プラグインの zip のパス> を書く${mode === "dev" ? "（開発中に隣の formula の prod/ を読むなら環境変数 FORMULA_ALLOW_DEV_PLUGIN=1）" : ""}`, "not-configured");
  }
  if (!dev || !existsSync(path.join(dev, ENGINE_ENTRY))) throw new PluginZipError(`計算式プラグインの zip の場所が分からない（FORMULA_ALLOW_DEV_PLUGIN=1 だが formula の prod/ が無い: ${dev}）`, "not-configured");
  const read = (rel: string): string => readFileSync(path.join(dev, rel), "utf8");
  const apiFile = path.join(dev, API_ENTRY);
  const decimalFile = path.join(dev, DECIMAL_ENTRY);
  const engine = read(ENGINE_ENTRY);
  const bignumber = read(BIGNUMBER_ENTRY);
  const momentTimezone = read(MOMENT_TZ_ENTRY);
  const decimal = existsSync(decimalFile) ? readFileSync(decimalFile, "utf8") : undefined;
  const api = existsSync(apiFile) ? readFileSync(apiFile, "utf8") : undefined;
  const manifest = JSON.parse(read(MANIFEST_ENTRY)) as PluginSources["manifest"];
  return {
    kind: "dev", from: dev, manifest, pluginVersion: String(manifest.version ?? ""), engine, bignumber, decimal, momentTimezone, api,
    sha256: { engine: sha256Hex(engine), ...(api ? { api: sha256Hex(api) } : {}), bignumber: sha256Hex(bignumber), ...(decimal ? { decimal: sha256Hex(decimal) } : {}), momentTimezone: sha256Hex(momentTimezone) }
  };
}

export async function loadEngine(opt: LoadEngineOptions = {}): Promise<Engine> {
  while (loading) await loading.catch(() => undefined);
  if (loaded) return sameEngine(loaded, opt);
  if (poisoned) {
    throw new PluginZipError(
      `計算式プラグインの zip の読み込みに一度失敗した（${poisoned.code}）。そのコードとグローバルがこのプロセスに残っているので、読み込み直せない（起動し直す）`,
      "restart-required",
      { ...poisoned.info, previous: poisoned.code }
    );
  }
  const run = loadOnce(opt);
  loading = run;
  try {
    return await run;
  } finally {
    if (loading === run) loading = null;
  }
}

function sameEngine(engine: Engine, opt: LoadEngineOptions): Engine {
  const want = requestedStamp(opt);
  if (want === undefined) return engine;
  if (!sameStamp(want, loadedStamp)) {
    throw new PluginZipError(
      `計算式プラグインの zip（読み込み元）が、読み込んだもの（${path.basename(loadedStamp?.real ?? engine.source.from)}）と違う、または読み込んだ後に変わった: ${opt.pluginZip ?? opt.devPluginDir}。1 つのプロセスで読める zip は 1 つ`,
      "zip-changed",
      { pluginVersion: engine.source.pluginVersion }
    );
  }
  return engine;
}

async function loadOnce(opt: LoadEngineOptions): Promise<Engine> {
  const meta = toolsMeta();
  const stamp = requestedStamp(opt) ?? null;
  const src = resolvePluginSources(opt, opt.mode ?? meta.mode);
  const known = { pluginVersion: src.pluginVersion };
  const warnings: string[] = [];
  if (src.kind === "zip" && src.pluginId !== FORMULA_PLUGIN_ID) {
    throw new PluginZipError(`計算式プラグインの zip ではない（プラグイン ID ${src.pluginId ?? "不明（PUBKEY が無い）"}。計算式プラグインは ${FORMULA_PLUGIN_ID}）: ${src.from}。配布元から入手した計算式プラグインの zip を FORMULA_PLUGIN_ZIP に`, "not-formula", known);
  }
  if (src.kind === "dev") warnings.push(`開発中の formula（${src.from}。FORMULA_ALLOW_DEV_PLUGIN=1）から読む。プラグイン ID は確かめない`);
  if (!isSupportedPluginVersion(src.pluginVersion)) {
    throw new PluginZipError(`計算式プラグインの版 ${src.pluginVersion || "不明"}（${src.from}）には対応していない。tools が扱うのは Ver.${MIN_PLUGIN_VERSION} 以降`, "unsupported-version", known);
  }
  if (!src.api) throw new PluginZipError(`計算式プラグインの zip に ${API_ENTRY} が無い（Ver.${MIN_PLUGIN_VERSION} 以降の zip が要る）: ${src.from}`, "no-api", known);
  if (!src.decimal) warnings.push(`zip に ${DECIMAL_ENTRY} が無い（べき乗の小数の指数がエラーになる）`);
  if (!existsSync(MOMENT_FILE)) throw new Error(`moment が無い: ${MOMENT_FILE}（tools の npm install 時に取る。手で取るなら npm run vendor）`);
  try {
    return await startEngine({ ...src, api: src.api }, known, warnings, stamp);
  } catch (e) {
    poisoned = { code: e instanceof PluginZipError ? e.code : "unexpected", info: e instanceof PluginZipError ? e.info : known };
    throw e;
  }
}

async function startEngine(src: PluginSources & { kind: "zip" | "dev"; api: string }, known: PluginZipErrorInfo, warnings: string[], stamp: SourceStamp | null): Promise<Engine> {
  const g = globalThis as Record<string, unknown>;
  const { Window } = (await import("happy-dom")) as unknown as { Window: new (opt: { url: string }) => Record<string, unknown> };
  const ctx: EngineContext = {
    baseUrl: DEFAULT_CONTEXT_BASE_URL, appId: 1, mobile: false, loginUser: null, lookupTargets: {}, relatedTargets: {},
    usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" }
  };
  const dom = new Window({ url: `${ctx.baseUrl}/k/${ctx.appId}/show` });
  // document と DOM の型だけ happy-dom から借りる。window は globalThis（bignumber などの UMD と、エンジンの window.rex0220p が同じものを指すように）
  for (const k of ["document", "Node", "Element", "HTMLElement", "HTMLDivElement", "DOMParser", "Event", "getComputedStyle"]) {
    const v = dom[k];
    if (v !== undefined && g[k] === undefined) g[k] = k === "getComputedStyle" && typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(dom) : v;
  }
  g.window = g;
  g.self = g;

  const sinks: SinkCall[] = [];
  const kintone = {
    getLoginUser: () => ({ ...(ctx.loginUser ?? SENTINEL_USER) }),
    app: {
      getId: () => ctx.appId,
      getLookupTargetAppId: (fc: string) => ctx.lookupTargets[fc] ?? null,
      getRelatedRecordsTargetAppId: (fc: string) => ctx.relatedTargets[fc] ?? null
    },
    mobile: { app: { getId: () => ctx.appId, getLookupTargetAppId: (fc: string) => ctx.lookupTargets[fc] ?? null, getRelatedRecordsTargetAppId: (fc: string) => ctx.relatedTargets[fc] ?? null } },
    api: Object.assign((pathOrUrl: unknown) => {
      sinks.push({ sink: "kintone.api", detail: String(pathOrUrl) });
      return Promise.reject(new Error("kintone.api is not available in authoring tools"));
    }, {
      url: (p: string, _guest?: boolean) => `${ctx.baseUrl}${p.startsWith("/") ? "" : "/"}${p}`,
      urlForGet: (p: string, _params?: unknown, _guest?: boolean) => `${ctx.baseUrl}${p.startsWith("/") ? "" : "/"}${p}`
    }),
    events: { off: (ev: unknown) => { sinks.push({ sink: "kintone.events", detail: `off ${JSON.stringify(ev).slice(0, 80)}` }); return true; }, on: () => true },
    getRequestToken: () => "authoring",
    $PLUGIN_ID: "authoring"
  };
  g.kintone = kintone;
  g.cybozu = { data: { get IS_MOBILE_DEVICE() { return ctx.mobile; }, page: { APP_DATA: { id: String(ctx.appId), name: "" }, FORM_DATA: { schema: { table: { fieldList: {}, subTable: {} }, subTable: {} } } } } };
  const usersLib = { request: () => undefined, getUsersInfo: async () => ctx.usersInfo, get data() { return ctx.usersInfo; } };
  g.rex0220_users_info3 = usersLib;
  // Node 21+ の globalThis.navigator は getter。clipboard は呼ばれたことを記録して拒否する（CLIPBORD 系は例外を握るので、throw だけでは分からない）
  Object.defineProperty(g, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: (t: unknown) => { sinks.push({ sink: "clipboard.writeText", detail: String(t).slice(0, 80) }); throw new Error("clipboard is not available in authoring tools"); },
        readText: () => { sinks.push({ sink: "clipboard.readText", detail: "" }); throw new Error("clipboard is not available in authoring tools"); }
      },
      userAgent: "formula-authoring-tools", language: "ja"
    }
  });

  const runScript = (code: string, filename: string, entry?: string): void => {
    try {
      vm.runInThisContext(code, { filename });
    } catch (e) {
      if (!entry) throw e;
      throw new PluginZipError(`計算式プラグインの zip のコード（${entry}）を実行できない: ${e instanceof Error ? e.message : String(e)}`, "engine-unreadable", known);
    }
  };
  runScript(readFileSync(MOMENT_FILE, "utf8"), MOMENT_FILE);
  runScript(src.momentTimezone, `${src.from}!${MOMENT_TZ_ENTRY}`, MOMENT_TZ_ENTRY);
  runScript(src.bignumber, `${src.from}!${BIGNUMBER_ENTRY}`, BIGNUMBER_ENTRY);
  if (src.decimal) runScript(src.decimal, `${src.from}!${DECIMAL_ENTRY}`, DECIMAL_ENTRY);
  runScript(src.engine, `${src.from}!${ENGINE_ENTRY}`, ENGINE_ENTRY);
  runScript(src.api, `${src.from}!${API_ENTRY}`, API_ENTRY);
  const rex0220p = g.rex0220p as { KintoneFormula?: FormulaCtor } | undefined;
  const Ctor = rex0220p?.KintoneFormula;
  if (typeof Ctor !== "function") throw new PluginZipError(`計算式エンジン（rex0220p.KintoneFormula）が読めない: ${src.from}`, "engine-unreadable", known);
  const api = g.rex0220FormulaAuthoring as FormulaAuthoringApi | undefined;
  if (!api || typeof api !== "object") throw new PluginZipError("計算式プラグインの authoring API（rex0220FormulaAuthoring）が読めない", "api-unreadable", known);
  const withApi = { ...known, apiVersion: api.apiVersion as unknown };
  if (!SUPPORTED_API_VERSIONS.includes(api.apiVersion)) throw new PluginZipError(`計算式プラグインの authoring API の版 ${String(api.apiVersion)} には対応していない（tools は ${SUPPORTED_API_VERSIONS.join(", ")}）`, "api-unsupported", withApi);
  if (String(api.pluginVersion) !== src.pluginVersion) throw new PluginZipError(`authoring API のプラグインの版 ${String(api.pluginVersion)} が zip の manifest の版 ${src.pluginVersion} と違う（組み替えられた zip）`, "api-mismatch", withApi);
  const bad = Object.entries(requiredApiFor(api.apiVersion)).filter(([k, t]) => typeof (api as unknown as Record<string, unknown>)[k] !== t).map(([k]) => k);
  if (bad.length) throw new PluginZipError(`計算式プラグインの authoring API に tools が使うものが無い、または型が違う: ${bad.join(", ")}（tools とプラグインの版を合わせる）`, "api-incomplete", withApi);
  if (api.pluginId !== FORMULA_CONFIG_PLUGIN_ID) throw new PluginZipError(`authoring API の pluginId が計算式プラグインのものでない: ${String(api.pluginId)}（${FORMULA_CONFIG_PLUGIN_ID} が要る）`, "api-incomplete", withApi);

  // dq の呼び出し回数（走査の前に評価していないことの確認）。prototype のメソッドを 1 回だけ包む
  let dqCalls = 0;
  let dqBlocked = false;
  const proto = Ctor.prototype as { dq: (expr: string) => unknown };
  const origDq = proto.dq;
  proto.dq = function (this: FormulaInstance, expr: string) {
    if (dqBlocked) throw new Error("tools: 走査の間に計算式を評価しようとした（dq が遮断されている）");
    dqCalls++;
    return origDq.call(this, expr);
  };

  loaded = {
    window: g,
    Ctor,
    api,
    source: { kind: src.kind, from: src.from, pluginVersion: src.pluginVersion, engineSha256: src.sha256.engine, apiSha256: src.sha256.api, decimalSha256: src.sha256.decimal, ...(src.pluginId ? { pluginId: src.pluginId } : {}) },
    warnings,
    setContext(next) {
      if (next.baseUrl !== undefined) ctx.baseUrl = next.baseUrl.replace(/\/+$/, "");
      if (next.appId !== undefined) ctx.appId = next.appId;
      if (next.mobile !== undefined) ctx.mobile = next.mobile;
      if (next.loginUser !== undefined) ctx.loginUser = next.loginUser ? { ...next.loginUser } : null;
      if (next.lookupTargets !== undefined) ctx.lookupTargets = { ...next.lookupTargets };
      if (next.relatedTargets !== undefined) ctx.relatedTargets = { ...next.relatedTargets };
      if (next.usersInfo !== undefined) ctx.usersInfo = next.usersInfo;
      if (next.usersOrigin !== undefined) ctx.usersOrigin = next.usersOrigin;
    },
    context: () => ({ ...ctx, lookupTargets: { ...ctx.lookupTargets }, relatedTargets: { ...ctx.relatedTargets } }),
    checker: (pp, crec) => new Ctor("formula", pp, crec, true, true),
    runner: (pp, record, evType, event) => new Ctor("formula", pp, record, true, false, evType, event),
    functionNames: () => Object.keys(new Ctor("formula", {}, {}, true, true).funs).sort(),
    functionDocs: () => {
      const desc = (new Ctor("formula", {}, {}, true, true) as unknown as { desc?: Record<string, { type?: string[]; ja?: string; en?: string; zh?: string }> }).desc ?? {};
      const out: Record<string, { type: string[]; ja: string; en: string; zh: string }> = {};
      for (const [name, d] of Object.entries(desc)) out[name] = { type: Array.isArray(d?.type) ? [...d.type] : [], ja: String(d?.ja ?? ""), en: String(d?.en ?? ""), zh: String(d?.zh ?? "") };
      return out;
    },
    functionTypes: () => {
      const desc = (new Ctor("formula", {}, {}, true, true) as unknown as { desc?: Record<string, { type?: string[] }> }).desc ?? {};
      const out: Record<string, string[]> = {};
      for (const [name, d] of Object.entries(desc)) out[name] = Array.isArray(d?.type) ? [...d.type] : [];
      return out;
    },
    dqCount: () => dqCalls,
    blockDq: (on) => { dqBlocked = on; },
    sinkCalls: () => [...sinks],
    clearSinkCalls: () => { sinks.length = 0; }
  };
  loadedStamp = stamp;
  return loaded;
}
