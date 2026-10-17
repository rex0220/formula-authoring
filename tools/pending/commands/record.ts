/**
 * record --app N --id R [--fields-from <settings.json>] [--fields <fields.json>] [--guest S] [--out records/<file>]
 * レコードを /k/v1/record（{ type, value }、テーブルは入れ子）で取って records/<app>-<id>.json に保存する。preview の入力。
 * レコードは個人情報を含むので、--fields-from で設定が使う項目だけ残し、中身は画面とログに出さない（Codex MAJOR 5）。
 * 印刷屋 Ver.8（authoring API 3）: fields.json に related（関連レコード一覧の参照先の項目定義）があれば、印刷屋の zip の規則（relatedCondition /
 * fetchRelatedRecords / toRelatedRows）で参照先のレコードも取り、仮のテーブル `親$子` としてレコードに入れる（preview で工程表などを確かめられる。
 * print-craft の docs/related-records-spec.md 11.3）。取る子は設定の全ボタンの和（設定が無ければ全項目）。上限を超えたらエラー
 */
import type { PrintCraftAuthoringApi } from "print-craft/src/authoring/api.ts";
import type { FieldProp } from "print-craft/src/config/load.ts";
import type { RelatedChildren } from "print-craft/src/shared/related.ts";
import type { RestClient } from "../kintone-rest.ts";
import type { FieldsFile } from "./fields.ts";
import { expressionsOf } from "../normalize/html-check.ts";

export type FieldValue = { type: string; value: unknown };
export type KintoneRecord = Record<string, FieldValue>;

export interface RelatedTableInfo {
  app: number;
  /** 取った行の数 */
  rows: number;
  /** 取った子（参照先の項目コード）。"all" は全項目 */
  children: RelatedChildren;
}

export interface RecordFile {
  tool: "formula-authoring record";
  fetchedAt: string;
  baseUrl: string;
  appId: number;
  id: number;
  guestSpaceId?: number;
  /** --fields-from で絞ったときの残した項目（絞らなければ無い） */
  keptFields?: string[];
  /** 関連レコード一覧を仮のテーブルとして入れたもの（親コード → 参照先のアプリ・行数・子。Ver.8） */
  relatedTables?: Record<string, RelatedTableInfo>;
  record: KintoneRecord;
}

/** 関連レコードの取得に要るもの（record --fields。zip の API を使う） */
export interface RelatedFetchOptions {
  api: PrintCraftAuthoringApi;
  fields: FieldsFile;
  /** 設定（封筒形式。正規化前でもよい）。あれば使う親と子だけ、無ければ related の全部を全項目で */
  settings?: unknown;
  /** 参照先のアプリの接続（tokenMap） */
  clientFor: (app: number) => RestClient;
}

export interface RecordOptions {
  app: number;
  id: number;
  guestSpaceId?: number;
  /** 残す項目（undefined なら全部） */
  keep?: Set<string>;
  /** 関連レコード一覧も取る（fields に related があるとき） */
  related?: RelatedFetchOptions;
  now?: () => Date;
}

/** 常に残す疑似項目 */
const ALWAYS = new Set(["$id", "$revision"]);

/**
 * 式の中で項目コードになりうる語（"…" の文字列の中身と数値を除く）。計算式の文字列は \ を解釈しないので "…" は次の " まで。
 * 関数名やコメントの語も拾うが、絞るときはレコードにある項目しか残らないので害は無い（多めに拾う。絞りすぎるとプレビューが空欄になる）。
 * 関連レコード一覧の子 `親$子` は半角の $ を含むので 1 語のまま拾う
 */
export function identifiersOf(expr: string): string[] {
  return expr
    .replace(/"[^"]*"/g, " ")
    .split(/[^\p{L}\p{N}_・＿＄￥$]+/u)
    .filter((t) => t && !/^\d+$/.test(t));
}

/**
 * 設定 JSON（封筒形式。正規化済みでなくてもよい）から、帳票と更新項目が使う項目コードを集める。
 * usedFields（あれば）、HTML 欄の ${式} と計算式の本文の語、更新項目の fieldcode、filecode。何も見つからなければ null（絞らない）。
 * usedFields は計算式欄だけから作られ、HTML 欄の ${式}（宛名、合計など）を含まない（2026-10-06 のリハーサルで、--fields-from が宛名などを落として
 * プレビューが空欄になっていたのを見つけた）
 */
export function usedFieldCodes(settings: unknown): Set<string> | null {
  const codes = new Set<string>();
  const s = settings as { pluginInfos?: Array<Record<string, unknown>>; usedFields?: Record<string, unknown> } | null;
  if (!s || typeof s !== "object") return null;
  const addKeys = (o: unknown): void => {
    if (o && typeof o === "object") for (const k of Object.keys(o as Record<string, unknown>)) codes.add(k);
  };
  const addWords = (text: unknown): void => {
    if (typeof text === "string") for (const w of identifiersOf(text)) codes.add(w);
  };
  /** 計算式の本文（正規化済みなら formula、まだなら formulaSet） */
  const addFormula = (f: Record<string, unknown>): void => addWords(typeof f.formula === "string" && f.formula ? f.formula : f.formulaSet);
  addKeys(s.usedFields);
  for (const row of s.pluginInfos ?? []) {
    const tags = row.tagsInfo as { fieldsInfo?: Array<Record<string, unknown>>; filecode?: string } | undefined;
    for (const f of tags?.fieldsInfo ?? []) {
      addKeys(f.usedFields);
      addFormula(f);
      if (typeof f.html === "string") for (const e of expressionsOf(f.html)) addWords(e);
    }
    if (tags?.filecode) codes.add(tags.filecode);
    const calc = row.calcInfo as { fieldsInfo?: Array<Record<string, unknown>>; usedFields?: Record<string, unknown> } | undefined;
    addKeys(calc?.usedFields);
    for (const f of calc?.fieldsInfo ?? []) {
      if (f.state && typeof f.fieldcode === "string" && !f.fieldcode.startsWith("$")) codes.add(f.fieldcode);
      addKeys(f.usedFields);
      addFormula(f);
    }
  }
  for (const c of [...codes]) if (c.startsWith("$")) codes.delete(c);
  return codes.size ? codes : null;
}

/** keep の項目だけ残す。テーブルは、テーブル自身か子のどれかが keep にあれば残し、子は keep にあるものだけ（テーブル自身が keep なら全部）。関連レコードの仮のテーブルも同じ */
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
export function missingInRecord(settings: unknown, fields: Pick<FieldsFile, "properties" | "related">, record: KintoneRecord): string[] {
  const used = usedFieldCodes(settings);
  if (!used) return [];
  const missing: string[] = [];
  for (const [code, p] of Object.entries(fields.properties ?? {})) {
    if (p.type === "SUBTABLE") {
      const table = record[code];
      const rows = Array.isArray(table?.value) ? (table.value as Array<{ value?: KintoneRecord }>) : null;
      for (const child of Object.keys(p.fields ?? {})) {
        if (!used.has(child)) continue;
        if (!rows || (rows.length > 0 && !rows.some((r) => r.value && child in r.value))) missing.push(`${code}.${child}`);
      }
      if (used.has(code) && !table) missing.push(code);
      continue;
    }
    if (p.type === "REFERENCE_TABLE") {
      const table = record[code];
      const rows = Array.isArray(table?.value) ? (table.value as Array<{ value?: KintoneRecord }>) : null;
      const children = [...used].filter((u) => u.startsWith(`${code}$`));
      if ((used.has(code) || children.length > 0) && !table) {
        missing.push(code);
        continue;
      }
      for (const child of children) if (rows && rows.length > 0 && !rows.some((r) => r.value && child in r.value)) missing.push(child);
      continue;
    }
    if (used.has(code) && !(code in record)) missing.push(code);
  }
  return [...new Set(missing)];
}

export interface RelatedPlan {
  parent: string;
  app: number;
  children: RelatedChildren;
}

/**
 * 取る関連レコード一覧と子（印刷屋の zip の relatedChildrenUsedBy。設定があれば有効な全ボタンの和、どれかが裸の親コードを使えば全項目。
 * 設定が無ければ related の全部を全項目で）
 */
export function relatedPlanOf(api: PrintCraftAuthoringApi, fields: FieldsFile, settings?: unknown): RelatedPlan[] {
  const related = fields.related ?? {};
  const parents = Object.keys(related);
  if (parents.length === 0 || typeof api.relatedChildrenUsedBy !== "function") return [];
  if (!settings || typeof settings !== "object") return parents.map((parent) => ({ parent, app: related[parent].app, children: "all" as const }));
  const rows = ((settings as { pluginInfos?: unknown[] }).pluginInfos ?? []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
  const merged = new Map<string, Set<string> | "all">();
  for (const row of rows) {
    if (!row.state) continue;
    const used = api.relatedChildrenUsedBy(row as unknown as Parameters<PrintCraftAuthoringApi["relatedChildrenUsedBy"]>[0], parents);
    for (const [parent, children] of Object.entries(used)) {
      const cur = merged.get(parent);
      if (children === "all" || cur === "all") {
        merged.set(parent, "all");
        continue;
      }
      const set = cur ?? new Set<string>();
      for (const c of children) set.add(c);
      merged.set(parent, set);
    }
  }
  return [...merged.entries()].map(([parent, children]) => ({ parent, app: related[parent].app, children: children === "all" ? "all" : [...children] }));
}

/** 印刷屋の zip の RelatedRecordError（key と params）を日本語に（record の失敗の文言。値は入れない） */
export function relatedErrorText(e: unknown): string | null {
  const err = e as { name?: string; key?: string; parent?: string; params?: string[] };
  if (!err || err.name !== "RelatedRecordError" || typeof err.key !== "string") return null;
  const [a, b, c] = err.params ?? [];
  const parent = err.parent ?? "?";
  switch (err.key) {
    case "relatedTooMany":
      return `関連レコード一覧 ${parent} の参照先のレコードが ${a} 件あり、上限（${b} 件）を超えている（印刷屋は帳票を作らない。関連レコード一覧の「さらに絞り込む条件」で減らす）`;
    case "relatedNoPermission":
      return `関連レコード一覧 ${parent} の参照先のアプリを参照する権限が無い`;
    case "relatedFieldUnavailable":
      return `関連レコード一覧 ${parent} の参照先の項目 ${a} が応答に無い（項目のアクセス権）`;
    case "relatedUnsupportedCondition":
      return `関連レコード一覧 ${parent} の条件の項目の型（${a}）には印刷屋 Ver.8 は対応していない`;
    case "relatedUnsupportedValue":
      return `関連レコード一覧 ${parent} の条件の値が項目の型（${c ?? b}）に合わない`;
    default:
      return `関連レコード一覧 ${parent} を取れない: ${a ?? err.key}`;
  }
}

/**
 * 関連レコードを取り、レコードに仮のテーブルとして入れる（record を書き換える）。規則は印刷屋の zip の関数（条件・クエリ・ページング・上限・行の形）。
 * 参照先のアプリの接続は clientFor（tokenMap）。REST の GET は tools の RestClient（許可した API だけ、受け取る量に上限）
 */
export async function fetchRelatedTables(record: KintoneRecord, opt: RelatedFetchOptions, guestSpaceId?: number): Promise<Record<string, RelatedTableInfo>> {
  const { api, fields } = opt;
  const plan = relatedPlanOf(api, fields, opt.settings);
  const tables: Record<string, RelatedTableInfo> = {};
  const properties = fields.properties as unknown as Record<string, FieldProp>;
  for (const item of plan) {
    const r = fields.related![item.parent];
    const relatedDefs = { [item.parent]: { app: String(r.app), properties: r.properties as unknown as Record<string, FieldProp>, children: item.children } };
    const pp = api.expandRelatedFields(properties, relatedDefs);
    const def = api.relatedDefOf(properties[item.parent]);
    if (!def) continue;
    const childDefs = (pp[item.parent]?.fields ?? {}) as Record<string, FieldProp>;
    const ownField = properties[def.condition.field];
    const relatedType = (r.properties[def.condition.relatedField] as { type?: string } | undefined)?.type;
    let rows: Array<{ id: string; value: Record<string, FieldValue> }> = [];
    try {
      const condition = api.relatedCondition(item.parent, def, ownField, record[def.condition.field]?.value, relatedType, record["$id"]?.value);
      if (condition !== null) {
        const rest = opt.clientFor(item.app);
        // 印刷屋の fetchRelatedRecords は kintone.api の形（path, method, params）で呼ぶので、tools の GET（records）に合わせる。fields は fields[0]… の形
        const adapter = {
          api: async <T,>(_path: string, _method: string, params: Record<string, unknown>): Promise<T> => {
            const flat: Record<string, string | number | boolean | undefined> = { app: String(params.app), query: String(params.query), totalCount: params.totalCount === true };
            (params.fields as string[] | undefined)?.forEach((f, i) => (flat[`fields[${i}]`] = f));
            return rest.get<T>("records", flat, guestSpaceId);
          }
        };
        const codes = ["$id", ...Object.values(childDefs).map((d) => String(d.relatedCode ?? ""))];
        const records = await api.fetchRelatedRecords(adapter, item.parent, String(item.app), condition, def, codes, api.RELATED_LIMIT);
        rows = api.toRelatedRows(item.parent, childDefs, records as KintoneRecord[]);
      }
    } catch (e) {
      const text = relatedErrorText(e);
      if (text) throw new Error(text);
      throw e;
    }
    record[item.parent] = { type: "SUBTABLE", value: rows };
    tables[item.parent] = { app: item.app, rows: rows.length, children: item.children };
  }
  return tables;
}

export async function fetchRecord(client: RestClient, opt: RecordOptions): Promise<RecordFile> {
  const res = await client.get<{ record: KintoneRecord }>("record", { app: opt.app, id: opt.id }, opt.guestSpaceId);
  // 応答のオブジェクトは書き換えない（仮のテーブルは写しに足す）
  let record: KintoneRecord = { ...(res.record ?? {}) };
  let keptFields: string[] | undefined;
  // 関連レコード（Ver.8）は絞る前の本体の値（条件の項目）で取る
  const relatedTables = opt.related ? await fetchRelatedTables(record, opt.related, opt.guestSpaceId) : undefined;
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
    ...(relatedTables && Object.keys(relatedTables).length ? { relatedTables } : {}),
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
export function describeRecord(file: RecordFile): string {
  const related = file.relatedTables ? `、関連レコード ${Object.entries(file.relatedTables).map(([p, t]) => `${p} ${t.rows} 行`).join(" / ")}` : "";
  const header = `アプリ ${file.appId} レコード ${file.id}（取得 ${file.fetchedAt}${file.keptFields ? `、--fields-from で ${file.keptFields.length} 項目に絞った` : ""}${related}）。値は出さない（形だけ）`;
  return [header, ...shapeLines(file.record)].join("\n");
}

/** レコードの形を 1 項目 1 行で（値は出さない。record --summary と kintone_list_records が使う） */
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
  const relatedCodes = new Set(Object.keys(file.relatedTables ?? {}));
  const tables = codes.filter((c) => file.record[c]?.type === "SUBTABLE" && !relatedCodes.has(c));
  const rows = tables.map((t) => `${t} ${Array.isArray(file.record[t].value) ? (file.record[t].value as unknown[]).length : 0} 行`);
  const related = [...relatedCodes].map((c) => `${c} ${file.relatedTables![c].rows} 行（アプリ ${file.relatedTables![c].app}）`);
  return `アプリ ${file.appId} レコード ${file.id}: 項目 ${codes.length}${tables.length ? `（テーブル ${rows.join(", ")}）` : ""}${related.length ? `、関連レコード ${related.join(", ")}` : ""}${file.keptFields ? `。--fields-from で ${file.keptFields.length} 項目に絞った` : ""}。値は表示しない`;
}
