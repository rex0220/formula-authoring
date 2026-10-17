/**
 * fields --app N [--lang ja] [--preview] [--guest S] [--out fields/<file>]
 * 項目定義（/k/v1/app/form/fields の properties）、レイアウト（/k/v1/app/form/layout）、アプリ名（/k/v1/app）、取れれば一覧（/k/v1/app/views。
 * アプリ管理の権限が無ければ省く）を 1 つの JSON に保存する。設定画面は preview の API を読む（formula の load.ts）ので --preview で同じ API に切り替えられる。
 * normalize / calc はこのファイルから pp と、ダミー層の context（ルックアップ先・関連レコード一覧の先のアプリ番号）を作る。
 * print-craft-authoring の commands/fields.ts が元（関連レコード一覧の参照先の項目定義は取らない。計算式では要らない）
 */
import type { RestClient } from "../kintone-rest.ts";

export interface FieldProperty {
  type: string;
  code: string;
  label: string;
  fields?: Record<string, FieldProperty>;
  [key: string]: unknown;
}

export interface LayoutRow {
  type?: string;
  code?: string;
  fields?: Array<{ type?: string; code?: string; [key: string]: unknown }>;
  layout?: LayoutRow[];
  [key: string]: unknown;
}

/** fields/<app>.json の形 */
export interface FieldsFile {
  tool: "formula-authoring fields";
  fetchedAt: string;
  baseUrl: string;
  appId: number;
  appName: string;
  guestSpaceId?: number;
  preview: boolean;
  lang: string;
  revision: string;
  properties: Record<string, FieldProperty>;
  layout: LayoutRow[];
  /** 一覧（/k/v1/app/views。一覧別設定の ID の検査に使う。取れなければ無い） */
  views?: Record<string, { id: string; name: string; index: string; type?: string }>;
  /** 一覧を取れなかった理由 */
  viewsNote?: string;
}

export interface FieldsOptions {
  app: number;
  lang?: string;
  preview?: boolean;
  guestSpaceId?: number;
  now?: () => Date;
}

export interface ReferenceTableRef {
  code: string;
  label: string;
  /** 参照先のアプリ。参照先を見る権限が無いと referenceTable が null で返るので null */
  app: number | null;
}

/** 関連レコード一覧の項目（本体だけ。テーブルの中には置けない） */
export function referenceTablesOf(properties: Record<string, FieldProperty>): ReferenceTableRef[] {
  const out: ReferenceTableRef[] = [];
  for (const p of Object.values(properties)) {
    if (!p || p.type !== "REFERENCE_TABLE") continue;
    const rt = p.referenceTable as { relatedApp?: { app?: string } } | null | undefined;
    const app = rt && typeof rt === "object" ? Number(rt.relatedApp?.app) : NaN;
    out.push({ code: p.code, label: p.label, app: Number.isInteger(app) && app > 0 ? app : null });
  }
  return out;
}

export async function fetchFields(client: RestClient, opt: FieldsOptions): Promise<FieldsFile> {
  const lang = opt.lang ?? "ja";
  const app = await client.get<{ appId: string; name: string }>("app", { id: opt.app }, opt.guestSpaceId);
  const fields = await client.get<{ properties: Record<string, FieldProperty>; revision: string }>(opt.preview ? "preview/app/form/fields" : "app/form/fields", { app: opt.app, lang }, opt.guestSpaceId);
  const layout = await client.get<{ layout: LayoutRow[]; revision: string }>(opt.preview ? "preview/app/form/layout" : "app/form/layout", { app: opt.app }, opt.guestSpaceId);
  const properties = fields.properties ?? {};
  let views: FieldsFile["views"] | undefined;
  let viewsNote: string | undefined;
  try {
    const v = await client.get<{ views?: FieldsFile["views"] }>(opt.preview ? "preview/app/views" : "app/views", { app: opt.app, lang }, opt.guestSpaceId);
    views = v.views ?? {};
  } catch (e) {
    viewsNote = `一覧を取れない（アプリ管理の権限が要る）: ${e instanceof Error ? e.message : String(e)}`;
  }
  return {
    tool: "formula-authoring fields",
    fetchedAt: (opt.now ?? (() => new Date()))().toISOString(),
    baseUrl: client.baseUrl,
    appId: Number(app.appId),
    appName: app.name,
    ...(opt.guestSpaceId ? { guestSpaceId: opt.guestSpaceId } : {}),
    preview: !!opt.preview,
    lang,
    revision: String(fields.revision ?? layout.revision ?? ""),
    properties,
    layout: layout.layout ?? [],
    ...(views ? { views } : {}),
    ...(viewsNote ? { viewsNote } : {})
  };
}

/** レイアウトの順の項目コード（テーブルとグループは自身のコード。テーブルの子は含めない）と、テーブルごとの子の順（左から右。計算順と同じ） */
function layoutOrder(layout: LayoutRow[]): { order: string[]; tableChildren: Map<string, string[]> } {
  const order: string[] = [];
  const tableChildren = new Map<string, string[]>();
  const walk = (rows: LayoutRow[] | undefined): void => {
    for (const r of rows ?? []) {
      if (r.type === "GROUP") {
        if (r.code) order.push(r.code);
        walk(r.layout);
      } else if (r.type === "SUBTABLE") {
        if (r.code) {
          order.push(r.code);
          tableChildren.set(r.code, (r.fields ?? []).map((f) => f.code).filter((c): c is string => !!c));
        }
      } else {
        for (const f of r.fields ?? []) if (f.code) order.push(f.code);
      }
    }
  };
  walk(layout);
  return { order, tableChildren };
}

/** テーブルの子をレイアウトの順（左から右）に。レイアウトに無い子は後ろに properties の順で */
function orderedChildren(table: FieldProperty, inLayout: readonly string[] | undefined): FieldProperty[] {
  const children = table.fields ?? {};
  const seen = new Set<string>();
  const out: FieldProperty[] = [];
  for (const code of inLayout ?? []) {
    const c = children[code];
    if (c && !seen.has(code)) { out.push(c); seen.add(code); }
  }
  for (const c of Object.values(children)) if (!seen.has(c.code)) out.push(c);
  return out;
}

const SELECT_TYPES = new Set(["CHECK_BOX", "RADIO_BUTTON", "DROP_DOWN", "MULTI_SELECT"]);

/** 計算式を書くのに要る属性（書式・単位・選択肢・ルックアップ・関連レコード）。無ければ "" */
function fieldNotes(p: FieldProperty, inTable: boolean, copyTargets: Set<string>): string {
  const notes: string[] = [];
  if (p.type === "CALC" && typeof p.format === "string") notes.push(`書式 ${p.format}`);
  if (p.type === "SINGLE_LINE_TEXT" && typeof p.expression === "string" && p.expression) notes.push("自動計算");
  if (p.type === "NUMBER" || p.type === "CALC") {
    if (p.digit === true) notes.push("桁区切り");
    if (p.displayScale !== undefined && p.displayScale !== "") notes.push(`小数 ${p.displayScale} 桁`);
    if (typeof p.unit === "string" && p.unit) notes.push(`単位「${p.unit}」${p.unitPosition === "BEFORE" ? "前" : "後"}`);
  }
  if (SELECT_TYPES.has(p.type) && p.options && typeof p.options === "object") {
    const labels = Object.values(p.options as Record<string, { label: string; index: string }>)
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map((o) => o.label);
    notes.push(`選択肢 ${labels.slice(0, 8).join(" / ")}${labels.length > 8 ? ` 他 ${labels.length - 8}` : ""}`);
  }
  const lookup = p.lookup as { relatedApp?: { app?: string }; relatedKeyField?: string } | null | undefined;
  if (lookup && typeof lookup === "object") notes.push(`ルックアップ（アプリ ${lookup.relatedApp?.app ?? "?"} の ${lookup.relatedKeyField ?? "?"}）`);
  if (copyTargets.has(p.code)) notes.push("ルックアップのコピー先");
  if (p.type === "REFERENCE_TABLE") {
    const rt = p.referenceTable as { relatedApp?: { app?: string } } | null | undefined;
    notes.push(`関連レコード一覧（アプリ ${rt?.relatedApp?.app ?? "?"}）`);
  }
  return notes.length ? `（${notes.join("、")}）` : "";
}

/** ダミー層の context に入れる、ルックアップ先と関連レコード一覧の先のアプリ番号（fieldcode → app）。参照する権限が無いものは入れない */
export function contextTargetsOf(properties: Record<string, FieldProperty>): { lookupTargets: Record<string, number>; relatedTargets: Record<string, number> } {
  const lookupTargets: Record<string, number> = {};
  const relatedTargets: Record<string, number> = {};
  const walk = (p: FieldProperty): void => {
    const lookup = p.lookup as { relatedApp?: { app?: string } } | null | undefined;
    const app = lookup && typeof lookup === "object" ? Number(lookup.relatedApp?.app) : NaN;
    if (Number.isInteger(app) && app > 0) lookupTargets[p.code] = app;
    if (p.type === "REFERENCE_TABLE") {
      const rt = p.referenceTable as { relatedApp?: { app?: string } } | null | undefined;
      const rapp = rt && typeof rt === "object" ? Number(rt.relatedApp?.app) : NaN;
      if (Number.isInteger(rapp) && rapp > 0) relatedTargets[p.code] = rapp;
    }
    for (const c of Object.values(p.fields ?? {})) walk(c);
  };
  for (const p of Object.values(properties)) walk(p);
  return { lookupTargets, relatedTargets };
}

/**
 * fields --summary: 取得済みの fields/<app>.json を 1 項目 1 行で（レイアウトの順。テーブルの子は字下げ。通信しない）。
 * AI が項目定義の JSON を丸ごと読まずに済むように（2026-10-05、試用の納品書の計測で AI が node -e で同じ要約を作っていた）。
 * 関連レコード一覧（Ver.8）は参照先の項目を `親$子` の名前で字下げして出す（取れていなければ理由）
 */
export function listFields(file: FieldsFile, opt: { targetTypes?: ReadonlySet<string> } = {}): string {
  const props = file.properties;
  const copyTargets = new Set<string>();
  const collect = (p: FieldProperty): void => {
    const maps = (p.lookup as { fieldMappings?: Array<{ field?: string }> } | null | undefined)?.fieldMappings;
    for (const m of maps ?? []) if (m.field) copyTargets.add(m.field);
    for (const c of Object.values(p.fields ?? {})) collect(c);
  };
  for (const p of Object.values(props)) collect(p);
  const mark = (p: FieldProperty): string => (opt.targetTypes ? (opt.targetTypes.has(p.type) ? "  ○" : "  －") : "");
  const line = (p: FieldProperty, indent: string, inTable: boolean): string => `${indent}${p.code}${p.label && p.label !== p.code ? `「${p.label}」` : ""}  ${p.type}${mark(p)}${fieldNotes(p, inTable, copyTargets)}`;
  const lines: string[] = [];
  const shown = new Set<string>();
  const { order, tableChildren } = layoutOrder(file.layout);
  for (const code of order) {
    const p = props[code];
    if (!p || shown.has(code)) continue;
    shown.add(code);
    lines.push(line(p, "", false));
    // テーブルの子はレイアウトの順（左から右 = ランクなしの計算順）。properties の順ではない（4 回目の試用の準備で見つけた）
    if (p.type === "SUBTABLE") for (const c of orderedChildren(p, tableChildren.get(code))) lines.push(line(c, "  ", true));
  }
  const rest = Object.values(props).filter((p) => !shown.has(p.code));
  const header = `アプリ ${file.appId} ${file.appName}（${file.preview ? "preview" : "運用中"}、lang=${file.lang}、取得 ${file.fetchedAt}）項目 ${Object.keys(props).length}。レイアウトの順、テーブルの子は字下げ${opt.targetTypes ? "。○ = 計算式を設定できる型、－ = できない型" : ""}${file.views ? `。一覧 ${Object.keys(file.views).length}` : file.viewsNote ? `。${file.viewsNote}` : ""}`;
  const tail = rest.length ? [`レイアウトに無い項目: ${rest.map((p) => `${p.code} ${p.type}`).join(", ")}`] : [];
  return [header, ...lines, ...tail].join("\n");
}

/** 画面に出す要約（項目の数と型。値は無い） */
export function summarizeFields(file: FieldsFile): string {
  const props = Object.values(file.properties);
  const tables = props.filter((p) => p.type === "SUBTABLE");
  const refs = props.filter((p) => p.type === "REFERENCE_TABLE");
  const views = file.views ? `一覧 ${Object.keys(file.views).length}（${Object.values(file.views).sort((x, y) => Number(x.index) - Number(y.index)).map((v) => `${v.id} ${v.name}`).slice(0, 10).join(", ")}${Object.keys(file.views).length > 10 ? " …" : ""}）` : file.viewsNote ?? "";
  const byType = new Map<string, number>();
  for (const p of props) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ");
  const tableLines = tables.map((t) => `  テーブル ${t.code}: ${Object.keys(t.fields ?? {}).join(", ")}`);
  const relatedLines = refs.map((r) => {
    const rt = r.referenceTable as { relatedApp?: { app?: string } } | null | undefined;
    return `  関連レコード一覧 ${r.code}: 参照先 アプリ ${rt?.relatedApp?.app ?? "?"}`;
  });
  return [`アプリ ${file.appId} ${file.appName}（${file.preview ? "preview" : "運用中"}、lang=${file.lang}）`, `項目 ${props.length}（${types}）`, ...tableLines, ...relatedLines, ...(views ? [views] : [])].join("\n");
}
