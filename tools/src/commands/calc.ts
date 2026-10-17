/**
 * calc <settings.json> --app N (--id R | --records R1,R2,…) [--fields fields/N.json] [--users <f>] [--user <code>] [--event <種別>] [--action --status --next-status] [--mobile]
 * 設定を 1 件以上のレコード（records/ の取得済みファイル）に当てて、計算式プラグインの calcRecord（既存レコードを変更と同じ 3 段の計算）で「このレコードはこう計算される」を見せる模擬。
 * **レコードは更新しない。** 画面のイベントの処理（値変更の順、非同期計算、テーブルの行数制御の途中）の完全な再現ではない（オーサリングツール_実装計画.md 7 章）。
 * 文脈（ログインユーザー / アプリ番号 / mobile / ルックアップ先 / ユーザー情報 / イベント）はダミー層から与え、表の先頭に出す。
 */
import type { CalcEvent, Engine } from "../engine.ts";
import { InputError, quiet } from "../input.ts";
import type { FieldsFile } from "./fields.ts";
import { contextTargetsOf } from "./fields.ts";
import type { KintoneRecord } from "./record.ts";
import type { NormalizeResult } from "./normalize.ts";
import type { UsersInfoTable, UsersOrigin } from "../users/index.ts";

/** 評価するイベント（完全な名前。Codex レビュー #7）。allUpdate = 設定画面の既存レコードを変更、batch = 一覧の一括計算 */
export const EVENT_RE = /^(mobile\.)?app\.record\.(create|edit|index\.edit)\.(show|submit|submit\.success|change\.[^\s.]+)$|^(mobile\.)?app\.record\.detail\.show$|^(mobile\.)?app\.record\.detail\.process\.proceed$|^allUpdate$|^batch$/;
export const DEFAULT_EVENT = "allUpdate";
export const RECORDS_MAX = 100;

export interface CalcInput {
  normalized: NormalizeResult;
  engine: Engine;
  fields: FieldsFile;
  appId: number;
  records: Array<{ id: string; record: KintoneRecord }>;
  evType?: string;
  event?: CalcEvent;
  mobile?: boolean;
  /** ログインユーザーのコード（usersInfo に居ること）。無ければ既定 authoring、それも居なければ番兵 */
  user?: string;
  usersInfo: UsersInfoTable | null;
  usersOrigin: UsersOrigin | { kind: "none" };
}

export interface CalcLine {
  fieldcode: string;
  before: unknown;
  after: unknown;
  changed: boolean;
  marks: string[];
}

export interface CalcRecordResult {
  id: string;
  lines: CalcLine[];
  changed: number;
  errors: Array<{ fieldcode: string; phases: string[]; message: string }>;
  sinks: string[];
}

export interface CalcResult {
  contextLine: string;
  notice: string;
  records: CalcRecordResult[];
  /** 複数のときの要約 */
  summary: string;
  text: string;
}

export function validateEvent(ev: string | undefined, event: Partial<CalcEvent> | undefined): { evType: string; event?: CalcEvent } {
  const evType = ev ?? DEFAULT_EVENT;
  if (!EVENT_RE.test(evType)) throw new InputError(`--event の種別が違う: ${evType}（app.record.create.show / app.record.edit.change.<項目コード> / app.record.detail.process.proceed / mobile.… / allUpdate / batch）`);
  const proceed = /process\.proceed$/.test(evType);
  if (proceed) {
    const e: CalcEvent = { action: { value: event?.action?.value ?? "" }, status: { value: event?.status?.value ?? "" }, nextStatus: { value: event?.nextStatus?.value ?? "" } };
    return { evType, event: e };
  }
  if (event && (event.action || event.status || event.nextStatus)) throw new InputError("--action / --status / --next-status は --event app.record.detail.process.proceed のときだけ");
  return { evType };
}

type TableRows = Array<{ id?: string; value: Record<string, { value?: unknown }> }>;
const isTable = (v: unknown): v is TableRows => Array.isArray(v) && v.every((r) => r && typeof r === "object" && "value" in (r as object));

const short = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : [...s].length > 60 ? [...s].slice(0, 60).join("") + "…" : s;
};

export function calcSettings(input: CalcInput): CalcResult {
  const { engine, normalized, fields } = input;
  const api = engine.api;
  const saved = normalized.saved;
  const pp = normalized.pp;
  if (!saved || !pp) throw new InputError("normalize でエラーがあるので calc できない");
  if (input.records.length > RECORDS_MAX) throw new InputError(`calc は 1 回 ${RECORDS_MAX} 件まで`);
  const { evType, event } = validateEvent(input.evType, input.event);
  const tags = api.FUNCTION_TAGS as Record<string, readonly string[]>;
  // 文脈
  const targets = contextTargetsOf(fields.properties);
  const userInfoOn = (saved.pluginMiscInfo as Record<string, unknown>).userInfo !== false;
  // UINFO 系が読む表は「ユーザー情報」ON のときだけ。ログインユーザー（LOGIN_* / EV_INFO）は OFF でもテストデータから決める
  const table = userInfoOn ? input.usersInfo : null;
  const wantUser = input.user ?? "authoring";
  const found = input.usersInfo && input.usersInfo.userCodes[wantUser];
  if (input.user && !found) throw new InputError(`--user ${input.user} が${input.usersOrigin.kind === "file" ? input.usersOrigin.file : "既定のテストデータ"}に居ない`);
  const loginUser = found
    ? { id: String(found.id), code: String(found.code), name: String(found.name ?? ""), email: String(found.email ?? ""), timezone: String(found.timezone ?? "Asia/Tokyo"), language: String(found.locale ?? "ja"), isGuest: false }
    : null;
  engine.setContext({ appId: input.appId, mobile: !!input.mobile, loginUser, lookupTargets: targets.lookupTargets, relatedTargets: targets.relatedTargets, usersInfo: table, usersOrigin: table ? input.usersOrigin : { kind: "none" } });
  const usersLabel = !table ? (userInfoOn ? "なし" : "各種設定「ユーザー情報」OFF") : input.usersOrigin.kind === "file" ? input.usersOrigin.file : "既定のテストデータ（架空）";
  const contextLine = `文脈: アプリ ${input.appId}、ログインユーザー ${loginUser ? loginUser.code : "指定なし（番兵）"}、mobile ${input.mobile ? "true" : "false"}、イベント ${evType}${event ? `（${event.action.value} / ${event.status.value} → ${event.nextStatus.value}）` : ""}、ユーザー情報 ${usersLabel}、ルックアップ先 ${Object.keys(targets.lookupTargets).length}、関連レコード一覧の先 ${Object.keys(targets.relatedTargets).length}`;
  const notice = `更新していません（模擬）。EV_INFO の文脈を与えた 3 段（項目 → テーブルの行 → 2 段目）の計算で、${evType === "allUpdate" ? "設定画面の「既存レコードを変更」の文脈" : evType === "batch" ? "一覧の「一括計算」の文脈" : "画面のイベントの処理の完全な再現ではありません"}。`;
  // 印（走査の分類）
  const markOf = (fieldcode: string): string[] => {
    const scan = normalized.scans.get(fieldcode);
    if (!scan) return [];
    const used = Object.keys(scan.functions);
    const marks: string[] = [];
    if (used.some((f) => tags.userInfo.includes(f))) marks.push(`ユーザー情報は ${usersLabel}${loginUser ? ` のユーザー ${loginUser.code}` : ""} で計算（実機では変わる）`);
    if (used.some((f) => tags.event.includes(f))) marks.push("イベントに依る");
    if (used.some((f) => tags.volatile.includes(f))) marks.push("再計算で変わる");
    if (used.some((f) => tags.kintoneContext.includes(f))) marks.push("kintone の文脈（ダミー層の値）");
    if (used.some((f) => tags.sideEffect.includes(f))) marks.push("副作用（policy で承認済み）");
    return marks;
  };
  const results: CalcRecordResult[] = [];
  for (const { id, record } of input.records) {
    const clone = structuredClone(record);
    engine.clearSinkCalls();
    const r = quiet(() => api.calcRecord(saved.pluginFields as never, saved.pluginPP as never, clone as never, { maxTableRows: api.BULK_MAX_TABLE_ROWS, evType, event, typePP: pp as never }));
    const lines: CalcLine[] = [];
    for (const code of Object.keys(r.after)) {
      const b = (r.before as Record<string, { value?: unknown }>)[code]?.value;
      const a = (r.after as Record<string, { value?: unknown }>)[code]?.value;
      lines.push({ fieldcode: code, before: b, after: a, changed: JSON.stringify(b) !== JSON.stringify(a), marks: markOf(code) });
    }
    const byField = new Map<string, { fieldcode: string; phases: string[]; message: string }>();
    for (const e of r.errors) {
      const key = `${e.fieldcode}\u0000${e.message}`;
      const cur = byField.get(key) ?? { fieldcode: e.fieldcode || "(全体)", phases: [], message: e.message };
      cur.phases.push(e.rowIndex !== undefined ? `${e.phase}[${e.rowIndex}]` : e.phase);
      byField.set(key, cur);
    }
    results.push({ id, lines, changed: lines.filter((l) => l.changed).length, errors: [...byField.values()], sinks: engine.sinkCalls().map((s) => `${s.sink} ${s.detail}`.trim()) });
  }
  engine.clearSinkCalls();
  const text: string[] = [notice, contextLine];
  for (const res of results) {
    text.push(`レコード ${res.id}: 計算対象 ${res.lines.length} 項目、変わる ${res.changed}${res.errors.length ? `、エラー ${res.errors.length}` : ""}`);
    for (const l of res.lines) {
      const marks = l.marks.length ? `  [${l.marks.join("、")}]` : "";
      if (isTable(l.before) && isTable(l.after)) {
        // テーブルは行ごと・子の項目ごとの差だけ（値の JSON を丸ごと出さない）
        const rows = Math.max(l.before.length, l.after.length);
        text.push(`  ${l.changed ? "★" : "　"} ${l.fieldcode}: テーブル ${l.before.length} 行 → ${l.after.length} 行${marks}`);
        for (let i = 0; i < rows; i++) {
          const bv = l.before[i]?.value ?? {};
          const av = l.after[i]?.value ?? {};
          const cells = [...new Set([...Object.keys(bv), ...Object.keys(av)])].filter((c) => JSON.stringify(bv[c]?.value) !== JSON.stringify(av[c]?.value)).map((c) => `${c} ${short(bv[c]?.value)} → ${short(av[c]?.value)}`);
          if (cells.length) text.push(`      行 ${i + 1}: ${cells.join("、")}`);
        }
        continue;
      }
      text.push(`  ${l.changed ? "★" : "　"} ${l.fieldcode}: ${short(l.before)} → ${short(l.after)}${marks}`);
    }
    for (const e of res.errors) text.push(`  ！ ${e.fieldcode}（${e.phases.join(", ")}）: ${e.message}`);
    for (const s of res.sinks) text.push(`  ！ 実行時の sink が呼ばれた: ${s}（tools は拒否した）`);
  }
  let summary = "";
  if (results.length > 1) {
    const changedRecords = results.filter((r) => r.changed > 0).length;
    const changedFields = new Set(results.flatMap((r) => r.lines.filter((l) => l.changed).map((l) => l.fieldcode)));
    summary = `入力した ${results.length} 件中 ${changedRecords} 件の模擬差分。変わる項目: ${[...changedFields].join(", ") || "なし"}（この件数は入力したレコードとこの文脈でのもの。アプリ全体の件数ではない）`;
    text.push(summary);
  }
  return { contextLine, notice, records: results, summary, text: text.join("\n") };
}
