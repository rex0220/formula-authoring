/**
 * diff <before.json> <after.json>
 * 2 つの設定ファイル（元の値 FormulaSource の封筒）の差を項目単位で出す。計算式か有効が変わった項目には「既存レコードの値に影響する」印
 * （保存しても既存のレコードは変わらない。利用者が「既存レコードを変更」か「一括計算」を実行して初めて反映。オーサリングツール_実装計画.md 2 章の反映の 4 段）。
 */
import { jsonDiff } from "../input.ts";
import { bodyOf, rowsOf, type SourceRow } from "./summary.ts";

export interface FieldChange {
  fieldcode: string;
  kind: "added" | "removed" | "changed";
  /** 変わった列（formulaSet / state / edit / hide / rank） */
  keys: string[];
  /** 計算式か有効が変わった = 既存レコードの値に影響する */
  affectsRecords: boolean;
}

export interface DiffResult {
  fields: FieldChange[];
  /** 共通の設定（各種設定、ボタン、一覧、権限、説明など）の差（path: before → after） */
  common: string[];
  lines: string[];
}

const COMMON_KEYS = ["pluginEnable", "pluginProductEnv", "toolEnable", "pluginComment", "pluginDescription", "pluginBtnInfo", "pluginListInfo", "authority", "pluginMiscInfo"];

const isBlank = (r: SourceRow | undefined): boolean => !r || (r.formulaSet.trim() === "" && !r.state && !r.edit && !r.hide && r.rank === "");

export function diffSettings(before: Record<string, unknown>, after: Record<string, unknown>, names: { before: string; after: string }): DiffResult {
  const a = rowsOf(bodyOf(before), names.before);
  const b = rowsOf(bodyOf(after), names.after);
  const am = new Map(a.map((r) => [r.fieldcode, r]));
  const bm = new Map(b.map((r) => [r.fieldcode, r]));
  const fields: FieldChange[] = [];
  for (const code of new Set([...am.keys(), ...bm.keys()])) {
    const x = am.get(code);
    const y = bm.get(code);
    if (isBlank(x) && isBlank(y)) continue;
    if (!x || isBlank(x)) { fields.push({ fieldcode: code, kind: "added", keys: ["formulaSet", "state"], affectsRecords: !!y?.state && !!y.formulaSet.trim() }); continue; }
    if (!y || isBlank(y)) { fields.push({ fieldcode: code, kind: "removed", keys: ["formulaSet", "state"], affectsRecords: x.state && x.formulaSet.trim() !== "" }); continue; }
    const keys = (["formulaSet", "state", "edit", "hide", "rank"] as const).filter((k) => String(x[k]) !== String(y[k]));
    if (!keys.length) continue;
    fields.push({ fieldcode: code, kind: "changed", keys: [...keys], affectsRecords: keys.includes("formulaSet") || keys.includes("state") || keys.includes("rank") });
  }
  const common: string[] = [];
  const ab = bodyOf(before);
  const bb = bodyOf(after);
  for (const k of COMMON_KEYS) jsonDiff(ab[k], bb[k], k, common);
  const lines: string[] = [];
  lines.push(`${names.before} → ${names.after}: 項目の差 ${fields.length}、共通の設定の差 ${common.length}`);
  for (const f of fields) {
    const tag = f.kind === "added" ? "追加" : f.kind === "removed" ? "削除" : `変更（${f.keys.join(", ")}）`;
    lines.push(`  ${f.affectsRecords ? "★" : "　"} ${f.fieldcode}: ${tag}`);
  }
  for (const c of common) lines.push(`  ${c}`);
  const affected = fields.filter((f) => f.affectsRecords).map((f) => f.fieldcode);
  if (affected.length) lines.push(`★ = 既存レコードの値に影響する項目（${affected.length}）。保存しても既存のレコードは変わらない。反映は設定画面で取り込み → 保存 → 運用環境に反映 → 「既存レコードを変更」か「一括計算」`);
  return { fields, common, lines };
}
