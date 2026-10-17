/**
 * レコードを数件、形の要約だけで見る（段階 0-2 の段 4。print-craft MCP の kintone_list_records の本体。docs/api-table.md、実装案 5.4）。
 * プレビュー用の代表の 1 件を選ぶため。値・ファイル名・ユーザー名は返さない（形だけ。record --summary と同じ shapeLines）。保存もしない。
 *   - query は条件と並べ替えだけ。limit / offset を含めば止める（件数は AI に決めさせない。サーバーが末尾に limit を付ける）
 *   - query は 500 文字まで（URL の 8 KB の上限に届かないように）
 *   - 返す JSON の UTF-8 のバイト数に上限を付け、超える前の件で打ち切る（truncated。項目コードの日本語・エスケープ・query を含めて測る）
 */
import type { RestClient } from "../kintone-rest.ts";
import { shapeLines } from "./record.ts";
import type { KintoneRecord } from "./record.ts";

export const LIST_LIMIT = 5;
export const QUERY_MAX = 500;
/** AI に返す JSON の上限（docs/api-table.md の 64 KiB。JSON.stringify した UTF-8 のバイト数。Codex レビュー MINOR 7） */
export const SHAPE_TEXT_MAX = 64 * 1024;

export class QueryError extends Error {}

/** 引用符の中を除いた query（limit / offset の検査で、値の中の文字に反応しないように） */
function withoutQuoted(q: string): string {
  return q.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** 受け取った query を検査し、末尾に limit を付けた query を返す */
export function listQueryOf(query: string | undefined): string {
  const q = (query ?? "").trim();
  if ([...q].length > QUERY_MAX) throw new QueryError(`query は ${QUERY_MAX} 文字まで`);
  if (/\b(limit|offset)\b/i.test(withoutQuoted(q))) throw new QueryError("query に limit / offset は書かない（件数はサーバーが決める）");
  return q ? `${q} limit ${LIST_LIMIT}` : `limit ${LIST_LIMIT}`;
}

export interface RecordShape {
  /** レコード番号（$id） */
  id: string;
  /** 1 項目 1 行の形（値は出さない） */
  lines: string[];
}

export interface RecordShapes {
  appId: number;
  query: string;
  records: RecordShape[];
  /** 返す文字の上限で打ち切った */
  truncated: boolean;
}

/** maxBytes は試験用（既定 SHAPE_TEXT_MAX） */
export async function listRecordShapes(client: RestClient, opt: { app: number; query?: string; guestSpaceId?: number; maxBytes?: number }): Promise<RecordShapes> {
  const max = opt.maxBytes ?? SHAPE_TEXT_MAX;
  const query = listQueryOf(opt.query);
  const res = await client.get<{ records?: KintoneRecord[] }>("records", { app: opt.app, query }, opt.guestSpaceId);
  const out: RecordShape[] = [];
  let truncated = false;
  for (const record of (res.records ?? []).slice(0, LIST_LIMIT)) {
    const idValue = (record.$id as { value?: unknown } | undefined)?.value;
    const shape = { id: typeof idValue === "string" ? idValue : String(idValue ?? ""), lines: shapeLines(record) };
    // 足した後の応答全体を、長い方の形（truncated: false。"false" は "true" より 1 バイト長い）で測る。打ち切るときの応答はこれより小さい（Codex 再レビュー MINOR 5）
    if (Buffer.byteLength(JSON.stringify({ appId: opt.app, query, records: [...out, shape], truncated: false }), "utf8") > max) {
      truncated = true;
      break;
    }
    out.push(shape);
  }
  return { appId: opt.app, query, records: out, truncated };
}
