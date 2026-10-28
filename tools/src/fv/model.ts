/**
 * 項目検証の設定の形（元の値・行・保存値）と、元の値の既定値。
 * 元の値（FvSource）は設定画面のダウンロード・取り込みと同じ。保存値（FvSaved）は kintone に保存する形で、内部番号（fieldno / ptno）は設定画面が保存のときに付けるので tools は空にする。
 */

/** 行にする項目の型 */
export const FV_TARGET_TYPES: readonly string[] = [
  "GROUP", "SUBTABLE", "CALC", "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "RICH_TEXT", "NUMBER", "DATE", "DATETIME", "TIME",
  "DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "LINK", "FILE", "REFERENCE_TABLE"
];
/** 要素 ID で行にするもの（項目ではない） */
export const FV_ELEMENT_TYPES: readonly string[] = ["SPACER", "LABEL", "HR"];
/** テーブルの行の追加・削除ボタンの行 */
export const FV_BUTTON_TYPE = "$BUTTON";

/** 列ごとに置けない型（設定画面の編集できるセルと同じ）。非表示はどの行にも置ける */
const NO_REQUIRED = ["GROUP", "SUBTABLE", "CALC", "REFERENCE_TABLE", ...FV_ELEMENT_TYPES, FV_BUTTON_TYPE];
export const FV_COLUMN_DENY: Readonly<Record<"formulaSet" | "disabledSet" | "init" | "condInfos" | "tblfields", readonly string[]>> = {
  formulaSet: NO_REQUIRED,
  disabledSet: NO_REQUIRED,
  init: [...NO_REQUIRED, "FILE"],
  condInfos: ["GROUP", "SUBTABLE", "CALC", "FILE", "REFERENCE_TABLE", ...FV_ELEMENT_TYPES, FV_BUTTON_TYPE],
  /** テーブル内非表示はテーブルの行だけ */
  tblfields: FV_TARGET_TYPES.filter((t) => t !== "SUBTABLE")
};

export interface FvSourceCond { state: boolean; condSet: string; jaSet: string; enSet: string; zhSet: string }
export interface FvSourceTbl { fieldcode: string; state: boolean; hideSet: string }
export interface FvSourceInfo {
  fieldcode: string;
  state: boolean;
  formulaSet: string;
  disabledSet: string;
  hideSet: string;
  init: boolean;
  condInfos: FvSourceCond[];
  tblfields?: FvSourceTbl[];
}
export interface FvBorder { state: boolean; btype: string; width: number; color: string }
export interface FvSource {
  pluginEnable: boolean;
  pluginPreHide: boolean;
  pluginProductEnv: boolean;
  pluginComment: string;
  pluginDescription: string;
  pluginBorderInfo: { borderList?: FvBorder[] };
  pluginInfos: FvSourceInfo[];
}

/** 元の値のキー（封筒の外側を除く）と、保存のときに作る派生のキー */
export const FV_SOURCE_KEYS = ["pluginEnable", "pluginPreHide", "pluginProductEnv", "pluginComment", "pluginDescription", "pluginBorderInfo", "pluginInfos"] as const;
export const FV_DERIVED_KEYS = ["pluginFields", "pluginPP", "pluginRecNo", "pluginStatus", "pluginStatusCode", "pluginStatusAssignee", "pluginHideCheck", "pluginUOG"] as const;

/** 枠線の 3 行の既定（区分の順: 必須で未入力・必須で入力済み・エラー） */
export const FV_BORDER_DEFAULTS: ReadonlyArray<{ width: number; color: string }> = [
  { width: 5, color: "#ff8000" },
  { width: 5, color: "#7bd6af" },
  { width: 5, color: "#e74c3c" }
];

const text = (v: unknown): string => (v == null ? "" : String(v));
const flag = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "1";

/** 色は #rrggbb（#rgb と # の無い形は広げて小文字に）。それ以外は null */
function color(s: string): string | null {
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  const t = s.trim();
  const short = /^#?([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(t);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  const long = /^#?([0-9a-fA-F]{6})$/.exec(t);
  return long ? `#${long[1].toLowerCase()}` : null;
}

/** 枠線: 一覧があれば 3 行までにし、幅（0〜8 の整数）と色が合わなければその行の既定 */
export function fvBorderOf(raw: unknown): { borderList?: FvBorder[] } {
  const list = raw && typeof raw === "object" ? (raw as { borderList?: unknown }).borderList : undefined;
  if (!Array.isArray(list)) return {};
  return {
    borderList: list.slice(0, FV_BORDER_DEFAULTS.length).map((x, i) => {
      const o = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
      const width = Number(o.width);
      return {
        state: flag(o.state),
        btype: text(o.btype),
        width: Number.isInteger(width) && width >= 0 && width <= 8 ? width : FV_BORDER_DEFAULTS[i].width,
        color: color(text(o.color)) ?? FV_BORDER_DEFAULTS[i].color
      };
    })
  };
}

/**
 * 元の値の既定値を補う。設定画面のダウンロード・保存値のどちらからでも元の値だけを取り出す（派生値・外枠・画面のキーは捨てる）。
 * 有効は書いていなければ真。旧い形のキー（formula / disabled / hide、検証条件の cond / ja / en / zh）も読む
 */
export function fvSourceOf(raw: unknown): FvSource {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const infos = Array.isArray(data.pluginInfos) ? (data.pluginInfos as unknown[]) : [];
  return {
    pluginEnable: "pluginEnable" in data ? flag(data.pluginEnable) : true,
    pluginPreHide: flag(data.pluginPreHide),
    pluginProductEnv: flag(data.pluginProductEnv),
    pluginComment: text(data.pluginComment),
    pluginDescription: text(data.pluginDescription),
    pluginBorderInfo: fvBorderOf(data.pluginBorderInfo),
    pluginInfos: infos.flatMap((x): FvSourceInfo[] => {
      if (!x || typeof x !== "object" || typeof (x as Record<string, unknown>).fieldcode !== "string") return [];
      const i = x as Record<string, unknown>;
      const conds = Array.isArray(i.condInfos) ? (i.condInfos as unknown[]) : [];
      const info: FvSourceInfo = {
        fieldcode: i.fieldcode as string,
        state: flag(i.state),
        formulaSet: text(i.formulaSet) || text(i.formula),
        disabledSet: text(i.disabledSet) || text(i.disabled),
        hideSet: text(i.hideSet) || text(i.hide),
        init: flag(i.init),
        condInfos: conds.flatMap((c) => {
          if (!c || typeof c !== "object") return [];
          const o = c as Record<string, unknown>;
          return [{ state: flag(o.state), condSet: text(o.condSet ?? o.cond), jaSet: text(o.jaSet ?? o.ja), enSet: text(o.enSet ?? o.en), zhSet: text(o.zhSet ?? o.zh) }];
        })
      };
      if (Array.isArray(i.tblfields)) {
        info.tblfields = (i.tblfields as unknown[]).flatMap((t) => {
          if (!t || typeof t !== "object" || typeof (t as Record<string, unknown>).fieldcode !== "string") return [];
          const o = t as Record<string, unknown>;
          return [{ fieldcode: o.fieldcode as string, state: flag(o.state), hideSet: text(o.hideSet) }];
        });
      }
      return [info];
    })
  };
}
