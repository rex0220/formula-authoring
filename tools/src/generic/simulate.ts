/**
 * 模擬: 元の値にレコードを当てて確かめる（プラグインの authoring API の simulate を呼ぶ。ある製品だけ = registry.ts の simulate）。
 *
 * レコードは 3 通りで渡せる: 書いたレコード（records。kintone を読まない）/ レコード番号（ids）/ 条件（query。件数はここで決める）。
 * kintone へ送るのは GET だけ（record / records。kintone-rest.ts の許可表）。**読んだレコードそのものは返さない**
 * （プラグインの API に渡し、返ってくるのは「どの条件が選ばれたか」と式の結果の例）。
 * 結果の形はプラグインごと（契約の版 1 では自由な JSON）。ここは、レコードと項目定義をそろえて渡すだけ。
 */
import { QueryError, queryWithLimit } from "../commands/records.ts";
import type { GenericSource } from "./source.ts";
import { fetchGenericDefs, type FetchDefsOptions, type GenericCaller, type GenericClientFor } from "./check.ts";

type Json = Record<string, unknown>;

/** 1 回の模擬で当てるレコードの数（書いたレコード・番号・条件のどれでも） */
export const GENERIC_SIM_MAX_RECORDS = 20;

export class GenericSimulateError extends Error {}
/** 条件に合うレコードが無かった（渡し方の誤りではない） */
export class GenericNoRecordsError extends GenericSimulateError {}
export { QueryError as GenericQueryError };

export interface SimRecordsInput {
  /** 書いたレコード（REST のレコードの形） */
  records?: readonly unknown[];
  /** レコード番号 */
  ids?: readonly number[];
  /** 条件と並べ替え（limit / offset は書かない） */
  query?: string;
}

export interface SimRecords {
  from: "records" | "ids" | "query";
  records: Json[];
  /** kintone に送った query（from が query のとき） */
  query?: string;
}

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** レコードの渡し方を確かめる（kintone を読む前に）。records / ids / query は 1 つだけ。query は limit を付けた形にして返す */
export function planSimRecords(input: SimRecordsInput): { from: "records"; records: Json[] } | { from: "ids"; ids: number[] } | { from: "query"; query: string } {
  const given = [input.records !== undefined, input.ids !== undefined, input.query !== undefined].filter(Boolean).length;
  if (given !== 1) throw new GenericSimulateError("records（書いたレコード）・ids（レコード番号）・query（条件）のどれか 1 つを渡す");
  if (input.records !== undefined) {
    const records = input.records;
    if (!Array.isArray(records) || records.length === 0 || records.length > GENERIC_SIM_MAX_RECORDS || records.some((r) => !isObject(r))) throw new GenericSimulateError(`records は 1〜${GENERIC_SIM_MAX_RECORDS} 件のレコード（オブジェクト）で書く`);
    return { from: "records", records: records as Json[] };
  }
  if (input.ids !== undefined) {
    const ids = [...new Set(input.ids)];
    if (ids.length === 0 || ids.length > GENERIC_SIM_MAX_RECORDS || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw new GenericSimulateError(`ids は 1〜${GENERIC_SIM_MAX_RECORDS} 件のレコード番号（正の整数）で書く`);
    return { from: "ids", ids };
  }
  return { from: "query", query: queryWithLimit(input.query, GENERIC_SIM_MAX_RECORDS) };
}

/** 模擬に当てるレコードをそろえる（ids と query は kintone から GET で読む） */
export async function fetchSimRecords(clientFor: GenericClientFor, opt: { app: number; guestSpaceId?: number }, input: SimRecordsInput): Promise<SimRecords> {
  const plan = planSimRecords(input);
  if (plan.from === "records") return plan;
  const client = clientFor(opt.app);
  if (plan.from === "ids") {
    const records: Json[] = [];
    for (const id of plan.ids) {
      const res = await client.get<{ record?: Json }>("record", { app: opt.app, id }, opt.guestSpaceId);
      records.push(res.record ?? {});
    }
    return { from: "ids", records };
  }
  const query = plan.query;
  const res = await client.get<{ records?: Json[] }>("records", { app: opt.app, query }, opt.guestSpaceId);
  const records = (res.records ?? []).slice(0, GENERIC_SIM_MAX_RECORDS);
  if (records.length === 0) throw new GenericNoRecordsError("条件に合うレコードが無い（query を見直すか、ids か records で渡す）");
  return { from: "query", records, query };
}

export interface GenericSimulateResult {
  /** プラグインの API が返した結果（形はプラグインごと）。検査で止まったときは { issues, records: null } */
  result: Json;
  /** レコードの渡し方。検査で止まってレコードを読んでいないときは "none" */
  from: SimRecords["from"] | "none";
  /** 当てたレコードの数 */
  count: number;
  query?: string;
  /** 項目定義を読めなかったアプリなどの注記 */
  notes: string[];
}

/** kintone から項目定義（と、ids / query ならレコード）を読んで模擬する。options はプラグインの simulate に渡す入力（records 以外。画面の指定など） */
export async function simulateSource(clientFor: GenericClientFor, call: GenericCaller, source: GenericSource, opt: FetchDefsOptions, input: SimRecordsInput, options: Json = {}): Promise<GenericSimulateResult> {
  // 渡し方の誤りは、kintone を読む前に止める
  planSimRecords(input);
  const { defs, notes } = await fetchGenericDefs(clientFor, call, source, opt);
  const context = { ownAppId: String(opt.app), lang: opt.lang };
  // **設定に止まる誤りがあれば、レコードを読まない**（検査を先に通す。模擬しないのにレコードを読みに行かない）
  const checked = (await call("check", [source, defs, context])) as { issues?: Array<{ severity?: string }> };
  if ((checked.issues ?? []).some((x) => x.severity === "error")) return { result: { issues: checked.issues, records: null }, from: "none", count: 0, notes };
  const recs = await fetchSimRecords(clientFor, opt, input);
  const result = (await call("simulate", [source, defs, context, { ...options, records: recs.records }])) as Json;
  return { result, from: recs.from, count: recs.records.length, ...(recs.query ? { query: recs.query } : {}), notes };
}
