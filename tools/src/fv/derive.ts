/**
 * 項目検証の式の検査と派生値、保存値（内部番号なし）。式は計算式の engine.checker で評価する（項目検証の設定画面の検査と同じ作り）。
 * 派生値: 各列の式が読む項目（usedFields / usedFieldsDisabled / usedFieldsHide / usedFieldsCond / usedFieldsTable）、検証条件の cond / ja / en / zh、
 * テーブル内非表示の hide、「検証」の印 condDesc。保存値: pluginInfos（設定のある行）、pluginFields（「使う」がオンの行）、pluginPP、フラグ。
 * 呼ぶ前に、全部の式を走査して更新系の関数が無いことを確かめておく（ここで初めて式を評価する）
 */
import type { Engine } from "../engine.ts";
import type { FvSource } from "./model.ts";
import { fvHasSetting, type FvProp, type FvRow, type FvRowCond, type FvTblChild } from "./rows.ts";

const ENTITIES: ReadonlyArray<[string, string]> = [["&lt;", "<"], ["&gt;", ">"], ["&quot;", '"'], ["&#039;", "'"], ["&#044;", ","], ["&amp;", "&"], ["&nbsp;", " "]];

/** 保存で式から消えるもの: 実体参照を戻し、// から行末と改行を除く（文字列定数の中の // と改行も消える。項目検証の保存の規則） */
export function fvStrip(value: unknown): string {
  if (value === "" || value == null) return "";
  let s = String(value);
  for (const [from, to] of ENTITIES) s = s.split(from).join(to);
  return s.replace(/\/\/.*\n/g, "").replace(/\/\/.*$/g, "").replace(/\n/g, "");
}

export type FvColumn = "formulaSet" | "disabledSet" | "hideSet" | "condInfos" | "tblfields";

export interface FvFormulaError {
  fieldcode: string;
  column: FvColumn;
  /** 検証条件・テーブル内非表示の何行目か（0 から） */
  index?: number;
  /** 検証条件の列（condSet / jaSet / enSet / zhSet）か、テーブル内非表示の子の項目コード */
  part?: string;
  message: string;
  /** 行の「使う」がオンか（オフの行の誤りは設定画面では止まらない） */
  on: boolean;
}

type Used = Record<string, number>;
const merge = (target: Used, ...more: Array<Used | undefined>): Used => Object.assign(target, ...more.filter(Boolean));

export interface FvDeriveContext {
  engine: Engine;
  pp: Record<string, FvProp>;
  crec: Record<string, unknown>;
}

/** 1 つの式を検査器で評価し、読む項目を返す。空は誤りなし。context はテーブルの文脈（行の項目コード。テーブル内非表示はテーブル） */
function evaluate(ctx: FvDeriveContext, context: string, raw: unknown): { ok: true; used: Used } | { ok: false; message: string } {
  const value = fvStrip(raw);
  if (!value) return { ok: true, used: {} };
  try {
    const kf = ctx.engine.checker(ctx.pp, ctx.crec);
    kf.usedFields({});
    kf.initTableInfo(context);
    kf.dq(value);
    return { ok: true, used: { ...(kf.usedFields() as Used) } };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const REQUIRED_TEXT = "空にできない（「使う」がオンの検証条件は条件とメッセージ（日）、テーブル内非表示は式が要る）";

/** 行ごとに式を検査し、派生値を行に書く。誤りは全部返す */
export function fvDerive(ctx: FvDeriveContext, rows: FvRow[]): FvFormulaError[] {
  const errors: FvFormulaError[] = [];
  for (const row of rows) {
    const on = row.state;
    const fail = (e: Omit<FvFormulaError, "fieldcode" | "on">): void => { errors.push({ fieldcode: row.fieldcode, on, ...e }); };
    for (const [column, key] of [["formulaSet", "usedFields"], ["disabledSet", "usedFieldsDisabled"], ["hideSet", "usedFieldsHide"]] as const) {
      if (!on) { row[key] = {}; continue; }
      const r = evaluate(ctx, row.fieldcode, row[column]);
      row[key] = r.ok ? r.used : {};
      if (!r.ok) fail({ column, message: r.message });
    }
    row.condInfos = row.condInfos.map((c, index): FvRowCond => {
      let used: Used = {};
      if (c.state) {
        for (const part of ["condSet", "jaSet", "enSet", "zhSet"] as const) {
          if (!fvStrip(c[part])) {
            if (part === "condSet" || part === "jaSet") { fail({ column: "condInfos", index, part, message: REQUIRED_TEXT }); used = {}; break; }
            continue;
          }
          const r = evaluate(ctx, row.fieldcode, c[part]);
          if (!r.ok) { fail({ column: "condInfos", index, part, message: r.message }); used = {}; break; }
          if (part === "condSet") used = r.used;
        }
      }
      const ja = fvStrip(c.jaSet);
      return { state: c.state, condSet: c.condSet, jaSet: c.jaSet, enSet: c.enSet, zhSet: c.zhSet, usedFields: used, cond: fvStrip(c.condSet), ja, en: fvStrip(c.enSet) || ja, zh: fvStrip(c.zhSet) || ja };
    });
    if (row.tblfields) {
      const table: Used = {};
      row.tblfields = row.tblfields.map((t, index): FvTblChild => {
        let used: Used = {};
        if (t.state) {
          if (!fvStrip(t.hideSet)) fail({ column: "tblfields", index, part: t.fieldcode, message: REQUIRED_TEXT });
          else {
            const r = evaluate(ctx, row.fieldcode, t.hideSet);
            if (r.ok) used = r.used;
            else fail({ column: "tblfields", index, part: t.fieldcode, message: r.message });
          }
        }
        merge(table, used);
        return { id: t.id, state: t.state, fieldcode: t.fieldcode, fieldlabel: t.fieldlabel, type: t.type, hideSet: t.hideSet, usedFields: used, hide: fvStrip(t.hideSet) };
      });
      row.usedFieldsTable = table;
      row.condDesc = row.tblfields.some((t) => t.state) ? "Y" : "";
      row.usedFieldsCond = on && row.condDesc ? merge({}, ...row.tblfields.filter((t) => t.state).map((t) => t.usedFields as Used)) : {};
    } else {
      row.condDesc = row.condInfos.some((c) => c.state) ? "Y" : "";
      row.usedFieldsCond = on && row.condDesc ? merge({}, ...row.condInfos.filter((c) => c.state).map((c) => c.usedFields as Used)) : {};
    }
  }
  return errors;
}

/** 保存値の pluginInfos[] に入れる行のキー（設定画面の主グリッドの列。無いキーは入れない） */
export const FV_INFO_KEYS = [
  "id", "row_type", "type2", "fieldlabel", "fieldcode", "constrain", "state", "formulaSet", "disabledSet", "hideSet", "init", "condDesc",
  "ptcode", "usedFields", "usedFieldsDisabled", "usedFieldsHide", "condInfos", "dupInfos", "usedFieldsCond", "usedFieldsDuplicate", "usedFieldsTable", "tblfields", "type", "lookup"
] as const;

/** ユーザー情報を使う印（式が UINFO 系を使うと usedFields に入る） */
const USERS_MARK = "$UGO$";
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const USED_KEYS = ["usedFields", "usedFieldsDisabled", "usedFieldsHide", "usedFieldsCond", "usedFieldsTable"] as const;

/**
 * 保存値（内部番号は空。設定画面が保存のときに付ける）。fvDerive の後に呼ぶ。
 * pluginFields は「使う」がオンの行の全部のキー + 保存の形の式（formula / disabled / hide）で、usedFields は 5 つの和（ユーザー情報の印は除く）
 */
export function fvBuildSaved(rows: readonly FvRow[], pp: Record<string, FvProp>, source: FvSource): Record<string, unknown> {
  const pluginFields: Record<string, unknown>[] = [];
  let usesUsers = false;
  let hides = false;
  for (const row of rows) {
    if (!row.state) continue;
    const f = copy(row) as FvRow & Record<string, unknown>;
    for (const key of USED_KEYS) {
      const u = f[key] as Used | undefined;
      if (u && Object.prototype.hasOwnProperty.call(u, USERS_MARK)) usesUsers = true;
      if (u) delete u[USERS_MARK];
    }
    for (const c of f.condInfos) if (c.usedFields) delete (c.usedFields as Used)[USERS_MARK];
    f.formula = fvStrip(row.formulaSet);
    f.disabled = fvStrip(row.disabledSet);
    f.hide = fvStrip(row.hideSet);
    hides ||= !!f.hide;
    f.ptno = "";
    f.fieldno = "";
    for (const t of f.tblfields ?? []) if (t.state) t.fieldno = "";
    f.usedFields = merge((f.usedFields as Used | undefined) ?? {}, f.usedFieldsDisabled as Used, f.usedFieldsHide as Used, f.usedFieldsCond as Used, f.usedFieldsTable as Used);
    pluginFields.push(f);
  }
  const pluginInfos = rows.filter(fvHasSetting).map((r) => {
    const out: Record<string, unknown> = {};
    for (const key of FV_INFO_KEYS) if (r[key] !== undefined) out[key] = copy(r[key]);
    return out;
  });
  const pluginPP: Record<string, Record<string, unknown>> = {};
  for (const [code, p] of Object.entries(pp)) {
    const e: Record<string, unknown> = { fieldcode: code, type: p.type };
    if (p.ptcode !== undefined) e.ptcode = p.ptcode;
    if (p.lookup) e.lookup = true;
    pluginPP[code] = e;
  }
  return {
    pluginEnable: source.pluginEnable,
    pluginPreHide: source.pluginPreHide,
    pluginProductEnv: source.pluginProductEnv,
    pluginComment: source.pluginComment,
    pluginDescription: source.pluginDescription,
    pluginInfos,
    pluginFields,
    pluginPP,
    pluginRecNo: false,
    pluginStatus: false,
    pluginStatusCode: "",
    pluginStatusAssignee: "",
    pluginHideCheck: hides,
    pluginUOG: usesUsers,
    pluginBorderInfo: copy(source.pluginBorderInfo)
  };
}
