/**
 * 汎用のオーサリングの「仕事」1 つを動かす。プラグインの zip を読み（zip.ts。プラグイン ID と署名を確かめる）、計算式エンジンと authoring API を
 * このスレッドのグローバルに読み込んで、API の口を 1 つ呼ぶ。
 *
 * **1 つの仕事 = 1 つのワーカー**（run.ts）。呼ぶたびに新しいワーカーで zip を読み直すので、
 *   - プラグインごとにグローバルが分かれる（1 つのプロセスで複数のプラグインを扱える。計算式の engine.ts は 1 プロセスに zip 1 つ）
 *   - zip を差し替えたら、次の呼び出しから新しい zip になる（世代の管理が要らない）
 *   - 同時の呼び出しは別のワーカー。落ちても、落ちた呼び出しだけが失敗する
 * 代わりに、呼ぶたびに zip の展開と読み込みの時間がかかる（アプリ集計で 0.2 秒ほど）。
 *
 * 環境（document・kintone の代役・ユーザー情報）は engine.ts の startEngine と同じ考え方。kintone.api と clipboard は拒否する。
 * zip のコードはこのスレッドでも、Node を起動した OS ユーザーの権限で動く（sandbox ではない）。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { MOMENT_FILE } from "../paths.ts";
import { defaultUsersInfo } from "../users/index.ts";
import { AUTHORING_GLOBAL, genericPlugin } from "./registry.ts";
import { GenericZipError, readGenericZip, type GenericZipSources } from "./zip.ts";

/** ツールが呼べる口（authoring API の契約の口と、zip と API の状態を返す describe） */
export const GENERIC_METHODS = ["describe", "toSource", "newSource", "newRow", "requirements", "check", "readEnvelope", "writeEnvelope"] as const;
export type GenericMethod = (typeof GENERIC_METHODS)[number];

export interface GenericJob {
  /** 表の名前（registry.ts） */
  plugin: string;
  /** プラグインの zip（絶対パス）。中核は環境変数を読まない（呼ぶ側が決めて渡す） */
  zip?: string;
  method: GenericMethod;
  args: unknown[];
  /** 式の評価の文脈（自アプリの番号など）。無ければ既定 */
  context?: { ownAppId?: number; baseUrl?: string };
  /** moment（vendor/）のファイル。省略すれば tools の vendor/ */
  momentFile?: string;
}

export interface GenericDescribe {
  plugin: string;
  title: string;
  pluginVersion: string;
  contractVersion: number;
  hasSimulate: boolean;
  zip: { from: string; signed: true; size: number; mtimeMs: number; sha256: { contents: string; api: string } };
}

/** プラグインの authoring API が投げた誤り（契約の誤り、スキーマの誤りなど）。文は値を含みうる */
export class GenericPluginError extends Error {
  readonly innerName: string;
  constructor(message: string, innerName: string) {
    super(message);
    this.innerName = innerName;
  }
}

type Api = Record<string, unknown> & { contractVersion?: unknown; pluginId?: unknown; pluginVersion?: unknown; hasSimulate?: unknown };

function prepareGlobals(dom: Record<string, unknown>, ctx: { baseUrl: string; appId: number }): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of ["document", "Node", "Element", "HTMLElement", "HTMLDivElement", "DOMParser", "Event", "getComputedStyle"]) {
    const v = dom[k];
    if (v !== undefined && g[k] === undefined) g[k] = k === "getComputedStyle" && typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(dom) : v;
  }
  g.window = g;
  g.self = g;
  const users = defaultUsersInfo();
  const reject = (what: string) => (): never => { throw new Error(`${what} is not available in authoring tools`); };
  g.kintone = {
    getLoginUser: () => ({ id: "0", code: "__sentinel__", name: "", email: "", timezone: "Asia/Tokyo", language: "ja", isGuest: false }),
    app: { getId: () => ctx.appId, getLookupTargetAppId: () => null, getRelatedRecordsTargetAppId: () => null },
    mobile: { app: { getId: () => ctx.appId, getLookupTargetAppId: () => null, getRelatedRecordsTargetAppId: () => null } },
    api: Object.assign(() => Promise.reject(new Error("kintone.api is not available in authoring tools")), {
      url: (p: string) => `${ctx.baseUrl}${p.startsWith("/") ? "" : "/"}${p}`,
      urlForGet: (p: string) => `${ctx.baseUrl}${p.startsWith("/") ? "" : "/"}${p}`
    }),
    events: { off: () => true, on: () => true },
    getRequestToken: () => "authoring",
    $PLUGIN_ID: "authoring"
  };
  g.cybozu = { data: { IS_MOBILE_DEVICE: false, page: { APP_DATA: { id: String(ctx.appId), name: "" }, FORM_DATA: { schema: { table: { fieldList: {}, subTable: {} }, subTable: {} } } } } };
  g.rex0220_users_info3 = { request: () => undefined, getUsersInfo: async () => users, get data() { return users; } };
  Object.defineProperty(g, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: reject("clipboard"), readText: reject("clipboard") }, userAgent: "formula-authoring-tools", language: "ja" }
  });
}

function loadApi(src: GenericZipSources, job: GenericJob): Api {
  const plugin = genericPlugin(job.plugin);
  const run = (code: string, filename: string): void => {
    try {
      vm.runInThisContext(code, { filename });
    } catch (e) {
      throw new GenericZipError(`zip のコード（${filename}）を実行できない: ${e instanceof Error ? e.message : String(e)}`, "api-unreadable", src.pluginVersion);
    }
  };
  const momentFile = job.momentFile ?? MOMENT_FILE;
  run(readFileSync(momentFile, "utf8"), momentFile);
  for (const s of src.scripts) run(s.code, `${src.from}!${s.entry}`);
  run(src.api, `${src.from}!${plugin.apiEntry}`);
  const api = (globalThis as Record<string, unknown>)[AUTHORING_GLOBAL] as Api | undefined;
  if (!api || typeof api !== "object") throw new GenericZipError(`authoring API（${AUTHORING_GLOBAL}）が読めない`, "api-unreadable", src.pluginVersion);
  if (!plugin.contractVersions.includes(api.contractVersion as number)) {
    throw new GenericZipError(`authoring API の契約の版 ${String(api.contractVersion)} には対応していない（tools は ${plugin.contractVersions.join(", ")}。tools とプラグインの版を合わせる）`, "api-unsupported", src.pluginVersion);
  }
  if (String(api.pluginVersion) !== src.pluginVersion) throw new GenericZipError(`authoring API のプラグインの版 ${String(api.pluginVersion)} が zip の manifest の版 ${src.pluginVersion} と違う`, "api-mismatch", src.pluginVersion);
  if (api.pluginId !== plugin.configPluginId) throw new GenericZipError(`authoring API の pluginId が${plugin.title}プラグインのものでない: ${String(api.pluginId)}`, "api-mismatch", src.pluginVersion);
  return api;
}

export async function runGenericJob(job: GenericJob): Promise<unknown> {
  const plugin = genericPlugin(job.plugin);
  if (!GENERIC_METHODS.includes(job.method)) throw new Error(`呼べない口: ${String(job.method)}`);
  const src = readGenericZip(job.zip, plugin);
  const { Window } = (await import("happy-dom")) as unknown as { Window: new (opt: { url: string }) => Record<string, unknown> };
  const ctx = { baseUrl: job.context?.baseUrl ?? "https://example.cybozu.com", appId: job.context?.ownAppId ?? 1 };
  prepareGlobals(new Window({ url: `${ctx.baseUrl}/k/${ctx.appId}/show` }), ctx);
  const api = loadApi(src, job);
  if (job.method === "describe") {
    const d: GenericDescribe = {
      plugin: plugin.name, title: plugin.title, pluginVersion: src.pluginVersion, contractVersion: api.contractVersion as number, hasSimulate: api.hasSimulate === true,
      zip: { from: src.from, signed: true, size: src.stamp.size, mtimeMs: src.stamp.mtimeMs, sha256: src.sha256 }
    };
    return d;
  }
  const fn = api[job.method];
  if (typeof fn !== "function") throw new GenericZipError(`authoring API に ${job.method} が無い`, "api-unsupported", src.pluginVersion);
  let result: unknown;
  try {
    result = (fn as (...a: unknown[]) => unknown).apply(api, job.args);
  } catch (e) {
    throw new GenericPluginError(e instanceof Error ? e.message : String(e), e instanceof Error ? e.name : "Error");
  }
  // 結果は JSON だけ（契約）。ワーカーの外へはメッセージで渡すので、ここで JSON にして戻す
  return result === undefined ? null : JSON.parse(JSON.stringify(result));
}

export type GenericErrorKind = "zip" | "plugin" | "other";
export type GenericMessage = { ok: true; result: unknown } | { ok: false; error: { kind: GenericErrorKind; name: string; message: string; code?: string; pluginVersion?: string } };

/** 誤りの種類は、中核のクラスの instanceof で決める（zip のコードが name を偽装しても zip にならない） */
export function classifyGenericError(e: unknown): Extract<GenericMessage, { ok: false }>["error"] {
  if (e instanceof GenericZipError) return { kind: "zip", name: "GenericZipError", message: e.message, code: e.code, pluginVersion: e.pluginVersion };
  if (e instanceof GenericPluginError) return { kind: "plugin", name: e.innerName, message: e.message };
  return { kind: "other", name: e instanceof Error ? e.constructor.name : "Error", message: e instanceof Error ? e.message : String(e) };
}
