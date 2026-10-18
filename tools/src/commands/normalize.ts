/**
 * normalize <settings.json> --fields fields/N.json [--users <f>] [--out <f>] [--check]
 * 設定ファイル（元の値 FormulaSource の封筒）を設定画面と同じ手順で検査し、既定値を補った封筒を書き出す（オーサリングツール_実装計画.md 6 章）。
 * 順序（Codex レビュー #1・#16）: 生の JSON で封筒と未知のキー → normalizeSource → stripFormula → 全式の走査（副作用 / 文脈 / EV_SET）→ 拒否 → checkFormula / deriveSemantic（ここで初めて dq）→ 検査 → 大きさ。
 * 規則名は 分類.名前（AI作業手順.md に意味と直し方）。
 */
import type { Engine } from "../engine.ts";
import { InputError, PLUGIN_NAME, jsonDiff, quiet } from "../input.ts";
import type { FieldsFile } from "./fields.ts";
import { contextTargetsOf } from "./fields.ts";
import { Findings } from "../normalize/findings.ts";
import { ENVELOPE_KEYS, OUTER_KEYS, ROW_SCREEN_KEYS, ROW_SOURCE_KEYS, isGroupRow, isHeaderRow, isLookupRow, isSpacerRow, materialsOf, typeOf, type FieldRow, type FormulaSaved, type FormulaSource, type Lang } from "../normalize/model.ts";
import { DEFAULT_POLICY, type Policy } from "../normalize/policy.ts";
import { scanFormula, staticArgsOf, type ScanResult } from "../scan.ts";
import { scanUserInfoCalls } from "./users.ts";
import { defaultUsersInfo, type UsersOrigin } from "../users/index.ts";
import type { UsersInfoTable } from "../users/index.ts";

export interface NormalizeInput {
  settingsText: string;
  settingsFile: string;
  fields: FieldsFile;
  engine: Engine;
  policy?: Policy;
  check?: boolean;
  lang?: Lang;
  /** UINFO 系の参照するコードの突き合わせと、検証（checkFormula）のエンジンの文脈（無ければ既定のテストデータ） */
  usersInfo?: UsersInfoTable | null;
  usersLabel?: string;
  usersOrigin?: UsersOrigin;
  now?: () => Date;
}

/** calc が文脈を要る式（走査から）。無ければ名指しで止める（計画 5 章。Codex #6） */
export interface ContextNeeds {
  /** APP_URL を使う項目（接続先の URL が要る） */
  appUrl: string[];
  /** LOGIN_* / WHICH と、ログインユーザーで決まる UINFO 系（引数なし・項目・式）を使う項目（ログインユーザーが要る。文字列のコードだけの OINFO("sales") などは要らない） */
  login: string[];
  /** LOOKUP_GETID(項目) の項目 → 使っている項目 */
  lookups: Array<{ fieldcode: string; arg: string }>;
  related: Array<{ fieldcode: string; arg: string }>;
}

export interface NormalizeResult {
  findings: Findings;
  /** 既定値を補った封筒（エラーがあれば無い） */
  output?: Record<string, unknown>;
  /** 保存値（派生値つき。calc が使う。エラーがあれば無い） */
  saved?: FormulaSaved;
  source?: FormulaSource;
  /** 行（検証済み。calc が pp と一緒に使う） */
  rows?: FieldRow[];
  pp?: Record<string, unknown>;
  /** 項目ごとの走査（calc の印に） */
  scans: Map<string, ScanResult>;
  /** --check: 入力（元の値）と出力の差 */
  checkDiffs?: string[];
  contextNeeds: ContextNeeds;
  /** 封筒の appId */
  appId?: number;
  size?: { bytes: number; keys: number };
  summary: string;
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** UINFO 系の関数の引数にある文字列の中の、ユーザー・組織・グループのコードらしきもの（"a,b" はカンマ区切り。option の名前や # のカスタマイズ項目は除く） */
const UINFO_OPTIONS = new Set(["id", "code", "ctime", "mtime", "valid", "name", "surName", "givenName", "surNameReading", "givenNameReading", "localName", "localNameLocale", "timezone", "locale", "description", "phone", "mobilePhone", "extensionNumber", "email", "callto", "url", "employeeNumber", "birthDate", "joinDate", "groups", "orgs", "primaryOrganization", "sortOrder", "setData", "parentCode", "users", "children"]);
function codesInStrings(scan: ScanResult, userInfoFns: readonly string[]): string[] {
  const out: string[] = [];
  for (const { text, call } of scan.stringArgs) {
    if (!userInfoFns.includes(call)) continue;
    for (const c of text.split(",")) {
      const t = c.trim();
      if (t && !t.startsWith("#") && !UINFO_OPTIONS.has(t) && /^[^\s"]{1,128}$/.test(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** 生の JSON の未知のキーを CONFIG_SCHEMA で再帰的に探す（normalizeSource は未知のキーを黙って捨てるので、その前に。Codex #3）。map のキーは任意 */
function unknownKeys(raw: unknown, schema: Record<string, unknown> | undefined, pathStr: string, out: string[]): void {
  if (!schema || !raw || typeof raw !== "object") return;
  const t = schema.type as string;
  if (t === "object" && isPlain(raw)) {
    const props = (schema.props ?? {}) as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(raw)) {
      if (!(k in props)) out.push(`${pathStr}.${k}`);
      else unknownKeys(v, props[k], `${pathStr}.${k}`, out);
    }
  } else if (t === "map" && isPlain(raw)) {
    for (const [k, v] of Object.entries(raw)) unknownKeys(v, schema.values as Record<string, unknown>, `${pathStr}.${k}`, out);
  } else if (t === "array" && Array.isArray(raw)) {
    raw.forEach((v, i) => unknownKeys(v, schema.items as Record<string, unknown>, `${pathStr}[${i}]`, out));
  }
}

/** 有向グラフの強連結成分（Tarjan）。大きさ 2 以上の成分 = 循環 */
export function stronglyConnected(graph: Map<string, string[]>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length >= 2) out.push(comp.reverse());
    }
  };
  for (const v of graph.keys()) if (!idx.has(v)) visit(v);
  return out;
}

export async function normalizeSettings(input: NormalizeInput): Promise<NormalizeResult> {
  const { engine, fields } = input;
  const api = engine.api;
  const lang: Lang = input.lang ?? "ja";
  const policy = input.policy ?? DEFAULT_POLICY;
  const findings = new Findings();
  const scans = new Map<string, ScanResult>();
  const file = input.settingsFile;
  const contextNeeds: ContextNeeds = { appUrl: [], login: [], lookups: [], related: [] };
  const done = (extra: Partial<NormalizeResult> = {}): NormalizeResult => ({ findings, scans, contextNeeds, summary: findings.format(), ...extra });

  // 1. 生の JSON（封筒、未知のキー）
  let raw: unknown;
  try {
    raw = JSON.parse(input.settingsText.replace(/^﻿/, ""));
  } catch (e) {
    findings.error("schema.json", file, `JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }
  if (!isPlain(raw)) {
    findings.error("schema.json", file, "最上位はオブジェクト");
    return done();
  }
  if (raw.pluginID !== api.pluginId) findings.error("envelope.plugin", file, `pluginID が計算式プラグインのものでない: ${JSON.stringify(raw.pluginID)}（${api.pluginId} が要る）`);
  const ver = String(raw.PluginVersion ?? "");
  if (!/^[1-9]\d{0,5}$/.test(ver)) findings.error("envelope.version", file, `PluginVersion が版の数でない: ${JSON.stringify(raw.PluginVersion)}`);
  else if (Number(ver) > Number(engine.source.pluginVersion)) findings.error("envelope.version", file, `PluginVersion ${ver} が zip の計算式プラグイン Ver.${engine.source.pluginVersion} より新しい（tools の zip を新しくする）`);
  else if (Number(ver) < Number(engine.source.pluginVersion)) findings.info("envelope.version", file, `Ver.${ver} の設定（zip は Ver.${engine.source.pluginVersion}。取り込める。書き出すと Ver.${engine.source.pluginVersion} になる）`);
  const appId = raw.appId;
  if (typeof appId !== "number" || !Number.isInteger(appId) || appId <= 0) findings.error("envelope.app", file, `appId が正の整数でない: ${JSON.stringify(appId)}`);
  else if (appId !== fields.appId) findings.error("envelope.app", file, `appId ${appId} が fields のアプリ ${fields.appId} と違う（別のアプリの設定を当てている。Codex #7）`);
  const known = new Set<string>([...ENVELOPE_KEYS, ...api.SOURCE_KEYS, ...api.DERIVED_KEYS, ...OUTER_KEYS]);
  const dropped: string[] = [];
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) findings.error("schema.unknown-key", file, `知らないキー $.${k}（設定画面は黙って捨てる。書き間違いを見逃さないためにエラー）`);
    else if ((api.DERIVED_KEYS as readonly string[]).includes(k) || (OUTER_KEYS as readonly string[]).includes(k)) dropped.push(k);
  }
  if (dropped.length) findings.info("schema.derived", file, `派生値・外枠のキーは捨てて保存時に作り直す: ${dropped.join(", ")}`);
  // 入れ子の未知のキー（pluginBtnInfo / pluginListInfo / authority / pluginMiscInfo / pluginInfos の行）
  const nested: string[] = [];
  const schemaProps = ((api.CONFIG_SCHEMA as unknown as { props?: Record<string, Record<string, unknown>> }).props ?? {});
  for (const k of api.SOURCE_KEYS as readonly string[]) if (k in raw) unknownKeys(raw[k], schemaProps[k], `$.${k}`, nested);
  for (const pth of nested) if (!/^\$\.pluginInfos\[\d+\]\./.test(pth)) findings.error("schema.unknown-key", file, `知らないキー ${pth}（設定画面は黙って捨てる）`);
  const infos = raw.pluginInfos;
  if (infos !== undefined && !Array.isArray(infos)) findings.error("schema.rows", file, "pluginInfos は配列");
  const rowKnown = new Set<string>([...ROW_SOURCE_KEYS, ...ROW_SCREEN_KEYS]);
  const seen = new Set<string>();
  let screenKeys = 0;
  (Array.isArray(infos) ? infos : []).forEach((r, i) => {
    const where = `${file} pluginInfos[${i}]`;
    if (!isPlain(r)) { findings.error("schema.rows", where, "行はオブジェクト"); return; }
    for (const k of Object.keys(r)) {
      if (!rowKnown.has(k)) findings.error("schema.unknown-key", where, `知らないキー ${k}`);
      else if ((ROW_SCREEN_KEYS as readonly string[]).includes(k)) screenKeys++;
    }
    if (typeof r.fieldcode !== "string" || !r.fieldcode) findings.error("schema.rows", where, "fieldcode（文字列）が要る");
    else if (seen.has(r.fieldcode)) findings.error("schema.rows", where, `fieldcode が重複: ${r.fieldcode}`);
    else seen.add(r.fieldcode);
    if (r.formulaSet !== undefined && typeof r.formulaSet !== "string") findings.error("schema.rows", where, "formulaSet は文字列");
    for (const k of ["state", "edit", "hide"]) if (r[k] !== undefined && typeof r[k] !== "boolean") findings.error("schema.rows", where, `${k} は true / false`);
    if (r.rank !== undefined && r.rank !== "") {
      const n = typeof r.rank === "number" ? r.rank : typeof r.rank === "string" && /^-?\d+$/.test(r.rank.trim()) ? Number(r.rank) : NaN;
      if (!Number.isInteger(n)) findings.error("rank.range", where, `rank は整数か ""（${JSON.stringify(r.rank)}）`);
      else if (n > 10000 || n < -10000) findings.error("rank.range", where, `rank は -10000〜10000（${n}。設定画面と同じ規則）`);
    }
  });
  if (screenKeys) findings.info("schema.screen-keys", file, "画面の行のキー（id / type / usedFields など）は捨てる");
  if (findings.hasErrors) return done();

  // 2. 元の値（既定値を補う）→ 行
  const { pp, crec, rows, views } = materialsOf(api, fields, lang);
  const source = api.normalizeSource(raw, lang, views.length ? (views as never) : undefined) as unknown as FormulaSource;
  const missing = api.applySaved(rows as never, source.pluginInfos as never);
  for (const code of missing) findings.error("field.missing", `${file} ${code}`, "今のアプリに無い項目（削除されたか、フィールドコードが変わった）");
  const targetTypes = new Set(api.TARGET_TYPES as readonly string[]);
  const byCode = new Map(rows.map((r) => [r.fieldcode, r]));
  for (const r of rows) {
    const where = `${file} ${r.fieldcode}`;
    const t = typeOf(r);
    // スペース項目（要素 ID のある SPACER。式の返り値を表示する）とヘッダー（ボタン）の行は項目の型でないが計算式を置ける（設定画面と同じ。tools 0.3.1 まで SPACER を誤って止めていた）
    if (r.formulaSet && r.formulaSet.trim() && !targetTypes.has(t) && !isSpacerRow(r) && !isHeaderRow(r)) findings.error("field.type", where, `${t} の項目には計算式を設定できない`);
    if (r.edit && (isHeaderRow(r) || isSpacerRow(r) || isGroupRow(r))) findings.error("field.flag", where, `${t} に「編集」は付けられない`);
    if (r.hide && (isHeaderRow(r) || isSpacerRow(r))) findings.error("field.flag", where, `${t} に「非表示」は付けられない`);
    if (r.state && r.formulaSet && isLookupRow(r)) findings.warning("field.lookup", where, "ルックアップ項目に計算式（ルックアップの値を上書きする）");
    if (r.state && r.formulaSet && t === "SUBTABLE") findings.warning("field.subtable", where, "テーブル自身の計算式はテーブルの行数の制御（行数 | 初期データ）");
    if (!r.state && r.formulaSet && r.formulaSet.trim()) findings.warning("field.disabled", where, "計算式があるが無効（計算されない）");
  }
  const listViews = (source.pluginListInfo as { views?: Record<string, unknown> }).views ?? {};
  if (views.length) for (const id of Object.keys(listViews)) if (!views.some((v) => v.id === id)) findings.error("views.missing", `${file} pluginListInfo.views.${id}`, "今のアプリに無い一覧");
  const misc = source.pluginMiscInfo as Record<string, unknown>;
  const miscDiff = Object.keys(api.MISC_DEFAULTS).filter((k) => misc[k] !== (api.MISC_DEFAULTS as Record<string, unknown>)[k]);
  if (miscDiff.length) (policy.allowMiscChanges ? findings.info : findings.warning).call(findings, "misc.changed", file, `各種設定が既定と違う: ${miscDiff.join(", ")}${policy.allowMiscChanges ? "（policy で承認済み）" : "（利用者が決めること。policy の allowMiscChanges で承認）"}`);
  if ((source.authority as { everyone?: boolean }).everyone === false) findings.warning("authority.limited", file, "権限設定が「全員」でない（計算が動くユーザーが限られる）");
  if (source.pluginEnable === false) findings.warning("plugin.disabled", file, "プラグイン無効（保存しても計算しない）");
  if (source.toolEnable === false) findings.warning("tool.disabled", file, "計算式ツール無効（詳細画面の計算式ツールが出ない）");

  // 3. 走査（dq の前）
  const tags = api.FUNCTION_TAGS as Record<string, readonly string[]>;
  const names = new Set(engine.functionNames());
  const types = engine.functionTypes();
  const blocked = new Set<string>();
  const dqBefore = engine.dqCount();
  engine.blockDq(true);
  try {
  for (const r of rows) {
    if (!r.state || !r.formulaSet || !r.formulaSet.trim()) continue;
    const where = `${file} ${r.fieldcode}`;
    const stripped = api.stripFormula(r.formulaSet);
    const scan = scanFormula(stripped);
    scans.set(r.fieldcode, scan);
    for (const p of scan.problems) findings.error("formula.syntax", where, p);
    const used = Object.keys(scan.functions);
    for (const f of used) if (!names.has(f)) findings.error("formula.unknown-function", where, `関数 ${f} は無い（関数一覧を見る）`);
    const side = used.filter((f) => tags.sideEffect.includes(f));
    if (side.includes("EV_SET")) findings.error("event.set", where, "EV_SET はテスト用。設定には入れない");
    const notAllowed = side.filter((f) => f !== "EV_SET" && !policy.allowFunctions.includes(f));
    if (notAllowed.length) {
      findings.error("formula.side-effect", where, `副作用のある関数 ${notAllowed.join(", ")}（レコードや画面を変える）。tools は評価しない。利用者が policy の allowFunctions で承認すれば評価する`);
      blocked.add(r.fieldcode);
    } else if (side.length) findings.warning("formula.side-effect", where, `副作用のある関数 ${side.join(", ")}（policy で承認済み。calc では値を書き換える）`);
    const ctx = used.filter((f) => tags.kintoneContext.includes(f));
    if (ctx.length) findings.warning("formula.context", where, `kintone の文脈が要る関数 ${ctx.join(", ")}（ログインユーザー / ルックアップ先 / URL。calc はダミー層の値で計算する）`);
    const vol = used.filter((f) => tags.volatile.includes(f));
    if (vol.length) findings.warning("formula.volatile", where, `再計算のたびに値が変わる関数 ${vol.join(", ")}（既存レコードを変更で毎回変わる。固定するなら NVL(項目, UUID()) のように）`);
    const ev = used.filter((f) => tags.event.includes(f));
    if (ev.length) {
      findings.info("event.depends", where, `イベントで結果が変わる（${ev.join(", ")}）。calc は --event で評価するイベントを選ぶ`);
      if (/\bfcode\b/.test(scan.strings.join(" "))) findings.warning("event.fcode", where, 'EV_INFO("fcode")（変更された項目）は値変更イベントでしか入らない。既存レコードを変更と一括計算では空');
    }
    const uinfo = used.filter((f) => tags.userInfo.includes(f));
    if (uinfo.length) {
      if (misc.userInfo === false) findings.error("userinfo.off", where, `各種設定「ユーザー情報」が OFF なのに ${uinfo.join(", ")} を使う`);
      else {
        const table = input.usersInfo;
        const unknown = table ? codesInStrings(scan, tags.userInfo).filter((c) => !(c in table.userCodes) && !(c in table.orgCodes) && !(c in table.groupCodes)) : [];
        findings.info("userinfo.used", where, `ユーザー情報を使う（${uinfo.join(", ")}）。calc は${input.usersLabel ?? "既定のテストデータ（架空）"}で計算する`);
        if (unknown.length) findings.warning("userinfo.unknown", where, `${input.usersLabel ?? "既定のテストデータ"}に無いコードらしき文字列: ${unknown.slice(0, 5).join(", ")}（実データで確かめるなら users --pull）`);
      }
    }
    if (r.ptcode) {
      const agg = used.filter((f) => (types[f] ?? []).includes("AGGREGATE") || (types[f] ?? []).includes("TLTABLE"));
      if (agg.length) findings.warning("formula.aggregate", where, `テーブル内の項目でテーブルの集計関数 ${agg.join(", ")}（行ごとに全体を集計する。意図したものか）`);
    }
    for (const id of scan.identifiers) if (!(id in pp) && !byCode.has(id)) findings.info("formula.identifier", where, `項目でない識別子 ${id}（LET などの変数か、関数の引数の名前なら問題ない）`);
    // calc の文脈に要るもの（Codex #6）
    if (used.includes("APP_URL")) contextNeeds.appUrl.push(r.fieldcode);
    // ユーザー情報の関数は、1 つ目の引数に文字列のコードを書いたもの（OINFO("sales") など）はログインユーザーが要らない。引数なし・項目・式のときだけ要る（3 回目の試用で見つけた）
    if (used.some((f) => /^LOGIN_|^WHICH$/.test(f)) || (uinfo.length && scanUserInfoCalls(stripped).dynamic.length)) contextNeeds.login.push(r.fieldcode);
    for (const a of staticArgsOf(stripped, "LOOKUP_GETID")) contextNeeds.lookups.push({ fieldcode: r.fieldcode, arg: a });
    for (const a of staticArgsOf(stripped, "RELATED_GETID")) contextNeeds.related.push({ fieldcode: r.fieldcode, arg: a });
  }
  } finally {
    engine.blockDq(false);
  }
  if (engine.dqCount() !== dqBefore) throw new Error("normalize: 走査の前に dq が呼ばれた（tools の誤り）");
  if (findings.hasErrors) return done();

  // 4. 検証（ここで初めて dq）と派生値。ユーザー情報の文脈は入力のもの（無ければ既定のテストデータ）にそろえる
  //    （同じエンジンで前に calc が「ユーザー情報 OFF」で null にしていると、UINFO 系が "not available" で構文の誤りに見える）
  engine.setContext({ usersInfo: input.usersInfo ?? defaultUsersInfo(), usersOrigin: input.usersOrigin ?? (input.usersInfo ? { kind: "file", file: input.usersLabel ?? "users" } : { kind: "default" }) });
  const circular = !!misc.circular_refer;
  for (const r of rows) {
    if (!r.state) continue;
    if (blocked.has(r.fieldcode)) continue;
    // 検証用レコードは式ごとに写す（policy で許した FSET が書き換えても、次の式に影響しない。Codex #11）
    const loaded = { pp, crec: structuredClone(crec), lang } as unknown as Parameters<typeof api.checkFormula>[0];
    const res = quiet(() => api.checkFormula(loaded, r as never, circular));
    if (!res.ok) {
      const msg = res.msg ?? "";
      const m = /FIELD CODE NOT FOUND: (\S+)/.exec(msg);
      if (m) findings.error("formula.ref", `${file} ${r.fieldcode}`, `今のアプリに無い項目を参照: ${m[1]}`);
      else if (/循環|circular/i.test(msg)) findings.error("formula.circular", `${file} ${r.fieldcode}`, msg);
      else findings.error("formula.syntax", `${file} ${r.fieldcode}`, msg);
      continue;
    }
    r.usedFields = res.usedFields;
  }
  if (findings.hasErrors) return done();
  const needNumbers = quiet(() => api.finalizeSaved(rows as never));
  if (needNumbers.length) findings.info("fieldno.screen", file, `内部番号（fieldno / tableno）は設定画面が取り込み → 保存のときに補う（${needNumbers.length} 項目）`);
  const sourceRows = { ...source, pluginInfos: api.sourceInfosOf(rows as never) as unknown as FormulaSource["pluginInfos"] } as FormulaSource;
  const d = quiet(() => api.deriveSemantic(rows as never, pp as never, sourceRows as never, lang));
  if (!d.ok || !d.saved) {
    findings.error("formula.circular", file, d.message ?? "派生値を作れない");
    return done();
  }
  const saved = d.saved as unknown as FormulaSaved;
  // 3 項目以上の循環（設定画面は自己参照と 2 項目だけを止める）→ 情報。強連結成分なので大きさに上限は無い（Codex #16）
  const graph = new Map<string, string[]>();
  for (const f of saved.pluginFields) graph.set(f.fieldcode, Object.keys(f.usedFields ?? {}).filter((k) => saved.pluginFields.some((x) => x.fieldcode === k)));
  for (const c of stronglyConnected(graph).filter((x) => x.length >= 3)) findings.info("formula.cycle", file, `${c.length} 項目の循環参照（設定画面は止めない。計算の順はランクの大きい順）: ${c.join(" → ")}`);
  for (const k of ["pluginUOG", "pluginRecNo", "pluginModifier", "pluginStatus", "pluginHide", "pluginLookup"]) if ((saved as Record<string, unknown>)[k] === true) findings.info("derived.flag", file, `${k}: true（${{ pluginUOG: "ユーザー情報を読む", pluginRecNo: "レコード番号を参照", pluginModifier: "更新者を参照", pluginStatus: "ステータスを参照", pluginHide: "非表示の項目がある", pluginLookup: "ルックアップ項目に計算式" }[k]}）`);
  try {
    api.validate(saved as never, api.CONFIG_SCHEMA, api.CONFIG_LIMITS);
  } catch (e) {
    findings.error("schema.saved", file, `保存値がスキーマに合わない: ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }
  // 5. 大きさ
  let size: NormalizeResult["size"];
  try {
    const stored = await api.writeConfig(saved as never, "compressed");
    const bytes = Object.values(stored as Record<string, string>).reduce((n, v) => n + Buffer.byteLength(String(v), "utf8"), 0);
    // 内部番号（fieldno / tableno / tablepos）は設定画面が保存時に足す。pluginInfos と pluginFields の両方に入るので、1 項目あたり安全側に 80 バイト × 2 を上乗せして見積もる（Codex #8）
    const margin = needNumbers.length * 160;
    const max = (api.DEFAULT_LIMITS as { maxTotalBytes: number }).maxTotalBytes;
    size = { bytes, keys: Object.keys(stored as object).length };
    if (bytes + margin > max) {
      findings.error("size.limit", file, `保存値 ${bytes.toLocaleString()} バイト + 内部番号の見積もり ${margin.toLocaleString()} が上限 ${max.toLocaleString()} を超える（圧縮前の見積もり。設定画面の保存で止まる）`);
      return done();
    }
    findings.info("size.bytes", file, `保存値 ${bytes.toLocaleString()} バイト（${size.keys} キー。内部番号の見積もり +${margin.toLocaleString()}。上限 ${max.toLocaleString()}）`);
  } catch (e) {
    findings.error("size.limit", file, `保存値が大きすぎる: ${e instanceof Error ? e.message : String(e)}`);
    return done();
  }
  // 6. 出力（既定値を補った元の値。設定画面のダウンロードと同じ形）
  const body = api.toExportBody(saved as never, lang) as unknown as Record<string, unknown>;
  const meta = { pluginName: PLUGIN_NAME, pluginId: api.pluginId, pluginVersion: engine.source.pluginVersion, appId: fields.appId, appName: String(raw.appName ?? fields.appName) };
  const output = api.buildExportData(meta, body, (input.now ?? (() => new Date()))()) as unknown as Record<string, unknown>;
  let checkDiffs: string[] | undefined;
  if (input.check) {
    checkDiffs = [];
    const inBody = api.toExportBody({ ...api.normalizeSource(raw, lang, views.length ? (views as never) : undefined) } as unknown as Record<string, unknown>, lang) as unknown as Record<string, unknown>;
    jsonDiff(inBody, body, "$", checkDiffs);
  }
  return done({ output, saved, source: sourceRows, rows, pp: pp as Record<string, unknown>, size, checkDiffs, appId: appId as number });
}

/** 有向グラフの閉路（小さいグラフ向けの素朴な探索。同じ閉路は 1 回） */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  for (const start of graph.keys()) {
    const stack: Array<[string, string[]]> = [[start, [start]]];
    while (stack.length) {
      const [node, pathArr] = stack.pop()!;
      for (const next of graph.get(node) ?? []) {
        if (next === start) {
          const key = [...pathArr].sort().join("\u0000");
          if (!seen.has(key)) { seen.add(key); cycles.push([...pathArr]); }
        } else if (!pathArr.includes(next) && pathArr.length < 12) stack.push([next, [...pathArr, next]]);
      }
    }
  }
  return cycles;
}

export { contextTargetsOf, InputError };
