/**
 * 項目検証の行（設定画面の主グリッドの行と同じもの）を、アプリの項目（form/fields）とレイアウト（form/layout）から作り、元の値を突き合わせる。
 * 行の種類: 一番上の項目、グループの中の項目、テーブル（とテーブル内非表示の子の一覧）、テーブルの子、要素 ID の行（スペース・ラベル・罫線。fieldcode は "(要素ID)"）、
 * テーブルの行の追加・削除ボタン（fieldcode は "<テーブル>($ADD)" / "($DEL)"）。ptcode は一番上と要素 ID の行が ""、テーブルの子とボタンがテーブル、テーブル・グループ自身とグループの中が null
 */
import { FV_BUTTON_TYPE, FV_ELEMENT_TYPES, FV_TARGET_TYPES, type FvSource, type FvSourceCond, type FvSourceInfo } from "./model.ts";

export interface FvProp {
  type: string;
  code: string;
  label?: string;
  ptcode?: string;
  lookup?: unknown;
  defaultValue?: unknown;
  required?: unknown;
  maxValue?: unknown;
  minValue?: unknown;
  maxLength?: unknown;
  minLength?: unknown;
  displayScale?: unknown;
  fields?: Record<string, FvProp>;
}

export interface FvTblChild { id: string; state: boolean; fieldcode: string; fieldlabel: string; type: string; hideSet: string; [k: string]: unknown }
export interface FvRowCond extends FvSourceCond { [k: string]: unknown }

export interface FvRow {
  id: string;
  ptcode: string | null;
  state: boolean;
  row_type: string;
  type: string;
  type2: string;
  lookup: boolean;
  fieldlabel: string;
  fieldcode: string;
  constrain: string;
  formulaSet: string;
  disabledSet: string;
  hideSet: string;
  init: boolean;
  defaultValue: unknown;
  check: unknown;
  required: unknown;
  maxValue: unknown;
  minValue: unknown;
  maxLength: unknown;
  minLength: unknown;
  displayScale: unknown;
  condInfos: FvRowCond[];
  condDesc: string;
  message: string;
  tblfields?: FvTblChild[];
  [k: string]: unknown;
}

interface LayoutField { type?: string; code?: string; elementId?: string }
export interface FvLayoutRow { type?: string; code?: string; fields?: LayoutField[]; layout?: Array<{ fields?: LayoutField[] }> }

const isTarget = (type: string | undefined): boolean => !!type && FV_TARGET_TYPES.includes(type);
const or = (v: unknown, empty: unknown): unknown => (v ? v : empty);

/**
 * 式の評価に使う項目の表（pluginPP の元）と、検査用のレコード。表は渡したものの写しで、$id / $revision を足し、テーブルの子を平らに入れて ptcode（親）を付ける。
 * 検査用のレコードは各項目の初期値（無ければ ""）で、テーブルは 1 行
 */
export function fvPropsOf(properties: Record<string, FvProp>): { pp: Record<string, FvProp>; crec: Record<string, unknown> } {
  const pp: Record<string, FvProp> = JSON.parse(JSON.stringify(properties));
  pp.$id = { type: "RECORD_NUMBER", code: "$id", label: "$id" };
  pp.$revision = { type: "__REVISION__", code: "$revision", label: "$revision" };
  const crec: Record<string, { type: string; value: unknown }> = {};
  for (const code of Object.keys(pp)) {
    const p = pp[code];
    p.ptcode = "";
    crec[code] ??= { type: p.type, value: or(p.defaultValue, "") };
    if (p.type !== "SUBTABLE") continue;
    const line: Record<string, { type: string; value: unknown }> = {};
    crec[code].value = [{ value: line }];
    for (const [child, cp] of Object.entries(p.fields ?? {})) {
      pp[child] = cp;
      cp.ptcode = code;
      line[child] = { type: cp.type, value: or(cp.defaultValue, "") };
    }
  }
  return { pp, crec };
}

/** フォームの制約の表示（"required, max:10, minLen:2" の形） */
function constrainOf(p: FvProp | undefined): string {
  if (!p) return "";
  return [
    p.required ? "required" : "",
    p.maxValue ? `max:${String(p.maxValue)}` : "",
    p.minValue ? `min:${String(p.minValue)}` : "",
    p.maxLength ? `maxLen:${String(p.maxLength)}` : "",
    p.minLength ? `minLen:${String(p.minLength)}` : ""
  ].filter(Boolean).join(", ");
}

/** 項目の行（フォームで必須なら必須条件は "1"） */
function fieldRow(id: string, ptcode: string | null, rowType: string, type: string, code: string, label: string, p: FvProp | undefined): FvRow {
  const lookup = !!(p && p.lookup);
  return {
    id, ptcode, state: false, row_type: rowType, type, type2: type + (lookup ? "\n(LOOKUP)" : ""), lookup,
    fieldlabel: label, fieldcode: code, constrain: constrainOf(p),
    formulaSet: p?.required ? "1" : "", disabledSet: "", hideSet: "", init: false,
    defaultValue: or(p?.defaultValue, ""), check: false, required: or(p?.required, false),
    maxValue: or(p?.maxValue, ""), minValue: or(p?.minValue, ""), maxLength: or(p?.maxLength, ""), minLength: or(p?.minLength, ""), displayScale: or(p?.displayScale, ""),
    condInfos: [], condDesc: "", message: ""
  };
}

/** 項目でない行（要素 ID・ボタン） */
function plainRow(id: string, ptcode: string | null, rowType: string, type: string, type2: string, code: string, label: string): FvRow {
  return {
    id, ptcode, state: false, row_type: rowType, type, type2, lookup: false,
    fieldlabel: label, fieldcode: code, constrain: "",
    formulaSet: "", disabledSet: "", hideSet: "", init: false,
    defaultValue: "", check: false, required: false, maxValue: "", minValue: "", maxLength: "", minLength: "", displayScale: "",
    condInfos: [], condDesc: "", message: ""
  };
}

/** レイアウトの順に行を作る */
export function fvRowsOf(pp: Record<string, FvProp>, layout: readonly FvLayoutRow[]): FvRow[] {
  const rows: FvRow[] = [];
  const nextId = (): string => String(rows.length + 1);
  const labelOf = (code: string): string => (pp[code] ? pp[code].label || "" : code);
  const element = (f: LayoutField): boolean => !!f.type && FV_ELEMENT_TYPES.includes(f.type) && !!f.elementId;
  for (const block of layout) {
    const rowType = block.code ? block.code : (block.type ?? "");
    let table: FvRow | undefined;
    if (block.code && pp[block.code] && isTarget(block.type)) {
      const own = fieldRow(nextId(), null, rowType, block.type ?? "", block.code, pp[block.code].label || "", pp[block.code]);
      // テーブル・グループの行だけ、使われていない重複検査の列を持つ（保存値の形を変えない）
      own.dupInfos = [];
      own.dupDesc = "";
      rows.push(own);
      if (block.type === "SUBTABLE") { own.tblfields = []; table = own; }
    }
    if (block.fields) {
      // ROW は ptcode ""、SUBTABLE はテーブルのコード
      const ptcode = block.code ?? "";
      const children: FvTblChild[] = [];
      for (const f of block.fields) {
        if (f.code) {
          if (isTarget(f.type)) rows.push(fieldRow(nextId(), ptcode, rowType, f.type ?? "", f.code, labelOf(f.code), pp[f.code]));
          children.push({ id: String(children.length + 1), state: false, fieldcode: f.code, fieldlabel: labelOf(f.code), type: f.type ?? "", hideSet: "" });
        } else if (element(f)) {
          rows.push(plainRow(nextId(), ptcode, rowType, f.type as string, f.type as string, `(${f.elementId})`, f.elementId as string));
        }
      }
      if (table) table.tblfields = children;
      if (ptcode) {
        rows.push(plainRow(nextId(), ptcode, rowType, FV_BUTTON_TYPE, "$ADD_BUTTON", `${ptcode}($ADD)`, "($ADD)"));
        rows.push(plainRow(nextId(), ptcode, rowType, FV_BUTTON_TYPE, "$DEL_BUTTON", `${ptcode}($DEL)`, "($DEL)"));
      }
    } else if (block.layout) {
      for (const f of block.layout.flatMap((g) => g.fields ?? [])) {
        if (f.code) {
          if (isTarget(f.type)) rows.push(fieldRow(nextId(), null, rowType, f.type ?? "", f.code, labelOf(f.code), pp[f.code]));
        } else if (element(f)) {
          rows.push(plainRow(nextId(), null, rowType, f.type as string, f.type as string, `(${f.elementId})`, f.elementId as string));
        }
      }
    }
  }
  return rows;
}

export interface FvApplyResult {
  /** 元の値にあってアプリに無い行（項目コード・要素 ID を変えた・消した） */
  missing: string[];
  /** テーブルにもう無い子（"テーブル.子"） */
  missingChildren: string[];
  /** 元の値に 2 回以上ある fieldcode（後のものが勝つ。normalize は誤りにする） */
  duplicates: string[];
}

/**
 * 元の値を行に写す（fieldcode で突き合わせ）。フォームで必須の項目の必須条件は "1" のまま。
 * raw は保存値の pluginInfos（pull したとき）。設定画面に無い列（check / dupInfos / dupDesc）をそこから写す
 */
export function fvApplySource(rows: FvRow[], source: FvSource, raw?: ReadonlyArray<Record<string, unknown>>): FvApplyResult {
  const byCode = new Map<string, FvSourceInfo>();
  const duplicates = new Set<string>();
  for (const info of source.pluginInfos) {
    if (byCode.has(info.fieldcode)) duplicates.add(info.fieldcode);
    byCode.set(info.fieldcode, info);
  }
  const rawByCode = new Map((raw ?? []).filter((r) => r && typeof r.fieldcode === "string").map((r) => [r.fieldcode as string, r]));
  const used = new Set<string>();
  const missingChildren: string[] = [];
  for (const row of rows) {
    const info = byCode.get(row.fieldcode);
    if (!info) continue;
    used.add(row.fieldcode);
    row.state = info.state;
    row.formulaSet = row.required ? "1" : info.formulaSet;
    row.disabledSet = info.disabledSet;
    row.hideSet = info.hideSet;
    row.init = info.init;
    row.condInfos = info.condInfos.map((c) => ({ state: c.state, condSet: c.condSet, jaSet: c.jaSet, enSet: c.enSet, zhSet: c.zhSet }));
    if (row.tblfields) {
      const want = new Map((info.tblfields ?? []).map((t) => [t.fieldcode, t]));
      for (const child of row.tblfields) {
        const t = want.get(child.fieldcode);
        child.state = t ? t.state : false;
        child.hideSet = t ? t.hideSet : "";
        want.delete(child.fieldcode);
      }
      for (const code of want.keys()) missingChildren.push(`${row.fieldcode}.${code}`);
    }
    const on = row.tblfields ? row.tblfields.some((t) => t.state) : row.condInfos.some((c) => c.state);
    row.condDesc = on ? "Y" : "";
    const r = rawByCode.get(row.fieldcode);
    if (r) {
      row.check = r.check || false;
      if (r.dupInfos) row.dupInfos = r.dupInfos;
      if (r.dupDesc) row.dupDesc = r.dupDesc;
    }
  }
  return { missing: [...byCode.keys()].filter((c) => !used.has(c)), missingChildren, duplicates: [...duplicates] };
}

/** 行に設定があるか（保存値の pluginInfos に入れる行） */
export function fvHasSetting(row: FvRow): boolean {
  if (row.state || row.formulaSet || row.disabledSet || row.hideSet || row.init) return true;
  if (row.condInfos.some((c) => c.state || c.condSet || c.jaSet || c.enSet || c.zhSet)) return true;
  return (row.tblfields ?? []).some((t) => t.state || t.hideSet);
}
