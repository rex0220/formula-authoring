/**
 * 元の値を、kintone の項目定義で検査する（プラグインの authoring API の requirements と check を呼ぶ）。
 *
 * 項目定義が要るアプリは、保存値だけでは決まらない（自アプリのルックアップ・関連レコード一覧から参照先を引き直すプラグインがある）ので、2 段で決める:
 *   1. 自アプリの項目定義を読む（設定画面と同じく**動作テスト環境**。preview）
 *   2. requirements を呼ぶ → 名前の要るアプリがあれば app API で名前を取って、もう一度呼ぶ → 項目定義の要るアプリが決まる
 *   3. そのアプリの項目定義を読む（**運用環境**。設定画面と同じ）
 *   4. check を呼ぶ
 * kintone へ送るのは GET だけ（kintone-rest.ts の許可表。アプリの一覧の API は使わない）。
 * **接続はアプリごとに作る**（API トークンはアプリごとに違う。`clientFor(アプリ番号)`）。そのアプリの接続を作れなければ（トークンが無い）、読めないアプリと同じ扱い。
 * 読めなかったアプリ（権限が無い、消えた）は飛ばして注記に残す。そのアプリを使う行は、API が「対象アプリが決まらない / 項目定義が無い」で止める。
 */
import { fetchFields } from "../commands/fields.ts";
import type { RestClient } from "../kintone-rest.ts";
import { digestOfJson, type GenericSource } from "./source.ts";
import type { GenericMethod } from "./host.ts";

type Json = Record<string, unknown>;

export interface GenericIssue { severity: "error" | "warning"; code: string; rowKey: string; section: string; label: string; message: string }
export interface GenericAppDefs { properties: Json; layout: unknown[]; views?: Json }
export interface GenericDefs { own: GenericAppDefs; appNames: Record<string, string>; apps: Record<string, GenericAppDefs> }

/** そのアプリを読む接続を返す（接続のファイルの profile の、そのアプリの認証で作る。作れなければ投げる） */
export type GenericClientFor = (appId: number) => RestClient;

/** プラグインの API を呼ぶ関数（run.ts の callGeneric を、プラグインと zip を決めた形で渡す） */
export type GenericCaller = (method: GenericMethod, args: unknown[]) => Promise<unknown>;

export interface FetchDefsOptions {
  /** 自アプリの番号 */
  app: number;
  guestSpaceId?: number;
  lang?: string;
}

/** 1 回の検査で読むアプリの上限（自アプリを除く）。超えたら止める */
export const GENERIC_MAX_APPS = 30;

export class GenericDefsError extends Error {}

/** アプリ番号として kintone に渡してよい文字列か（正の整数。プラグインの API が返した値も、設定に書かれた値も、ここを通す） */
export const isAppIdText = (id: unknown): id is string => typeof id === "string" && /^[1-9]\d{0,9}$/.test(id) && Number.isSafeInteger(Number(id));

export async function fetchGenericDefs(clientFor: GenericClientFor, call: GenericCaller, source: GenericSource, opt: FetchDefsOptions): Promise<{ defs: GenericDefs; notes: string[] }> {
  const notes: string[] = [];
  const own = await fetchFields(clientFor(opt.app), { app: opt.app, preview: true, lang: opt.lang, guestSpaceId: opt.guestSpaceId });
  const defs: GenericDefs = { own: { properties: own.properties as Json, layout: own.layout as unknown[], ...(own.views ? { views: own.views as unknown as Json } : {}) }, appNames: {}, apps: {} };
  const failed = new Set<string>();
  let targets: string[] = [];
  // 名前が出そろうまで（参照先を引くと新しいアプリが出ることは無いので、ふつう 2 回で終わる）
  for (let round = 0; round < 4; round++) {
    const rq = (await call("requirements", [source, defs, { ownAppId: String(opt.app), lang: opt.lang }])) as { needNames: string[]; targetAppIds: string[] };
    const need = rq.needNames.filter((id) => !failed.has(id));
    if (need.length === 0) {
      // 名前を取れなかったアプリが残っていても、ここで打ち切る（そのアプリは名前なしで check に進む）
      if (rq.needNames.length > 0) {
        for (const id of rq.needNames) defs.appNames[id] ??= "";
        continue;
      }
      targets = rq.targetAppIds;
      break;
    }
    if (Object.keys(defs.appNames).length + need.length > GENERIC_MAX_APPS) throw new GenericDefsError(`参照するアプリが多すぎる（${GENERIC_MAX_APPS} を超える）`);
    for (const id of need) {
      if (!isAppIdText(id)) { failed.add(String(id)); notes.push(`アプリ番号として読めない: ${String(id).slice(0, 40)}`); continue; }
      try {
        const a = await clientFor(Number(id)).get<{ name?: string }>("app", { id }, opt.guestSpaceId);
        defs.appNames[id] = String(a.name ?? "");
      } catch (e) {
        failed.add(id);
        notes.push(`アプリ ${id} の名前を読めない（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
  }
  // 名前を取れなかったアプリは appNames から外す（空の名前のまま渡さない。API は「対象アプリが決まらない」で止める）
  for (const id of failed) delete defs.appNames[id];
  // 項目定義を読むアプリ。**プラグインの API が返した値をそのまま kintone に渡さない**（設定に書かれた値がそのまま出てくることがある）:
  // アプリ番号として読めないものは飛ばして注記に残す（そのアプリを使う行は、API が「対象アプリが決まらない」で止める）
  const valid: string[] = [];
  for (const id of new Set(targets)) {
    if (isAppIdText(id)) valid.push(id);
    else notes.push(`アプリ番号として読めない: ${String(id).slice(0, 40)}`);
  }
  if (valid.length > GENERIC_MAX_APPS) throw new GenericDefsError(`参照するアプリが多すぎる（${GENERIC_MAX_APPS} を超える）`);
  for (const id of valid) {
    try {
      // 自アプリを対象にする設定は、自アプリと同じく動作テスト環境を読む（設定画面と同じ。運用環境と項目がずれていることがある）
      const f = await fetchFields(clientFor(Number(id)), { app: Number(id), preview: Number(id) === opt.app, lang: opt.lang, guestSpaceId: opt.guestSpaceId });
      defs.apps[id] = { properties: f.properties as Json, layout: f.layout as unknown[] };
    } catch (e) {
      notes.push(`アプリ ${id} の項目定義を読めない（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return { defs, notes };
}

export interface GenericCheckResult {
  issues: GenericIssue[];
  /** 保存値（封筒の本体）。error があれば null */
  body: Json | null;
  /** 保存値の印（body があるとき）。保存の前に「最後に検査を通ったものと同じか」を確かめる */
  digest: string | null;
  /** 式の検査のしかた（"dummy-record" = 架空のレコードで評価した。実データでの値・分岐は確かめていない） */
  evaluation: string;
  /** 項目定義を読んだアプリ（自アプリを除く） */
  apps: string[];
  /** 読めなかったアプリなどの注記 */
  notes: string[];
}

/** 項目定義を渡して検査する（kintone を読まない。試験と、項目定義を手元に持っているとき） */
export async function checkWithDefs(call: GenericCaller, source: GenericSource, defs: GenericDefs, context: Json = {}): Promise<GenericCheckResult> {
  const r = (await call("check", [source, defs, context])) as { issues: GenericIssue[]; body: Json | null; evaluation: string };
  return { issues: r.issues, body: r.body, digest: r.body ? digestOfJson(r.body) : null, evaluation: r.evaluation, apps: Object.keys(defs.apps), notes: [] };
}

/** kintone から項目定義を読んで検査する */
export async function checkSource(clientFor: GenericClientFor, call: GenericCaller, source: GenericSource, opt: FetchDefsOptions): Promise<GenericCheckResult> {
  const { defs, notes } = await fetchGenericDefs(clientFor, call, source, opt);
  const r = await checkWithDefs(call, source, defs, { ownAppId: String(opt.app), lang: opt.lang });
  return { ...r, notes };
}
