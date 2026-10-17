/**
 * fields --app N [--lang ja] [--preview] [--guest S] [--out fields/<file>]
 * 項目定義（/k/v1/app/form/fields の properties）、レイアウト（/k/v1/app/form/layout）、アプリ名（/k/v1/app）を 1 つの JSON に保存する。
 * 設定画面は preview の API を読む（load.ts 204 / 209 行）ので --preview で同じ API に切り替えられる（既定は運用中の形。
 * preview は API トークンでは呼べないことがある）。normalize / preview はこのファイルから pp と更新項目の一覧を作る。
 * 印刷屋 Ver.8（authoring API 3）: 関連レコード一覧（REFERENCE_TABLE）の参照先の項目定義も取り、`related` に**生のまま**入れる（運用環境の
 * /k/v1/app/form/fields。仮のテーブル `親$子` への展開は印刷屋の zip の expandRelatedFields に任せる。print-craft の docs/related-records-spec.md 11.3）。
 * API トークンの接続では参照先のアプリのトークンが要る（tokenMap）。取れなかった関連レコード一覧は relatedNotes に理由を残す
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

/** 関連レコード一覧の参照先の項目定義（fields.json の related。生のまま） */
export interface RelatedFields {
  app: number;
  appName: string;
  revision: string;
  properties: Record<string, FieldProperty>;
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
  /** 関連レコード一覧の親コード → 参照先の項目定義（Ver.8。取れたものだけ。無ければ旧版の fields か、関連レコード一覧の無いアプリ） */
  related?: Record<string, RelatedFields>;
  /** 参照先の項目定義を取れなかった関連レコード一覧（「親コード: 理由」） */
  relatedNotes?: string[];
}

export interface FieldsOptions {
  app: number;
  lang?: string;
  preview?: boolean;
  guestSpaceId?: number;
  now?: () => Date;
  /** 参照先のアプリの接続（API トークンの接続ではアプリごとにトークンが違う。tokenMap に無ければ例外 → relatedNotes）。無ければ同じ接続で取る */
  relatedClientFor?: (app: number) => RestClient;
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

/** 参照先の項目定義を取る（運用環境。アプリごとに 1 回。失敗は relatedNotes に） */
async function fetchRelated(client: RestClient, properties: Record<string, FieldProperty>, opt: FieldsOptions, lang: string): Promise<Pick<FieldsFile, "related" | "relatedNotes">> {
  const refs = referenceTablesOf(properties);
  if (refs.length === 0) return {};
  const related: Record<string, RelatedFields> = {};
  const relatedNotes: string[] = [];
  const byApp = new Map<number, Promise<RelatedFields>>();
  for (const ref of refs) {
    if (ref.app === null) {
      relatedNotes.push(`${ref.code}: 参照先のアプリを参照する権限が無い（referenceTable が null。この関連レコード一覧は帳票の計算式で使えない）`);
      continue;
    }
    const app = ref.app;
    let p = byApp.get(app);
    if (!p) {
      p = (async (): Promise<RelatedFields> => {
        const c = opt.relatedClientFor ? opt.relatedClientFor(app) : client;
        const a = await c.get<{ appId: string; name: string }>("app", { id: app }, opt.guestSpaceId);
        const f = await c.get<{ properties: Record<string, FieldProperty>; revision: string }>("app/form/fields", { app, lang }, opt.guestSpaceId);
        return { app, appName: a.name, revision: String(f.revision ?? ""), properties: f.properties ?? {} };
      })();
      byApp.set(app, p);
    }
    try {
      related[ref.code] = await p;
    } catch (e) {
      relatedNotes.push(`${ref.code}: 参照先（アプリ ${app}）の項目定義を取れない: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { related, relatedNotes };
}

export async function fetchFields(client: RestClient, opt: FieldsOptions): Promise<FieldsFile> {
  const lang = opt.lang ?? "ja";
  const app = await client.get<{ appId: string; name: string }>("app", { id: opt.app }, opt.guestSpaceId);
  const fields = await client.get<{ properties: Record<string, FieldProperty>; revision: string }>(opt.preview ? "preview/app/form/fields" : "app/form/fields", { app: opt.app, lang }, opt.guestSpaceId);
  const layout = await client.get<{ layout: LayoutRow[]; revision: string }>(opt.preview ? "preview/app/form/layout" : "app/form/layout", { app: opt.app }, opt.guestSpaceId);
  const properties = fields.properties ?? {};
  const related = await fetchRelated(client, properties, opt, lang);
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
    ...related
  };
}

/** レイアウトの順の項目コード（テーブルとグループは自身のコード。テーブルの子は含めない） */
function layoutOrder(layout: LayoutRow[]): string[] {
  const out: string[] = [];
  const walk = (rows: LayoutRow[] | undefined): void => {
    for (const r of rows ?? []) {
      if (r.type === "GROUP") {
        if (r.code) out.push(r.code);
        walk(r.layout);
      } else if (r.type === "SUBTABLE") {
        if (r.code) out.push(r.code);
      } else {
        for (const f of r.fields ?? []) if (f.code) out.push(f.code);
      }
    }
  };
  walk(layout);
  return out;
}

const SELECT_TYPES = new Set(["CHECK_BOX", "RADIO_BUTTON", "DROP_DOWN", "MULTI_SELECT"]);
/** 要約に出さない参照先の項目（値を持たない型。仮の子にするかは印刷屋の zip の RELATED_CHILD_TYPES が決める。これは表示だけ） */
const NOT_A_VALUE = new Set(["SUBTABLE", "REFERENCE_TABLE", "GROUP", "LABEL", "SPACER", "HR", "CATEGORY"]);

/** 帳票と計算式を書くのに要る属性（書式・単位・選択肢・ルックアップ）。無ければ "" */
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
  if (p.type === "FILE" && !inTable) notes.push("保存先 filecode にできる");
  return notes.length ? `（${notes.join("、")}）` : "";
}

/** 関連レコード一覧の設定の要約（条件・絞り込み・並び） */
function referenceTableNotes(p: FieldProperty): string {
  const rt = p.referenceTable as { relatedApp?: { app?: string }; condition?: { field?: string; relatedField?: string }; filterCond?: string; sort?: string } | null | undefined;
  if (!rt || typeof rt !== "object") return "";
  const parts = [`条件 ${rt.condition?.field ?? "?"} = 参照先の ${rt.condition?.relatedField ?? "?"}`];
  if (rt.filterCond) parts.push(`絞り込み ${rt.filterCond}`);
  if (rt.sort) parts.push(`並び ${rt.sort}`);
  return `（${parts.join("、")}）`;
}

/**
 * fields --summary: 取得済みの fields/<app>.json を 1 項目 1 行で（レイアウトの順。テーブルの子は字下げ。通信しない）。
 * AI が項目定義の JSON を丸ごと読まずに済むように（2026-10-05、試用の納品書の計測で AI が node -e で同じ要約を作っていた）。
 * 関連レコード一覧（Ver.8）は参照先の項目を `親$子` の名前で字下げして出す（取れていなければ理由）
 */
export function listFields(file: FieldsFile): string {
  const props = file.properties;
  const copyTargets = new Set<string>();
  const collect = (p: FieldProperty): void => {
    const maps = (p.lookup as { fieldMappings?: Array<{ field?: string }> } | null | undefined)?.fieldMappings;
    for (const m of maps ?? []) if (m.field) copyTargets.add(m.field);
    for (const c of Object.values(p.fields ?? {})) collect(c);
  };
  for (const p of Object.values(props)) collect(p);
  const line = (p: FieldProperty, indent: string, inTable: boolean): string => `${indent}${p.code}${p.label && p.label !== p.code ? `「${p.label}」` : ""}  ${p.type}${fieldNotes(p, inTable, copyTargets)}`;
  const relatedLines = (p: FieldProperty): string[] => {
    const r = file.related?.[p.code];
    if (!r) {
      const note = (file.relatedNotes ?? []).find((n) => n.startsWith(`${p.code}: `));
      return [`  → 関連レコード: 参照先の項目定義なし${note ? `（${note.slice(p.code.length + 2)}）` : "（旧版の fields。fields を取り直す）"}`];
    }
    const out = [`  → 関連レコード（アプリ ${r.app} ${r.appName}）${referenceTableNotes(p)}。計算式では ${p.code}$<参照先の項目コード>（テーブルと同じ関数。1 行目・一覧用では使えない）`];
    for (const c of Object.values(r.properties)) {
      if (NOT_A_VALUE.has(c.type)) continue;
      if ((c.type === "STATUS" || c.type === "STATUS_ASSIGNEE") && !(c.enabled === true || c.enabled === "true")) continue;
      out.push(line({ ...c, code: `${p.code}$${c.code}` }, "  ", true));
    }
    return out;
  };
  const lines: string[] = [];
  const shown = new Set<string>();
  for (const code of layoutOrder(file.layout)) {
    const p = props[code];
    if (!p || shown.has(code)) continue;
    shown.add(code);
    lines.push(line(p, "", false));
    if (p.type === "SUBTABLE") for (const c of Object.values(p.fields ?? {})) lines.push(line(c, "  ", true));
    if (p.type === "REFERENCE_TABLE") lines.push(...relatedLines(p));
  }
  const rest = Object.values(props).filter((p) => !shown.has(p.code));
  const header = `アプリ ${file.appId} ${file.appName}（${file.preview ? "preview" : "運用中"}、lang=${file.lang}、取得 ${file.fetchedAt}）項目 ${Object.keys(props).length}。レイアウトの順、テーブルの子は字下げ（TABLE_HTML と計算式で使う。更新項目にはできない）`;
  const tail = rest.length ? [`レイアウトに無い項目: ${rest.map((p) => `${p.code} ${p.type}`).join(", ")}`] : [];
  return [header, ...lines, ...tail].join("\n");
}

/** 画面に出す要約（項目の数と型。値は無い） */
export function summarizeFields(file: FieldsFile): string {
  const props = Object.values(file.properties);
  const tables = props.filter((p) => p.type === "SUBTABLE");
  const refs = props.filter((p) => p.type === "REFERENCE_TABLE");
  const byType = new Map<string, number>();
  for (const p of props) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ");
  const tableLines = tables.map((t) => `  テーブル ${t.code}: ${Object.keys(t.fields ?? {}).join(", ")}`);
  const relatedLines = refs.map((r) => {
    const rel = file.related?.[r.code];
    return rel ? `  関連レコード一覧 ${r.code}: 参照先 アプリ ${rel.app} ${rel.appName}（項目 ${Object.keys(rel.properties).length}）` : `  関連レコード一覧 ${r.code}: 参照先の項目定義なし`;
  });
  return [`アプリ ${file.appId} ${file.appName}（${file.preview ? "preview" : "運用中"}、lang=${file.lang}）`, `項目 ${props.length}（${types}）`, ...tableLines, ...relatedLines, ...(file.relatedNotes ?? []).map((n) => `  注意: ${n}`)].join("\n");
}
