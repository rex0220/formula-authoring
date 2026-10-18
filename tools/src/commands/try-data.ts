/**
 * try の架空の項目と値（計画 25.3。2026-10-18 Takashi「案 1〜3、公開の前、標本に足すだけ」）:
 *   - 案 2: 標本（または利用者のアプリの項目定義）に項目を足す（TryFieldDef → properties と layout。コードは既存と重複不可。選択肢の型は options 必須。独立のアプリは作らない）
 *   - 案 1: 簡略形の値（{ 数値1: 100, 日付1: "2026-03-31", テーブル1: [{ T1_数値: 10 }] }）を kintone の REST の形（{ type, value }）に直す（型ごとに検査。誤りは名指し）
 *   - 案 3: 利用者のアプリの項目定義（fields.json）に架空の値（簡略形）で。空のレコードを合成して値を入れる
 * 値は AI が作る架空のもの（手順に「実在の個人情報は入れない」）。応答に出る（calc と同じ）
 */
import { InputError } from "../input.ts";
import type { FieldProperty, FieldsFile, LayoutRow } from "./fields.ts";
import type { KintoneRecord } from "./record.ts";
import type { UsersInfoTable } from "../users/index.ts";

export interface TryFieldDef {
  code: string;
  /** 型（NUMBER / TEXT / DATE … の別名も可）。SUBTABLE は fields に子 */
  type: string;
  label?: string;
  /** 選択肢（DROP_DOWN / RADIO_BUTTON / CHECK_BOX / MULTI_SELECT で必須。ほかの型には付けない） */
  options?: string[];
  /** 既存のテーブル（標本のテーブル1 / テーブル2 か、この一覧で先に足したテーブル）の子として足すときのテーブルのコード */
  table?: string;
  /** SUBTABLE の子（1 つ以上。子に table / fields は書けない） */
  fields?: TryFieldDef[];
}

/** 架空の値のレコード（簡略形。項目コード → 値。テーブルは行（子のコード → 値）の配列） */
export type TryData = Record<string, unknown>;

export const TRY_MAX_EXTRA_FIELDS = 20;
export const TRY_MAX_DATA = 5;
export const TRY_MAX_TABLE_ROWS = 20;
export const TRY_MAX_OPTIONS = 50;
/** 文字列の値の上限（文字） */
export const TRY_MAX_VALUE_CHARS = 2000;

/** 型の別名（大文字小文字は区別しない）。GROUP はグループ枠なので別名にしない */
export const TYPE_ALIASES: Record<string, string> = {
  TEXT: "SINGLE_LINE_TEXT", STRING: "SINGLE_LINE_TEXT", TEXTAREA: "MULTI_LINE_TEXT", MULTILINE: "MULTI_LINE_TEXT", RICH: "RICH_TEXT",
  NUM: "NUMBER", DROPDOWN: "DROP_DOWN", RADIO: "RADIO_BUTTON", CHECKBOX: "CHECK_BOX", MULTISELECT: "MULTI_SELECT",
  USER: "USER_SELECT", ORG: "ORGANIZATION_SELECT", ORGANIZATION: "ORGANIZATION_SELECT", URL: "LINK", TABLE: "SUBTABLE"
};

/** 足せる型（テーブルの子にできるのは SUBTABLE 以外） */
export const EXTRA_TYPES: readonly string[] = [
  "SINGLE_LINE_TEXT", "MULTI_LINE_TEXT", "RICH_TEXT", "NUMBER", "DATE", "DATETIME", "TIME", "DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT",
  "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "LINK", "SUBTABLE"
];
const CHOICE_TYPES = new Set(["DROP_DOWN", "RADIO_BUTTON", "CHECK_BOX", "MULTI_SELECT"]);
/** kintone のフィールドコード（文字・数字・_ ･ ＄ ￥。数字で始まらない。128 文字まで） */
const CODE_RE = /^[\p{L}_･＄￥][\p{L}\p{N}_･＄￥]{0,127}$/u;

export function canonicalType(type: string): string {
  const upper = String(type).trim().toUpperCase();
  return TYPE_ALIASES[upper] ?? upper;
}

function propertyOf(code: string, type: string, label: string, options: string[] | undefined): FieldProperty {
  const base = { type, code, label, noLabel: false, required: false };
  const opts = options ? { options: Object.fromEntries(options.map((o, i) => [o, { label: o, index: String(i) }])) } : {};
  switch (type) {
    case "NUMBER": return { ...base, minValue: "", maxValue: "", digit: false, unique: false, defaultValue: "", displayScale: "", unit: "", unitPosition: "BEFORE" };
    case "SINGLE_LINE_TEXT": return { ...base, minLength: "", maxLength: "", expression: "", hideExpression: false, unique: false, defaultValue: "" };
    case "LINK": return { ...base, protocol: "WEB", minLength: "", maxLength: "", unique: false, defaultValue: "" };
    case "MULTI_LINE_TEXT": case "RICH_TEXT": return { ...base, defaultValue: "" };
    case "DATE": case "DATETIME": return { ...base, unique: false, defaultValue: "", defaultNowValue: false };
    case "TIME": return { ...base, defaultValue: "", defaultNowValue: false };
    case "DROP_DOWN": return { ...base, ...opts, defaultValue: "" };
    case "RADIO_BUTTON": return { ...base, ...opts, defaultValue: options?.[0] ?? "", align: "HORIZONTAL" };
    case "CHECK_BOX": case "MULTI_SELECT": return { ...base, ...opts, defaultValue: [], align: "HORIZONTAL" };
    case "USER_SELECT": case "ORGANIZATION_SELECT": case "GROUP_SELECT": return { ...base, entities: [], defaultValue: [] };
    case "SUBTABLE": return { type, code, label, noLabel: false, fields: {} };
    default: throw new InputError(`項目 ${code} の型 ${type} は足せない（${EXTRA_TYPES.join(", ")}）`);
  }
}

/** レイアウトの中のテーブルの入れ物（グループ枠の中も探す） */
function layoutTableOf(layout: LayoutRow[], code: string): LayoutRow | undefined {
  for (const row of layout) {
    if (row.type === "SUBTABLE" && row.code === code) return row;
    if (row.type === "GROUP" && Array.isArray(row.layout)) {
      const hit = layoutTableOf(row.layout, code);
      if (hit) return hit;
    }
  }
  return undefined;
}

const sizeOf = (type: string): Record<string, string> => (type === "MULTI_LINE_TEXT" || type === "RICH_TEXT" ? { width: "250", innerHeight: "125" } : { width: "200" });

/** 既存のコード（テーブルの外と子。kintone ではアプリの中で一意） */
export function allCodesOf(fields: FieldsFile): Set<string> {
  const codes = new Set<string>();
  for (const p of Object.values(fields.properties)) {
    codes.add(p.code);
    for (const c of Object.values(p.fields ?? {})) codes.add(c.code);
  }
  return codes;
}

function checkOptions(def: TryFieldDef, type: string, where: string): string[] | undefined {
  if (!CHOICE_TYPES.has(type)) {
    if (def.options !== undefined) throw new InputError(`${where}: ${type} に options は付けない`);
    return undefined;
  }
  if (!Array.isArray(def.options) || !def.options.length) throw new InputError(`${where}: ${type} には options（選択肢の配列）が要る`);
  if (def.options.length > TRY_MAX_OPTIONS) throw new InputError(`${where}: options は ${TRY_MAX_OPTIONS} 個まで`);
  const seen = new Set<string>();
  for (const o of def.options) {
    if (typeof o !== "string" || !o.trim() || [...o].length > 100) throw new InputError(`${where}: options は空でない文字列（100 文字まで）: ${JSON.stringify(o)}`);
    if (seen.has(o)) throw new InputError(`${where}: options が重複: ${o}`);
    seen.add(o);
  }
  return def.options;
}

/**
 * 項目を足す（写しを返す）。戻りの added は「単価（NUMBER）」「分類（DROP_DOWN: 明細 / 小計）」「明細（SUBTABLE: 商品, 数量）」の形
 */
export function extendFields(fields: FieldsFile, defs: readonly TryFieldDef[]): { fields: FieldsFile; added: string[] } {
  const out = structuredClone(fields);
  const codes = allCodesOf(out);
  const added: string[] = [];
  let count = 0;
  const describe = (type: string, options: string[] | undefined, children?: string[]): string =>
    `${type}${options ? `: ${options.join(" / ")}` : ""}${children ? `: ${children.join(", ")}` : ""}`;
  const takeCode = (def: TryFieldDef, where: string): string => {
    if (typeof def.code !== "string" || !CODE_RE.test(def.code)) throw new InputError(`${where}: code はフィールドコード（文字・数字・_ で、数字で始まらない。128 文字まで）: ${JSON.stringify(def.code)}`);
    if (codes.has(def.code)) throw new InputError(`${where}: ${def.code} は既にある項目（標本の項目と重ならないコードにする）`);
    if (++count > TRY_MAX_EXTRA_FIELDS) throw new InputError(`足す項目は ${TRY_MAX_EXTRA_FIELDS} 個まで（テーブルの子も数える）`);
    codes.add(def.code);
    return def.code;
  };
  const labelOf = (def: TryFieldDef, where: string): string => {
    if (def.label !== undefined && (typeof def.label !== "string" || [...def.label].length > 128)) throw new InputError(`${where}: label は 128 文字まで`);
    return def.label ?? def.code;
  };
  defs.forEach((def, i) => {
    const where = `fields[${i}]`;
    if (!def || typeof def !== "object") throw new InputError(`${where}: 項目はオブジェクト（{ code, type, options?, table?, fields? }）`);
    const type = canonicalType(def.type ?? "");
    if (!EXTRA_TYPES.includes(type)) throw new InputError(`${where}: 型 ${JSON.stringify(def.type)} は足せない（${EXTRA_TYPES.join(", ")}）`);
    if (def.table !== undefined && type === "SUBTABLE") throw new InputError(`${where}: テーブルの中にテーブルは置けない（table と type SUBTABLE は一緒に書かない）`);
    if (def.fields !== undefined && type !== "SUBTABLE") throw new InputError(`${where}: fields（子）は type SUBTABLE のときだけ`);
    const code = takeCode(def, where);
    const label = labelOf(def, where);
    const options = checkOptions(def, type, where);
    if (def.table !== undefined) {
      const parent = out.properties[def.table];
      if (!parent || parent.type !== "SUBTABLE") throw new InputError(`${where}: table ${JSON.stringify(def.table)} はテーブルでない（標本のテーブル1 / テーブル2 か、先に足したテーブル）`);
      parent.fields ??= {};
      parent.fields[code] = propertyOf(code, type, label, options);
      const slot = layoutTableOf(out.layout, def.table);
      if (!slot) throw new InputError(`${where}: テーブル ${def.table} がレイアウトに無い`);
      slot.fields ??= [];
      slot.fields.push({ type, code, size: sizeOf(type) });
      added.push(`${code}（${describe(type, options)}。${def.table} の子）`);
      return;
    }
    if (type === "SUBTABLE") {
      if (!Array.isArray(def.fields) || !def.fields.length) throw new InputError(`${where}: SUBTABLE には fields（子の配列。1 つ以上）が要る`);
      const table = propertyOf(code, type, label, undefined);
      const slot: LayoutRow = { type: "SUBTABLE", code, fields: [] };
      const names: string[] = [];
      def.fields.forEach((child, j) => {
        const cw = `${where}.fields[${j}]`;
        if (!child || typeof child !== "object") throw new InputError(`${cw}: 子はオブジェクト（{ code, type, options? }）`);
        const ct = canonicalType(child.type ?? "");
        if (!EXTRA_TYPES.includes(ct) || ct === "SUBTABLE") throw new InputError(`${cw}: 型 ${JSON.stringify(child.type)} はテーブルの子にできない`);
        if (child.table !== undefined || child.fields !== undefined) throw new InputError(`${cw}: 子に table / fields は書けない`);
        const cc = takeCode(child, cw);
        table.fields![cc] = propertyOf(cc, ct, labelOf(child, cw), checkOptions(child, ct, cw));
        slot.fields!.push({ type: ct, code: cc, size: sizeOf(ct) });
        names.push(cc);
      });
      out.properties[code] = table;
      out.layout.push(slot);
      added.push(`${code}（${describe(type, undefined, names)}）`);
      return;
    }
    out.properties[code] = propertyOf(code, type, label, options);
    out.layout.push({ type: "ROW", fields: [{ type, code, size: sizeOf(type) }] });
    added.push(`${code}（${describe(type, options)}）`);
  });
  return { fields: out, added };
}

/**
 * 項目定義の既定値を補う（写しを返す）: 配列の型（チェック、複数選択、ユーザー・組織・グループ）の defaultValue が配列でなければ []、ほかの入力の型は ""。
 * 設定画面の検証用レコード（authoring API の createCheckRecord）は defaultValue から作るので、手で書いた・古い fields.json に無いと検証が壊れる（e.value.join is not a function）
 */
export function normalizeDefaults(fields: FieldsFile): FieldsFile {
  const out = structuredClone(fields);
  const fix = (p: FieldProperty): void => {
    if (p.type === "SUBTABLE") {
      for (const c of Object.values(p.fields ?? {})) fix(c);
      return;
    }
    if (NO_VALUE_TYPES.has(p.type) || p.type === "CALC" || /^(RECORD_NUMBER|CREATOR|MODIFIER|CREATED_TIME|UPDATED_TIME|STATUS|STATUS_ASSIGNEE|CATEGORY|FILE)$/.test(p.type)) return;
    const arrayType = /^(CHECK_BOX|MULTI_SELECT|USER_SELECT|ORGANIZATION_SELECT|GROUP_SELECT)$/.test(p.type);
    if (arrayType) {
      if (!Array.isArray(p.defaultValue)) p.defaultValue = [];
    } else if (p.defaultValue === undefined || p.defaultValue === null) p.defaultValue = "";
  };
  for (const p of Object.values(out.properties)) fix(p);
  return out;
}

/** 項目の型ごとの空の値 */
export function emptyValueOf(type: string): unknown {
  switch (type) {
    case "CHECK_BOX": case "MULTI_SELECT": case "USER_SELECT": case "ORGANIZATION_SELECT": case "GROUP_SELECT": case "FILE": case "STATUS_ASSIGNEE": case "CATEGORY": case "SUBTABLE":
      return [];
    case "CREATOR": case "MODIFIER":
      return { code: "", name: "" };
    default:
      return "";
  }
}

/** 値を持たない型（レコードに出ない） */
const NO_VALUE_TYPES = new Set(["GROUP", "REFERENCE_TABLE", "LABEL", "SPACER", "HR"]);

/** 空のレコードを合成する（$id / $revision、全項目を空に。作成日時などは固定） */
export function emptyRecordOf(fields: FieldsFile, id: string): KintoneRecord {
  const rec: KintoneRecord = { $id: { type: "__ID__", value: id }, $revision: { type: "__REVISION__", value: "1" } };
  for (const p of Object.values(fields.properties)) {
    if (NO_VALUE_TYPES.has(p.type)) continue;
    const value = p.type === "RECORD_NUMBER" ? id : p.type === "CREATED_TIME" || p.type === "UPDATED_TIME" ? "2026-01-15T00:00:00Z" : emptyValueOf(p.type);
    rec[p.code] = { type: p.type, value };
  }
  return rec;
}

/** 土台のレコードに無い項目（足した項目）を空で補う */
export function fillMissing(fields: FieldsFile, record: KintoneRecord): KintoneRecord {
  const out = structuredClone(record);
  for (const p of Object.values(fields.properties)) {
    if (NO_VALUE_TYPES.has(p.type)) continue;
    if (!(p.code in out)) out[p.code] = { type: p.type, value: emptyValueOf(p.type) };
    if (p.type === "SUBTABLE") {
      const rows = out[p.code].value;
      if (Array.isArray(rows)) {
        for (const row of rows as Array<{ value?: Record<string, { type: string; value: unknown }> }>) {
          row.value ??= {};
          for (const c of Object.values(p.fields ?? {})) if (!(c.code in row.value)) row.value[c.code] = { type: c.type, value: emptyValueOf(c.type) };
        }
      }
    }
  }
  return out;
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/;

const isEmpty = (v: unknown): boolean => v === "" || v === null || v === undefined;

function text(v: unknown, where: string): string {
  if (isEmpty(v)) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    const s = String(v);
    if ([...s].length > TRY_MAX_VALUE_CHARS) throw new InputError(`${where}: 文字列は ${TRY_MAX_VALUE_CHARS} 文字まで`);
    return s;
  }
  throw new InputError(`${where}: 文字列を書く（${JSON.stringify(v).slice(0, 40)}）`);
}

function codeList(v: unknown, where: string, kind: "user" | "org" | "group" | "assignee", users: UsersInfoTable | null): Array<{ code: string; name: string }> {
  if (isEmpty(v)) return [];
  const list = Array.isArray(v) ? v : [v];
  const table = kind === "org" ? users?.orgCodes : kind === "group" ? users?.groupCodes : users?.userCodes;
  return list.map((e, i) => {
    const code = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string" ? (e as { code: string }).code : undefined;
    if (code === undefined || !code.trim() || [...code].length > 128) throw new InputError(`${where}[${i}]: コード（文字列）か { code, name? } を書く`);
    const given = e && typeof e === "object" ? (e as { name?: unknown }).name : undefined;
    const name = typeof given === "string" ? given : typeof table?.[code]?.name === "string" ? String(table[code].name) : code;
    return { code, name };
  });
}

function stringList(v: unknown, where: string, options: Record<string, unknown> | undefined): string[] {
  if (isEmpty(v)) return [];
  const list = Array.isArray(v) ? v : [v];
  return list.map((e, i) => {
    if (typeof e !== "string") throw new InputError(`${where}[${i}]: 文字列を書く`);
    if (options && !(e in options)) throw new InputError(`${where}[${i}]: 選択肢に無い値 ${JSON.stringify(e)}（${Object.keys(options).join(" / ")}）`);
    return e;
  });
}

/** 簡略形の値を kintone の形に（テーブル以外） */
export function convertValue(prop: FieldProperty, v: unknown, where: string, users: UsersInfoTable | null): unknown {
  const options = prop.options as Record<string, unknown> | undefined;
  switch (prop.type) {
    case "NUMBER": {
      if (isEmpty(v)) return "";
      if (typeof v === "number") {
        if (!Number.isFinite(v)) throw new InputError(`${where}: NUMBER は有限の数`);
        return String(v);
      }
      if (typeof v === "string" && NUMBER_RE.test(v.trim())) return v.trim();
      throw new InputError(`${where}: NUMBER は数か数字の文字列（${JSON.stringify(v).slice(0, 40)}）`);
    }
    case "SINGLE_LINE_TEXT": case "MULTI_LINE_TEXT": case "RICH_TEXT": case "LINK": case "CALC": case "STATUS": case "RECORD_NUMBER": case "__ID__": case "__REVISION__":
      return text(v, where);
    case "DATE": {
      const s = text(v, where);
      if (s && !DATE_RE.test(s)) throw new InputError(`${where}: DATE は "YYYY-MM-DD"（${JSON.stringify(s)}）`);
      return s;
    }
    case "TIME": {
      const s = text(v, where);
      if (s && !TIME_RE.test(s)) throw new InputError(`${where}: TIME は "HH:mm"（${JSON.stringify(s)}）`);
      return s;
    }
    case "DATETIME": case "CREATED_TIME": case "UPDATED_TIME": {
      const s = text(v, where);
      if (s && !DATETIME_RE.test(s)) throw new InputError(`${where}: ${prop.type} は "YYYY-MM-DDTHH:mm:ssZ"（${JSON.stringify(s)}）`);
      return s;
    }
    case "DROP_DOWN": case "RADIO_BUTTON": {
      const s = text(v, where);
      if (s && options && !(s in options)) throw new InputError(`${where}: 選択肢に無い値 ${JSON.stringify(s)}（${Object.keys(options).join(" / ")}）`);
      return s;
    }
    case "CHECK_BOX": case "MULTI_SELECT":
      return stringList(v, where, options);
    case "CATEGORY":
      return stringList(v, where, undefined);
    case "USER_SELECT": case "STATUS_ASSIGNEE": return codeList(v, where, "user", users);
    case "ORGANIZATION_SELECT": return codeList(v, where, "org", users);
    case "GROUP_SELECT": return codeList(v, where, "group", users);
    case "CREATOR": case "MODIFIER": {
      const one = codeList(v, where, "user", users);
      if (one.length !== 1) throw new InputError(`${where}: ${prop.type} はユーザーのコード 1 つ`);
      return one[0];
    }
    case "FILE": {
      if (isEmpty(v)) return [];
      const list = Array.isArray(v) ? v : [v];
      return list.map((e, i) => {
        const name = typeof e === "string" ? e : e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string" ? (e as { name: string }).name : undefined;
        if (name === undefined || !name.trim() || [...name].length > 255) throw new InputError(`${where}[${i}]: ファイルは名前（文字列）か { name, size? }`);
        const size = e && typeof e === "object" && (e as { size?: unknown }).size !== undefined ? String((e as { size: unknown }).size) : "0";
        return { contentType: "application/octet-stream", fileKey: "", name, size };
      });
    }
    case "SUBTABLE":
      throw new InputError(`${where}: テーブルは行の配列（[{ 子のコード: 値, … }]）`);
    default:
      if (NO_VALUE_TYPES.has(prop.type)) throw new InputError(`${where}: ${prop.type} は値を持たない`);
      throw new InputError(`${where}: 型 ${prop.type} の値は書けない`);
  }
}

/** 簡略形のレコードを土台に当てる（写しを返す。where は data[1] など） */
export function applyData(fields: FieldsFile, base: KintoneRecord, data: TryData, where: string, users: UsersInfoTable | null): KintoneRecord {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new InputError(`${where}: レコードはオブジェクト（{ 項目コード: 値, … }）`);
  const rec = fillMissing(fields, base);
  const children = new Map<string, string>();
  for (const p of Object.values(fields.properties)) for (const c of Object.values(p.fields ?? {})) children.set(c.code, p.code);
  for (const [code, v] of Object.entries(data)) {
    const w = `${where}.${code}`;
    const prop = fields.properties[code];
    if (!prop) {
      if (children.has(code)) throw new InputError(`${w}: テーブルの子はテーブルの行の中に書く（${children.get(code)}: [{ ${code}: … }]）`);
      throw new InputError(`${w}: 無い項目（標本に無ければ fields で足す。項目の一覧は describe）`);
    }
    if (NO_VALUE_TYPES.has(prop.type)) throw new InputError(`${w}: ${prop.type} は値を持たない`);
    if (prop.type === "SUBTABLE") {
      if (isEmpty(v)) { rec[code] = { type: "SUBTABLE", value: [] }; continue; }
      if (!Array.isArray(v)) throw new InputError(`${w}: テーブルは行の配列（[{ 子のコード: 値, … }]）`);
      if (v.length > TRY_MAX_TABLE_ROWS) throw new InputError(`${w}: テーブルの行は ${TRY_MAX_TABLE_ROWS} 行まで`);
      const kids = prop.fields ?? {};
      const rows = v.map((row, i) => {
        const rw = `${w}[${i}]`;
        if (!row || typeof row !== "object" || Array.isArray(row)) throw new InputError(`${rw}: 行はオブジェクト（{ 子のコード: 値, … }）`);
        const value: Record<string, { type: string; value: unknown }> = {};
        for (const c of Object.values(kids)) value[c.code] = { type: c.type, value: emptyValueOf(c.type) };
        for (const [cc, cv] of Object.entries(row as Record<string, unknown>)) {
          const child = kids[cc];
          if (!child) throw new InputError(`${rw}.${cc}: テーブル ${code} に無い子（${Object.keys(kids).join(", ")}）`);
          value[cc] = { type: child.type, value: convertValue(child, cv, `${rw}.${cc}`, users) };
        }
        return { id: String(i + 1), value };
      });
      rec[code] = { type: "SUBTABLE", value: rows };
      continue;
    }
    rec[code] = { type: prop.type, value: convertValue(prop, v, w, users) };
  }
  return rec;
}

/** data の一覧の形の検査（件数、JSON の大きさ） */
export function checkDataList(data: unknown): TryData[] {
  if (!Array.isArray(data)) throw new InputError("data はレコード（{ 項目コード: 値 }）の配列");
  if (!data.length) throw new InputError("data が空");
  if (data.length > TRY_MAX_DATA) throw new InputError(`data は ${TRY_MAX_DATA} 件まで`);
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes > 64 * 1024) throw new InputError(`data が大きすぎる（${bytes.toLocaleString()} バイト。64 KiB まで）`);
  return data as TryData[];
}
