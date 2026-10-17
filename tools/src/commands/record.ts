/**
 * record --app N --id R [--fields-from settings/<file>] [--out records/<file>] / record --summary
 * 1 レコードを GET して records/ に保存する（calc の入力）。--fields-from で設定の計算式が使う項目に絞れる（トークンの節約。$id / $revision は常に残す）。
 * --summary は取得済みのファイルの形（値は出さない）。print-craft-authoring の commands/record.ts が元（関連レコード一覧と HTML の走査は無い）。
 */
import type { RestClient } from "../kintone-rest.ts";
import { scanFormula } from "../scan.ts";

export type FieldValue = { type: string; value: unknown };
export type KintoneRecord = Record<string, FieldValue>;

export interface RecordFile {
  tool: "formula-authoring record";
  fetchedAt: string;
  baseUrl: string;
  appId: number;
  id: number;
  guestSpaceId?: number;
  /** --fields-from で絞ったときに残した項目（テーブルは「テーブル(子,子)」） */
  keptFields?: string[];
  record: KintoneRecord;
}

export interface RecordOptions {
  app: number;
  id: number;
  guestSpaceId?: number;
  /** 残す項目（無ければ全部） */
  keep?: Set<string>;
  now?: () => Date;
}

const ALWAYS = new Set(["$id", "$revision"]);

/**
 * 設定（元の値 FormulaSource の封筒か本体）の計算式が使う項目のコード。有効な行の fieldcode と、計算式の字面の識別子（走査）。
 * 設定の形でなければ null（絞らない）
 */
export function usedFieldCodes(settings: unknown): Set<string> | null {
  const s = settings as { pluginInfos?: Array<Record<string, unknown>> } | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.pluginInfos)) return null;
  const codes = new Set<string>();
  for (const row of s.pluginInfos) {
    if (!row || typeof row !== "object") continue;
    if (typeof row.fieldcode === "string" && !row.fieldcode.startsWith("$")) codes.add(row.fieldcode);
    const formula = typeof row.formulaSet === "string" ? row.formulaSet : typeof row.formula === "string" ? row.formula : "";
    if (formula) for (const id of scanFormula(formula).identifiers) codes.add(id);
  }
  return codes;
}

export function narrowRecord(record: KintoneRecord, keep: Set<string>): { record: KintoneRecord; kept: string[] } {
  const out: KintoneRecord = {};
  const kept: string[] = [];
  for (const [code, fv] of Object.entries(record)) {
    if (ALWAYS.has(code)) {
      out[code] = fv;
      continue;
    }
    if (fv?.type === "SUBTABLE" && Array.isArray(fv.value)) {
      const rows = fv.value as Array<{ id?: string; value: KintoneRecord }>;
      const childCodes = new Set(rows.flatMap((r) => Object.keys(r.value ?? {})));
      const wholeTable = keep.has(code);
      const usedChildren = [...childCodes].filter((c) => keep.has(c));
      if (!wholeTable && usedChildren.length === 0) continue;
      out[code] = {
        type: "SUBTABLE",
        value: rows.map((r) => {
          if (wholeTable) return r;
          const v: KintoneRecord = {};
          for (const c of usedChildren) if (r.value[c]) v[c] = r.value[c];
          return { ...(r.id ? { id: r.id } : {}), value: v };
        })
      };
      kept.push(wholeTable ? code : `${code}(${usedChildren.join(",")})`);
      continue;
    }
    if (keep.has(code)) {
      out[code] = fv;
      kept.push(code);
    }
  }
  return { record: out, kept };
}

/**
 * 設定が使う項目のうち、プレビューのレコードに無いもの（fields にある項目だけを見る。テーブルの子は、テーブルが無いか行があって子が無いとき）。
 * 関連レコード一覧（Ver.8）は仮のテーブル `親$子` を同じように見る（record --fields で取り直す）。
 * 古い records/ や絞りすぎたレコードで帳票が空欄になるのを preview の警告で知らせる（2026-10-06）
 */

export async function fetchRecord(client: RestClient, opt: RecordOptions): Promise<RecordFile> {
  const res = await client.get<{ record: KintoneRecord }>("record", { app: opt.app, id: opt.id }, opt.guestSpaceId);
  let record: KintoneRecord = { ...(res.record ?? {}) };
  let keptFields: string[] | undefined;
  if (opt.keep) {
    const n = narrowRecord(record, opt.keep);
    record = n.record;
    keptFields = n.kept;
  }
  return {
    tool: "formula-authoring record",
    fetchedAt: (opt.now ?? (() => new Date()))().toISOString(),
    baseUrl: client.baseUrl,
    appId: opt.app,
    id: opt.id,
    ...(opt.guestSpaceId ? { guestSpaceId: opt.guestSpaceId } : {}),
    ...(keptFields ? { keptFields } : {}),
    record
  };
}

const MULTI_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT", "CATEGORY"]);
const ENTITY_TYPES = new Set(["USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "STATUS_ASSIGNEE"]);
const DATE_TYPES: Record<string, string> = { DATE: "日付", DATETIME: "日時", CREATED_TIME: "日時", UPDATED_TIME: "日時", TIME: "時刻" };
const NUMERIC = /^-?\d+(\.\d+)?$/;

/** 値の形（値そのものは出さない）。空なら "空" */
function shapeOf(fv: FieldValue): string {
  const v = fv.value;
  if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) return "空";
  if (fv.type === "FILE" && Array.isArray(v)) {
    const byType = new Map<string, number>();
    for (const f of v as Array<{ contentType?: string }>) byType.set(f.contentType ?? "?", (byType.get(f.contentType ?? "?") ?? 0) + 1);
    return `${v.length} 件（${[...byType].map(([t, n]) => `${t} ${n}`).join("、")}）`;
  }
  if (MULTI_TYPES.has(fv.type) && Array.isArray(v)) return `${v.length} 個`;
  if (ENTITY_TYPES.has(fv.type) && Array.isArray(v)) return `${v.length} 件`;
  if (DATE_TYPES[fv.type]) return DATE_TYPES[fv.type];
  if (fv.type === "RECORD_NUMBER") return "あり";
  if (typeof v === "string") {
    if ((fv.type === "NUMBER" || fv.type === "CALC") && NUMERIC.test(v)) {
      const [int, dec] = v.replace("-", "").split(".");
      return `数値 ${v.startsWith("-") ? "負 " : ""}整数 ${int.length} 桁${dec ? `、小数 ${dec.length} 桁` : ""}`;
    }
    const lines = v.split("\n").length;
    return `${fv.type === "RICH_TEXT" ? "HTML " : ""}${[...v].length} 文字${lines > 1 ? `、${lines} 行` : ""}`;
  }
  if (typeof v === "object") return "あり";
  return typeof v;
}

/** テーブルの子の形を全行でまとめる（最も長い・行数の多い値と空の行の数） */
function columnShape(type: string, values: unknown[]): string {
  const shapes = values.map((value) => shapeOf({ type, value }));
  const filled = shapes.filter((s) => s !== "空");
  if (!filled.length) return "全行 空";
  const longest = filled.reduce((a, b) => (Number(b.match(/\d+/)?.[0] ?? 0) > Number(a.match(/\d+/)?.[0] ?? 0) ? b : a));
  const multiLine = filled.filter((s) => /\d+ 行$/.test(s)).length;
  return `最大 ${longest}${multiLine ? `（複数行の値 ${multiLine} 行）` : ""}${filled.length < shapes.length ? `、空 ${shapes.length - filled.length} 行` : ""}`;
}

/**
 * record --summary: 取得済みの records/<app>-<id>.json を 1 項目 1 行で。**値は出さず形だけ**（文字数・行数・数値の桁・件数・添付の種類。
 * SECURITY.md「レコードの値を標準出力に出さない」）。プレビューのレコードとして使えるか（備考に改行、明細が複数行、添付あり）を見るため（2026-10-05）
 */

/** record --summary の本文（1 項目 1 行。値は出さない） */
export function describeRecord(file: RecordFile): string {
  const header = `アプリ ${file.appId} レコード ${file.id}（取得 ${file.fetchedAt}${file.keptFields ? `、--fields-from で ${file.keptFields.length} 項目に絞った` : ""}）`;
  return [header, ...shapeLines(file.record)].join("\n");
}

/** レコードの形を 1 項目 1 行で（値は出さない。record --summary と records が使う） */
export function shapeLines(record: KintoneRecord): string[] {
  const lines: string[] = [];
  for (const [code, fv] of Object.entries(record)) {
    if (code === "$id" || code === "$revision" || !fv) continue;
    if (fv.type === "SUBTABLE" && Array.isArray(fv.value)) {
      const rows = fv.value as Array<{ value: KintoneRecord }>;
      lines.push(`${code}  SUBTABLE  ${rows.length} 行`);
      const children = new Map<string, { type: string; values: unknown[] }>();
      for (const r of rows) {
        for (const [c, cv] of Object.entries(r.value ?? {})) {
          const e = children.get(c) ?? { type: cv.type, values: [] };
          e.values.push(cv.value);
          children.set(c, e);
        }
      }
      for (const [c, e] of children) lines.push(`  ${c}  ${e.type}  ${columnShape(e.type, e.values)}`);
      continue;
    }
    lines.push(`${code}  ${fv.type}  ${shapeOf(fv)}`);
  }
  return lines;
}

/** 画面に出す要約（項目の数だけ。値は出さない） */
export function summarizeRecord(file: RecordFile): string {
  const codes = Object.keys(file.record);
  const tables = codes.filter((c) => file.record[c]?.type === "SUBTABLE");
  const rows = tables.map((t) => `${t} ${Array.isArray(file.record[t].value) ? (file.record[t].value as unknown[]).length : 0} 行`);
  return `アプリ ${file.appId} レコード ${file.id}: 項目 ${codes.length}${tables.length ? `（テーブル ${rows.join(", ")}）` : ""}`;
}
