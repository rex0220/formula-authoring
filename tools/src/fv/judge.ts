/**
 * 項目検証の判定の模擬（field-validation/docs/オーサリングツール_実装計画.md 6 章）。保存値とレコードから、項目ごとに 非表示 / 入力不可 / 必須 / 文 / 保存の前に入れる値 を返す。
 * 規則は項目検証の一覧編集向けの判定の口（evaluate）と同じ（work-link/fv-authoring-spike/README.md の「判定の規則の表」から書いた。項目検証のコードは写していない）。
 * 画面への反映（DOM、枠線の色、グループの開閉）、詳細画面と印刷、値の変更の後の非同期の再検査は模擬しない。式は計算式の engine.runner で評価する
 */
import type { Engine, FormulaInstance } from "../engine.ts";

const SKIP_TOP = new Set(["GROUP", "REFERENCE_TABLE", "SPACER", "LABEL", "HR"]);
const NO_INIT = new Set(["GROUP", "SUBTABLE", "CALC", "FILE", "REFERENCE_TABLE", "SPACER", "LABEL", "HR"]);
const ARRAY_VALUE = new Set(["CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "FILE"]);
const EMPTY_RICH = new Set(["<div></div>", "<div><br /></div>", "<div><br></div>", "<br />", "<br>"]);
const SUBMIT = new Set(["app.record.edit.submit", "app.record.create.submit", "app.record.index.edit.submit"]);
export const FV_JUDGE_DEFAULT_EVENT = "app.record.index.edit.change";

export type FvLang = "ja" | "en" | "zh";

/** 利用者に見える文（項目検証の画面と同じ 3 言語。英語の数値の最小・最大の文も同じ） */
const TEXT = {
  required: { ja: "必須項目", en: "Required.", zh: "Required." },
  notNumber: { ja: "数字でなければなりません。", en: "Only numbers are allowed. Required.", zh: "必须输入数字。 此为必填项。" },
  min: { ja: ["", "以上である必要があります。"], en: ["The value must be ", " or less."], zh: ["值不得少于 ", ""] },
  max: { ja: ["", "以下である必要があります。"], en: ["The value must be ", " or more."], zh: ["值不得超过 ", ""] },
  minLen: { ja: ["", "文字より長くなければなりません。"], en: ["Enter more than ", " characters."], zh: ["必须多于", "个字符。"] },
  maxLen: { ja: ["", "文字より短くなければなりません。"], en: ["Enter less than ", " characters."], zh: ["必须少于", "个字符。"] }
} as const;
const wrap = (pair: Readonly<Record<FvLang, readonly [string, string]>>, lang: FvLang, v: unknown): string => `${pair[lang][0]}${String(v)}${pair[lang][1]}`;

export interface FvJudgement {
  hidden: boolean;
  disabled: boolean;
  required: boolean;
  errors: string[];
  /** 保存の前に入れる値（隠れて初期化がオンの項目。隠れたルックアップは lookup: "CLEAR"） */
  reset?: { value?: unknown; lookup?: "CLEAR" };
}
export interface FvJudgeResult {
  ok: boolean;
  fields: Record<string, FvJudgement>;
  /** テーブルのコード → 行ごと（子の項目コード → 判定、$ADD_BUTTON / $DEL_BUTTON → { hidden }） */
  tables: Record<string, Array<Record<string, FvJudgement | { hidden: boolean }>>>;
}

type Cell = { value?: unknown } | undefined;
type SavedRow = Record<string, unknown> & {
  fieldcode: string; type: string; type2?: string; ptcode?: string | null; formula?: string; disabled?: string; hide?: string;
  init?: boolean; lookup?: boolean; defaultValue?: unknown; condDesc?: string; minValue?: unknown; maxValue?: unknown; minLength?: unknown; maxLength?: unknown;
  condInfos?: Array<Record<string, unknown> & { state?: boolean; cond?: string }>;
  tblfields?: Array<{ fieldcode: string; state?: boolean; hide?: string }>;
};

/** 全角の英数字を半角に、カンマを除く（数値の入力の読み方） */
const toHalfNumber = (s: string): string => s.replace(/，/g, "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/,/g, "");

function blank(type: string, cell: Cell): boolean {
  const v = cell ? cell.value : undefined;
  if (ARRAY_VALUE.has(type)) return !v || (v as unknown[]).length === 0;
  if (type === "RICH_TEXT") return !v || EMPTY_RICH.has(v as string);
  return !v;
}

/** 数値・文字列（1 行）の制約の文（隠れていても空でも見る） */
function constraintText(row: SavedRow, cell: Cell, lang: FvLang): string {
  if (row.type === "NUMBER") {
    if (!cell || !("value" in cell) || cell.value === undefined) return "";
    let n = Number(cell.value);
    if (Number.isNaN(n)) {
      n = Number(toHalfNumber(String(cell.value)));
      if (Number.isNaN(n)) return TEXT.notNumber[lang];
    }
    if (row.minValue && n < Number(row.minValue)) return wrap(TEXT.min, lang, row.minValue);
    if (row.maxValue && n > Number(row.maxValue)) return wrap(TEXT.max, lang, row.maxValue);
    return "";
  }
  if (row.type === "SINGLE_LINE_TEXT") {
    const len = String((cell && cell.value) || "").length;
    if (row.minLength && len < Number(row.minLength)) return wrap(TEXT.minLen, lang, Number(row.minLength) - 1);
    if (row.maxLength && len > Number(row.maxLength)) return wrap(TEXT.maxLen, lang, Number(row.maxLength) + 1);
  }
  return "";
}

export interface FvJudgeOptions {
  /** 式に渡すイベント名（EV_INFO("type")。保存の前の submit のときだけ初期化を返す） */
  type?: string;
  lang?: FvLang;
}

/**
 * 1 件のレコードを判定する。saved は項目検証の保存値（pluginFields / pluginPP）。record は kintone の形で、写してから使う（書き換えない）。
 * 呼ぶ前に engine.setContext で文脈（アプリ、ログインユーザー、mobile、ユーザー情報）を決めておく（runner を作るときに読まれる）
 */
export function fvJudgeRecord(engine: Engine, saved: { pluginFields: SavedRow[]; pluginPP: unknown }, record: Record<string, unknown>, opt: FvJudgeOptions = {}): FvJudgeResult {
  const evType = opt.type || FV_JUDGE_DEFAULT_EVENT;
  const lang: FvLang = opt.lang === "en" || opt.lang === "zh" ? opt.lang : "ja";
  const rec = JSON.parse(JSON.stringify(record)) as Record<string, { value?: unknown }>;
  const inst: FormulaInstance = engine.runner(saved.pluginPP, rec, evType);
  const truthy = (expr: unknown): boolean => {
    if (!expr) return false;
    try { return !!inst.dq(String(expr)); } catch { return false; }
  };
  const textOf = (expr: unknown): string => {
    try {
      const v = inst.dq(String(expr ?? ""));
      return v === false || v === null || v === undefined ? "" : String(v);
    } catch { return ""; }
  };
  let ok = true;

  const decide = (row: SavedRow, cell: Cell, hidden: boolean): FvJudgement => {
    const out: FvJudgement = { hidden, disabled: false, required: false, errors: [] };
    if (hidden && row.init && row.lookup && row.defaultValue === "" && cell && cell.value !== "") out.reset = { value: "", lookup: "CLEAR" };
    const disabled = !hidden && truthy(row.disabled);
    const need = truthy(row.formula);
    const required = !hidden && !disabled && need;
    let failed = false;
    const fieldText = constraintText(row, cell, lang);
    if (fieldText) { out.errors.push(fieldText); failed = true; }
    if (!failed && !hidden && !disabled && row.condDesc === "Y") {
      const hit = (row.condInfos ?? []).find((c) => c.state && truthy(c.cond));
      if (hit) { out.errors.push(textOf(hit[lang])); failed = true; }
    }
    if (!failed && SUBMIT.has(evType) && hidden && row.init && !NO_INIT.has(row.type)) {
      out.reset = { ...out.reset, value: row.type === "TIME" ? String(row.defaultValue || "").slice(0, 5) : row.defaultValue };
    }
    if (!failed && required && blank(row.type, cell)) out.errors.push(TEXT.required[lang]);
    out.disabled = disabled;
    out.required = required;
    if (out.errors.length) ok = false;
    return out;
  };

  const fields: FvJudgeResult["fields"] = {};
  const tables: FvJudgeResult["tables"] = {};
  const columnHidden: Record<string, boolean> = {};
  // 一番上の行（保存値の並び）。テーブル内非表示は列ごとに、テーブルの文脈の外で決める
  for (const row of saved.pluginFields) {
    if (row.ptcode) continue;
    inst.initTableInfo(row.ptcode as string);
    if (SKIP_TOP.has(row.type) || !(row.fieldcode in rec)) continue;
    const hidden = truthy(row.hide);
    if (row.type === "SUBTABLE" && row.tblfields) {
      for (const t of row.tblfields) {
        if (hidden) columnHidden[t.fieldcode] = true;
        else if (t.state && t.hide) columnHidden[t.fieldcode] = truthy(t.hide);
      }
    }
    fields[row.fieldcode] = decide(row, rec[row.fieldcode], hidden);
  }
  // テーブルの子と行のボタン（列ごとに、行の文脈で）
  for (const row of saved.pluginFields) {
    const table = row.ptcode;
    if (!table || !(table in rec)) continue;
    inst.initTableInfo(table);
    const lines = (rec[table].value as Array<{ value: Record<string, Cell> }> | undefined) ?? [];
    tables[table] ??= lines.map(() => ({}));
    lines.forEach((line, i) => {
      inst.currRow(i);
      const button = row.type === "$BUTTON";
      if (!button && !(row.fieldcode in line.value)) return;
      const hidden = columnHidden[row.fieldcode] || truthy(row.hide);
      if (button) { tables[table][i][String(row.type2)] = { hidden }; return; }
      tables[table][i][row.fieldcode] = decide(row, line.value[row.fieldcode], hidden);
    });
  }
  return { ok, fields, tables };
}
