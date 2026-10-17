/**
 * normalize / calc が設定画面と同じ順で使う材料（fields → pp / views / 行）。計算式のコードは呼ばず、形を揃えるだけ。
 *   設定画面（formula の load.ts の loadFormulaData）: properties → pp に $id / $revision を足す → createCheckRecord（テーブルの子を pp に平らにして ptcode を付け、検証用レコード crec を作る）
 *   → buildLayoutRows（fields + layout からグリッドの行）→ applySaved（保存値を行に）→ checkFormula（行ごと）→ finalizeSaved（内部番号。Node では番号を使う行のコードを返す）→ deriveSemantic
 */
import type { FormulaAuthoringApi } from "../engine.ts";
import type { FieldsFile } from "../commands/fields.ts";

export type Api = FormulaAuthoringApi;
/** formula の load.ts の FieldProp（構造だけ。API の型から導くと配布する型（any の代わりの型）で壊れる） */
export interface FieldProp {
  type: string;
  code: string;
  label?: string;
  ptcode?: string;
  fid?: number;
  lookup?: unknown;
  fields?: Record<string, FieldProp>;
  [key: string]: unknown;
}
/** formula の load.ts の FieldRow（グリッドの行。構造だけ） */
export interface FieldRow {
  id: string;
  row_type: string;
  type: string;
  fieldlabel: string;
  fieldcode: string;
  state: boolean;
  formulaSet: string;
  edit: boolean;
  hide: boolean;
  rank: number | string;
  ptcode: string | null;
  usedFields?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface ViewItem {
  id: string;
  name: string;
  type: string;
  index: number;
}
export type FormulaSource = Record<string, unknown> & { pluginInfos: Array<Record<string, unknown>>; pluginMiscInfo: Record<string, unknown>; pluginListInfo: Record<string, unknown>; authority: Record<string, unknown>; pluginEnable: boolean };
export type FormulaSaved = FormulaSource & { pluginFields: Array<{ fieldcode: string; formula: string; usedFields: Record<string, unknown>; ptcode?: string | null; [key: string]: unknown }>; pluginPP: Record<string, unknown>; tableTrigger: Record<string, unknown> };
export type Lang = "ja" | "en" | "zh";

/** fields → pp（設定画面と同じ。$id / $revision を足し、createCheckRecord でテーブルの子を平らにする） */
export function materialsOf(api: Api, fields: FieldsFile, lang: Lang): { pp: Record<string, FieldProp>; crec: Record<string, unknown>; rows: FieldRow[]; views: ViewItem[] } {
  const pp = structuredClone(fields.properties) as unknown as Record<string, FieldProp>;
  pp["$id"] = { type: "RECORD_NUMBER", code: "$id", label: "$id" };
  pp["$revision"] = { type: "__REVISION__", code: "$revision", label: "$revision" };
  const crec = api.createCheckRecord(pp as never) as Record<string, unknown>;
  const rows = api.buildLayoutRows(pp as never, fields.layout as never) as unknown as FieldRow[];
  return { pp, crec, rows, views: viewsOf(fields, lang) };
}

/** fields の views → 設定画面と同じ一覧（LIST だけ + 「(すべて)」id 20 index 1000）。views が無ければ空（突き合わせない） */
export function viewsOf(fields: FieldsFile, lang: Lang): ViewItem[] {
  if (!fields.views) return [];
  const all = { ja: "(すべて)", en: "(All)", zh: "(全部)" }[lang];
  const out: ViewItem[] = [];
  for (const v of Object.values(fields.views)) {
    if (v.type && v.type !== "LIST") continue;
    out.push({ id: String(v.id), name: v.name, type: v.type ?? "LIST", index: Number(v.index) });
  }
  out.push({ id: "20", name: all, type: "LIST", index: 1000 });
  out.sort((a, b) => Number(a.index) - Number(b.index));
  return out;
}

/** 行の型（"NUMBER\n(LOOKUP)" のような印を除いたもの） */
export const typeOf = (row: FieldRow): string => String(row.type ?? "").split("\n")[0];
export const isLookupRow = (row: FieldRow): boolean => String(row.type ?? "").includes("(LOOKUP)");
export const isHeaderRow = (row: FieldRow): boolean => typeOf(row) === "HEADER";
export const isSpacerRow = (row: FieldRow): boolean => typeOf(row) === "SPACER";
export const isGroupRow = (row: FieldRow): boolean => typeOf(row) === "GROUP";

/** 封筒のキー（kit の buildExportData） */
export const ENVELOPE_KEYS = ["date", "pluginName", "pluginID", "PluginVersion", "appId", "appName"] as const;
/** 設定画面の保存が外枠に足すキー（取り込みでは捨てる） */
export const OUTER_KEYS = ["pluginLastUpdate", "pluginUpdater", "startDate", "name", "version", "ldate", "error", "compress"] as const;
/** 画面の行（SavedInfo）が持つ、元の値以外のキー（取り込みでは捨てる） */
export const ROW_SCREEN_KEYS = ["id", "row_type", "type", "fieldlabel", "ptcode", "usedFields", "width", "formula", "message", "fieldno", "tableno", "tablepos"] as const;
export const ROW_SOURCE_KEYS = ["fieldcode", "state", "formulaSet", "edit", "hide", "rank"] as const;
