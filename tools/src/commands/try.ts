/**
 * try（式の試し計算。計画 25 章。工程 8）: 式ごとに同梱のサンプルアプリ（sample-app.ts。全項目タイプ × 2、テーブル 2 つ、レコード 3 件）へ 1 行だけの設定を組み、
 * normalize（検査）→ calc（模擬）でサンプルレコードの値を返す。利用者のアプリ・レコード・接続は使わない（関数の解説や使用例の確認、式の断片の確かめに）。
 *   - 対象（as）は型（NUMBER / TEXT / DATE … TARGET_TYPES の型と、その別名）か項目コード。テーブルの中なら table（テーブルのコード）。既定は TEXT（文字列 1 行。どの値も文字列で見える）
 *   - 式は 1 回 TRY_MAX_FORMULAS まで。式ごとに独立（1 つの誤りがほかを止めない）。値（value）は対象の型に入れた後の値（kintone に保存される形。calc と同じ変換）。
 *     エンジンの生の値（raw。数値は数、日付は epoch 秒、配列は配列）が value と違うときは raw も返す（型の変換を見せる。別に 1 回評価する）
 *   - 対象は式が参照していない項目を選ぶ（数値1 を使う式なら 数値2）。自己参照になるときのために、1 行の設定は各種設定の circular_refer を ON にして組む（設定画面の検査だけの決まり）
 *   - 文脈は calc と同じ（イベント、ログインユーザー、mobile、ユーザー情報のテストデータ、policy の allowFunctions）。APP_URL はサンプルアプリの接続先（既定の例の URL）で評価する
 *   - 走査の上の制限（副作用のある関数は policy の承認、EV_SET は不可）も calc と同じ。結果を採らない sink も同じ
 *   - 架空の項目と値（try-data.ts。計画 25.3）: fields で標本に項目を足す（案 2）、data で簡略形の値のレコードを作る（案 1。土台は標本の base = 3 の空のレコード）、
 *     appFields で利用者のアプリの項目定義に架空の値（案 3。標本のレコードは使わない。data が要る）
 */
import type { CalcEvent, Engine } from "../engine.ts";
import { InputError, quiet } from "../input.ts";
import type { FieldProperty, FieldsFile } from "./fields.ts";
import type { KintoneRecord } from "./record.ts";
import type { Finding } from "../normalize/findings.ts";
import type { Lang } from "../normalize/model.ts";
import type { Policy } from "../normalize/policy.ts";
import type { UsersInfoTable, UsersOrigin } from "../users/index.ts";
import { DEFAULT_POLICY } from "../normalize/policy.ts";
import { scanFormula } from "../scan.ts";
import { calcSettings, type CalcLine } from "./calc.ts";
import { normalizeSettings } from "./normalize.ts";
import { sampleApp } from "../sample-app.ts";
import { TYPE_ALIASES, applyData, checkDataList, emptyRecordOf, extendFields, fillMissing, normalizeDefaults, type TryData, type TryFieldDef } from "./try-data.ts";

export const TRY_MAX_FORMULAS = 10;
export const TRY_MAX_FORMULA_CHARS = 4000;
/** 既定の対象（文字列 1 行。数値も日付も配列も文字列で見える） */
export const TRY_DEFAULT_AS = "TEXT";

export interface TryFormula {
  formula: string;
  /** 対象の型（NUMBER / TEXT / DATE …）か項目コード。省略は TEXT */
  as?: string;
  /** テーブルの中で計算するときのテーブルのコード（テーブル1 / テーブル2） */
  table?: string;
}

export interface TryTarget {
  code: string;
  type: string;
  table?: string;
}

export interface TryValue {
  /** レコード（標本は "1"〜"3"、架空の値は "d1"〜） */
  record: string;
  /** 対象の型に入れた後の値（kintone に保存される形）。テーブルの中なら行ごとの値の配列 */
  value: unknown;
  /** エンジンの生の値（value と違うときだけ。数値は数、日付は epoch 秒、配列は配列。テーブルの中なら行ごと） */
  raw?: unknown;
  /** 式の評価の失敗（段: 文） */
  error?: string;
  /** 実行時の sink が呼ばれた（結果を採らない） */
  failed?: boolean;
}

export interface TryFormulaResult {
  /** 1 から */
  index: number;
  formula: string;
  target?: TryTarget;
  /** ok = 計算した、invalid = 検査のエラーか対象・文脈の誤り（findings に error）、failed = sink が呼ばれた */
  status: "ok" | "invalid" | "failed";
  /** その式の normalize の結果（エラー / 警告 / 情報）と、対象・文脈の誤り（try.target / calc.context） */
  findings: Finding[];
  values: TryValue[];
  /** calc の印（ユーザー情報、イベント、再計算で変わる、kintone の文脈、副作用） */
  marks: string[];
}

export interface TryInput {
  engine: Engine;
  formulas: TryFormula[];
  /** 標本のレコードの番号（1〜3。省略は全部。data があるときの省略は無し） */
  records?: number[];
  /** 標本に足す項目（案 2） */
  fields?: TryFieldDef[];
  /** 架空の値のレコード（案 1。簡略形。標本の base の空のレコードを土台に埋める） */
  data?: TryData[];
  /** data の土台にする標本のレコード（1〜3。既定 3 = 空） */
  base?: number;
  /** 利用者のアプリの項目定義（案 3。fields.json）。標本の代わりに使う（data が要る。records は使えない） */
  appFields?: FieldsFile;
  evType?: string;
  event?: CalcEvent;
  mobile?: boolean;
  user?: string;
  usersInfo: UsersInfoTable | null;
  usersOrigin: UsersOrigin | { kind: "none" };
  usersLabel?: string;
  policy?: Policy;
  lang?: Lang;
}

export interface TryResult {
  app: {
    appId: number;
    appName: string;
    fieldCount: number;
    /** sample = 同梱の標本、app = 利用者のアプリの項目定義（appFields） */
    source: "sample" | "app";
    /** 使ったレコード（標本 "1"〜"3"、架空の値 "d1"〜） */
    records: string[];
    /** 足した項目（「単価（NUMBER）」の形） */
    extraFields: string[];
  };
  contextLine: string;
  notice: string;
  results: TryFormulaResult[];
  /** 1 行の要約（ok / エラーの件数） */
  summary: string;
  text: string;
}

/** 1 行の設定そのものについての結果（try が組んだ封筒の各種設定の差、内部番号、保存値の大きさ）は式の確かめに関係ないので除く */
const TRY_OWN_RULES = new Set(["misc.changed", "fieldno.screen", "size.bytes", "schema.derived"]);

type TableRows = Array<{ id?: string; value: Record<string, { value?: unknown }> }>;
const isTable = (v: unknown): v is TableRows => Array.isArray(v) && v.every((r) => r && typeof r === "object" && "value" in (r as object));

/**
 * 対象の項目を決める（型か項目コード、テーブルの中かどうか）。型のときは、式が参照していない項目を優先し、短いコードの順で最初（文字列1、数値1 …。数値1 を使う式なら 数値2）。
 * referenced は式の識別子（scanFormula）
 */
export function resolveTryTarget(fields: FieldsFile, targetTypes: ReadonlySet<string>, as: string | undefined, table: string | undefined, referenced: ReadonlySet<string> = new Set()): TryTarget {
  const props = fields.properties;
  const tables = Object.values(props).filter((p) => p.type === "SUBTABLE").map((p) => p.code).sort();
  const want = (as ?? TRY_DEFAULT_AS).trim();
  if (!want) throw new InputError("as が空（型 NUMBER / TEXT / DATE … か項目コード）");
  const upper = want.toUpperCase();
  const type = TYPE_ALIASES[upper] ?? (targetTypes.has(upper) ? upper : undefined);
  let scope: Record<string, FieldProperty> = props;
  let tableCode: string | undefined;
  if (table !== undefined) {
    const t = props[table];
    if (!t || t.type !== "SUBTABLE") throw new InputError(`table ${JSON.stringify(table)} はサンプルアプリのテーブルでない（${tables.join(" / ")}）`);
    scope = t.fields ?? {};
    tableCode = table;
  }
  const byCode = (code: string, p: FieldProperty, inTable?: string): TryTarget => {
    if (!targetTypes.has(p.type)) throw new InputError(`${code} の型 ${p.type} には計算式を設定できない（使える型: ${[...targetTypes].join(", ")}）`);
    return { code, type: p.type, ...(inTable ? { table: inTable } : {}) };
  };
  // 項目コード（テーブルの外、table の中。table を省いたときはテーブルの子からも探す）
  if (Object.prototype.hasOwnProperty.call(scope, want)) return byCode(want, scope[want], tableCode);
  if (tableCode === undefined) {
    for (const t of tables) {
      const child = props[t].fields?.[want];
      if (child) return byCode(want, child, t);
    }
  }
  if (!type) {
    const all = new Set<string>();
    for (const p of Object.values(props)) { all.add(p.type); for (const c of Object.values(p.fields ?? {})) all.add(c.type); }
    if (all.has(upper)) throw new InputError(`${upper} の項目には計算式を設定できない（使える型: ${[...targetTypes].join(", ")}）`);
    throw new InputError(`as ${JSON.stringify(want)} は型でも項目コードでもない（型: ${[...targetTypes].join(", ")}。項目は try --describe / fml_try の describe で）`);
  }
  const candidates = Object.values(scope).filter((p) => p.type === type && !p.lookup).sort((a, b) => a.code.length - b.code.length || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  if (!candidates.length) throw new InputError(`${tableCode ? `テーブル ${tableCode} の中` : "サンプルアプリ"}に ${type} の項目が無い`);
  const free = candidates.find((p) => !referenced.has(p.code)) ?? candidates[0];
  return { code: free.code, type, ...(tableCode ? { table: tableCode } : {}) };
}

/**
 * 1 行だけの設定（封筒 + 既定の共通の設定 + 対象の行）。計算式ツールは有効（tool.disabled の警告を出さない）、各種設定の circular_refer は ON
 * （自己参照の式を設定画面の検査で止めない。実行には関係ない）。各種設定の差（misc.changed）は try が自分で付けたものなので結果から除く
 */
export function buildTryEnvelope(engine: Engine, fields: FieldsFile, code: string, formula: string, lang: Lang): Record<string, unknown> {
  const api = engine.api;
  const source = api.defaultSource(lang) as unknown as Record<string, unknown>;
  return {
    date: "2026-01-15 00:00:00",
    pluginName: "計算式プラグイン",
    pluginID: api.pluginId,
    PluginVersion: engine.source.pluginVersion,
    appId: fields.appId,
    appName: fields.appName,
    ...source,
    toolEnable: true,
    pluginMiscInfo: { ...(source.pluginMiscInfo as Record<string, unknown>), circular_refer: true },
    pluginInfos: [{ fieldcode: code, state: true, formulaSet: formula, edit: false, hide: false, rank: "" }]
  };
}

/** JSON にできる形に（Worker から構造化クローンで返す。BigNumber / moment は toJSON、できなければ文字に） */
function plain(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? (v === undefined ? null : String(v)) : JSON.parse(s);
  } catch {
    return String(v);
  }
}

/** エンジンの生の値（calc と同じ pp・文脈で、保存値の formula を別に 1 回評価する。失敗は calc が報告済みなので捨てる） */
function rawValueOf(engine: Engine, pp: unknown, record: Record<string, unknown>, formula: string, target: TryTarget, evType: string | undefined, event: CalcEvent | undefined): unknown {
  const api = engine.api;
  const run = (kf: { dq: (f: string) => unknown }): unknown => {
    try {
      return plain(quiet(() => kf.dq(formula)));
    } catch {
      return null;
    }
  };
  const kf = api.createRunner(pp as never, record as never, evType ?? "allUpdate", event as never) as unknown as { dq: (f: string) => unknown; initTableInfo: (t: string) => void; currRow: (i: number) => void };
  if (!target.table) {
    kf.initTableInfo("");
    return run(kf);
  }
  const rows = record[target.table] as { value?: unknown } | undefined;
  const list = Array.isArray(rows?.value) ? (rows!.value as unknown[]) : [];
  kf.initTableInfo(target.table);
  return list.map((_r, i) => {
    kf.currRow(i);
    return run(kf);
  });
}

const short = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : [...s].length > 200 ? [...s].slice(0, 200).join("") + "…" : s;
};

export async function trySettings(input: TryInput): Promise<TryResult> {
  const { engine } = input;
  const api = engine.api;
  const lang: Lang = input.lang ?? "ja";
  if (!Array.isArray(input.formulas) || !input.formulas.length) throw new InputError("式が無い（formulas）");
  if (input.formulas.length > TRY_MAX_FORMULAS) throw new InputError(`式は 1 回 ${TRY_MAX_FORMULAS} 個まで（${input.formulas.length}）`);
  const app = sampleApp();
  const source: TryResult["app"]["source"] = input.appFields ? "app" : "sample";
  // 利用者の項目定義は既定値を補う（手で書いた・古い fields.json の備え。標本は gen-sample-app が取った実機の形のまま）
  let fields: FieldsFile = input.appFields ? normalizeDefaults(input.appFields) : app.fields;
  let extraFields: string[] = [];
  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields)) throw new InputError("fields は項目（{ code, type, options?, table?, fields? }）の配列");
    const ext = extendFields(fields, input.fields);
    fields = ext.fields;
    extraFields = ext.added;
  }
  const picked: Array<{ id: string; label: string; record: KintoneRecord }> = [];
  if (input.appFields) {
    if (input.records !== undefined) throw new InputError("appFields（利用者のアプリの項目定義）のときは標本のレコード（records）は使えない（data で架空の値を書く）");
    if (input.data === undefined) throw new InputError("appFields（利用者のアプリの項目定義）には data（架空の値のレコード）が要る");
  } else {
    const ids = input.records === undefined ? (input.data === undefined ? app.records.map((r) => r.id) : []) : [...new Set(input.records)];
    if (!ids.length && input.data === undefined) throw new InputError("records が空（1〜3）");
    for (const id of ids) if (!app.records.some((r) => r.id === id)) throw new InputError(`records は 1〜${app.records.length}（${id}）`);
    for (const id of ids) {
      const r = app.records.find((x) => x.id === id)!;
      // 足した項目は標本のレコードに無いので空で補う（無いと calc の after に出ない）
      picked.push({ id: String(id), label: r.label, record: extraFields.length ? fillMissing(fields, r.record) : r.record });
    }
  }
  if (input.data !== undefined) {
    const list = checkDataList(input.data);
    let base: KintoneRecord;
    if (input.appFields) base = emptyRecordOf(fields, "0");
    else {
      const b = input.base ?? 3;
      const br = app.records.find((x) => x.id === b);
      if (!br) throw new InputError(`base は標本のレコードの番号（1〜${app.records.length}）: ${b}`);
      base = br.record;
    }
    list.forEach((d, i) => {
      const id = `d${i + 1}`;
      const rec = applyData(fields, base, d, `data[${i}]`, input.usersInfo);
      rec.$id = { type: "__ID__", value: String(100 + i + 1) };
      if (fields.properties["レコード番号"]?.type === "RECORD_NUMBER" && input.appFields) rec["レコード番号"] = { type: "RECORD_NUMBER", value: String(100 + i + 1) };
      picked.push({ id, label: `架空の値（${Object.keys(d).join(", ") || "空"}）`, record: rec });
    });
  }
  if (!picked.length) throw new InputError("計算するレコードが無い（records か data）");
  const targetTypes = new Set(api.TARGET_TYPES as readonly string[]);
  // 各種設定の差（circular_refer）は try が付けたもの（警告にしない。結果からも除く）
  const policy: Policy = { ...(input.policy ?? DEFAULT_POLICY), allowMiscChanges: true };
  let contextLine = "";
  let calcNotice = "";
  const results: TryFormulaResult[] = [];
  for (let i = 0; i < input.formulas.length; i++) {
    const f = input.formulas[i];
    const where = `try[${i + 1}]`;
    const res: TryFormulaResult = { index: i + 1, formula: typeof f?.formula === "string" ? f.formula : "", status: "ok", findings: [], values: [], marks: [] };
    results.push(res);
    const fail = (rule: string, message: string): void => {
      res.status = "invalid";
      res.findings.push({ level: "error", rule, where, message });
    };
    if (!f || typeof f.formula !== "string" || !f.formula.trim()) { fail("try.formula", "式が空"); continue; }
    if ([...f.formula].length > TRY_MAX_FORMULA_CHARS) { fail("try.formula", `式が長すぎる（${TRY_MAX_FORMULA_CHARS} 文字まで）`); continue; }
    let target: TryTarget;
    const referenced = scanFormula(api.stripFormula(f.formula)).identifiers;
    try {
      target = resolveTryTarget(fields, targetTypes, f.as, f.table, referenced);
    } catch (e) {
      if (e instanceof InputError) { fail("try.target", e.message); continue; }
      throw e;
    }
    res.target = target;
    // 自己参照（項目コードで指定したとき、同じ型の項目が全部使われているとき）: テーブルの外の項目は 1 段目と 2 段目の 2 回計算されるので値が 2 回分になる（実機と同じ）
    if (referenced.has(target.code)) res.findings.push({ level: "warning", rule: "try.self-reference", where, message: `対象 ${target.code} を式が参照している（${target.table ? "行ごとに 1 回" : "テーブルの外の項目は 1 段目と 2 段目の 2 回計算されるので、値が 2 回分になる"}。as で式が使わない項目を選ぶ）` });
    const envelope = buildTryEnvelope(engine, fields, target.code, f.formula, lang);
    const n = await normalizeSettings({
      settingsText: JSON.stringify(envelope), settingsFile: where, fields, engine, policy, lang,
      usersInfo: input.usersInfo, usersLabel: input.usersLabel, usersOrigin: input.usersOrigin.kind === "none" ? undefined : input.usersOrigin
    });
    res.findings.push(...n.findings.items.filter((x) => !TRY_OWN_RULES.has(x.rule)));
    if (n.findings.hasErrors || !n.saved) { res.status = "invalid"; continue; }
    const stripped = String(n.saved.pluginFields[0]?.formula ?? "");
    // 式ごとにレコードを写す（calc が書き換える。1 つ前の式の結果を次の式に見せない）
    const records = picked.map((r) => ({ id: r.id, record: structuredClone(r.record), fileAppId: fields.appId }));
    let c;
    try {
      c = calcSettings({
        normalized: n, engine, fields, appId: fields.appId, records, evType: input.evType, event: input.event, mobile: input.mobile, user: input.user,
        usersInfo: input.usersInfo, usersOrigin: input.usersOrigin, allowDefaultBaseUrl: true
      });
    } catch (e) {
      if (e instanceof InputError) { fail("calc.context", e.message); continue; }
      throw e;
    }
    contextLine ||= c.contextLine;
    calcNotice ||= c.notice;
    const lineCode = target.table ?? target.code;
    for (const r of c.records) {
      const line: CalcLine | undefined = r.lines.find((l) => l.fieldcode === lineCode);
      let value: unknown = line?.after;
      if (target.table && isTable(value)) value = value.map((row) => row.value?.[target.code]?.value);
      const errs = r.errors.filter((e) => e.fieldcode === target.code || e.fieldcode === lineCode || e.fieldcode === "(全体)" || e.fieldcode === "(sink)").map((e) => `${e.phases.join(", ")}: ${e.message}`);
      const v: TryValue = { record: r.id, value, ...(errs.length ? { error: errs.join(" / ") } : {}), ...(r.failed ? { failed: true } : {}) };
      if (!r.failed && !errs.length) {
        // 生の値（写しのレコードで別に 1 回。sink が呼ばれたらこの値も採らない）
        const src = picked.find((p) => p.id === r.id);
        engine.clearSinkCalls();
        const raw = src ? rawValueOf(engine, n.saved.pluginPP, structuredClone(src.record) as Record<string, unknown>, stripped, target, input.evType, input.event) : undefined;
        if (engine.sinkCalls().length) { v.failed = true; v.error = `実行時の sink が呼ばれた（生の値の評価）: ${engine.sinkCalls().map((s) => `${s.sink} ${s.detail}`.trim()).join(", ")}`; }
        else if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(value)) v.raw = raw;
        engine.clearSinkCalls();
      }
      res.values.push(v);
      if (line) res.marks = line.marks;
      if (v.failed) res.status = "failed";
    }
  }
  const okCount = results.filter((r) => r.status === "ok").length;
  const ids = picked.map((r) => r.id);
  const appLabel = source === "sample" ? `サンプルアプリ「${fields.appName}」` : `アプリ ${fields.appId}「${fields.appName}」の項目定義（値は架空）`;
  const summary = `試し計算 ${results.length} 式: ok ${okCount}${results.length - okCount ? `、エラー ${results.length - okCount}` : ""}（${appLabel}、レコード ${ids.join(", ")}）`;
  if (!contextLine) contextLine = `文脈: アプリ ${fields.appId}（計算していない式だけ）`;
  // try 自身の注意（何で計算したか）に calc の注意（3 段の計算の文脈）を添える
  const notice = `${source === "sample" ? "サンプルアプリ（架空）での模擬。利用者のアプリ・レコードは使っていない" : "利用者のアプリの項目定義に架空の値を当てた模擬。レコードは更新していない"}${calcNotice ? `。${calcNotice}` : ""}`;
  const text: string[] = [summary, notice, contextLine];
  if (extraFields.length) text.push(`足した項目（架空）: ${extraFields.join("、")}`);
  for (const r of picked) if (r.id.startsWith("d")) text.push(`レコード ${r.id}: ${r.label}`);
  for (const r of results) {
    const head = r.target ? `${r.target.code}（${r.target.type}${r.target.table ? `。${r.target.table} の中` : ""}）← ` : "";
    text.push(`[${r.index}] ${head}${r.formula.replace(/\s*\n\s*/g, " ")}`);
    for (const v of r.values) text.push(`    レコード ${v.record}: ${short(v.value)}${v.raw !== undefined ? `（生の値 ${short(v.raw)}）` : ""}${v.error ? `  ！ ${v.error}` : ""}${v.failed ? "  ！ 結果を採らない（実行時の sink）" : ""}`);
    if (r.marks.length) text.push(`    印: ${r.marks.join("、")}`);
    for (const f of r.findings) if (f.level !== "info") text.push(`    ${f.level === "error" ? "エラー" : "警告"} ${f.rule}: ${f.message}`);
  }
  return { app: { appId: fields.appId, appName: fields.appName, fieldCount: Object.keys(fields.properties).length, source, records: ids, extraFields }, contextLine, notice, results, summary, text: text.join("\n") };
}
