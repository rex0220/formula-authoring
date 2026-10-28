/**
 * fv check <settings.json> --app N (--id R | --records R1,R2,…) [--event <名前>[,<名前>…]] [--lang ja|en|zh] [--user <code>] [--users <f>] [--all]
 * 取得済みのレコード（records/）に項目検証の設定を当てた判定の模擬（field-validation/docs/オーサリングツール_実装計画.md 6 章）。kintone は更新しない。
 * 先に fv normalize と同じ検査をして、エラーがあれば判定しない。式は計算式の zip のエンジンで評価する
 */
import { InputError } from "../input.ts";
import type { Engine } from "../engine.ts";
import type { FieldsFile } from "../commands/fields.ts";
import { contextTargetsOf } from "../commands/fields.ts";
import type { UsersInfoTable, UsersOrigin } from "../users/index.ts";
import { FV_JUDGE_DEFAULT_EVENT, fvJudgeRecord, type FvJudgeResult, type FvJudgement, type FvLang } from "./judge.ts";
import type { FvNormalizeResult } from "./normalize.ts";

/** 受けるイベント名（項目検証が式に渡すもの。change は項目コードを付ける。一覧の編集は付けなくてもよい） */
export const FV_EVENT_RE = /^(mobile\.)?app\.record\.(create|edit)\.(show|submit|change\.[^\s.]+)$|^(mobile\.)?app\.record\.index\.edit\.(submit|change(\.[^\s.]+)?)$|^(mobile\.)?app\.record\.detail\.show$/;
export const FV_CHECK_RECORDS_MAX = 100;
export const FV_CHECK_EVENTS_MAX = 6;

export interface FvCheckInput {
  normalized: FvNormalizeResult;
  engine: Engine;
  fields: FieldsFile;
  appId: number;
  records: Array<{ id: string; record: Record<string, unknown> }>;
  events?: string[];
  lang?: FvLang;
  user?: string;
  usersInfo: UsersInfoTable | null;
  usersOrigin: UsersOrigin;
  /** 印の無い項目も出す */
  all?: boolean;
}

export interface FvCheckLine {
  /** 項目コード（テーブルの子は "テーブル[行].子"、行のボタンは "テーブル[行] 行の追加" など） */
  field: string;
  hidden: boolean;
  disabled: boolean;
  required: boolean;
  errors: string[];
  reset?: FvJudgement["reset"];
}
export interface FvCheckRecord {
  id: string;
  events: Array<{ event: string; ok: boolean; lines: FvCheckLine[] }>;
}
export interface FvCheckResult {
  text: string;
  records: FvCheckRecord[];
  contextLine: string;
  notice: string;
  /** 誤り（文）のあるレコード・イベントがある */
  failed: boolean;
}

export function validateFvEvents(list: string[] | undefined): string[] {
  const events = list && list.length ? list : [FV_JUDGE_DEFAULT_EVENT];
  if (events.length > FV_CHECK_EVENTS_MAX) throw new InputError(`--event は ${FV_CHECK_EVENTS_MAX} つまで`);
  for (const e of events) if (!FV_EVENT_RE.test(e)) throw new InputError(`イベント名が違う: ${e}（例 app.record.create.show、app.record.edit.change.<項目コード>、app.record.edit.submit、app.record.index.edit.submit。mobile. を前に付けられる）`);
  return events;
}

const BUTTON_LABEL: Record<string, string> = { $ADD_BUTTON: "行の追加", $DEL_BUTTON: "行の削除" };

/** 判定の結果を行に（印のあるものだけ。all なら全部） */
export function linesOf(r: FvJudgeResult, all: boolean): FvCheckLine[] {
  const out: FvCheckLine[] = [];
  const add = (field: string, j: FvJudgement | { hidden: boolean }): void => {
    const line: FvCheckLine = { field, hidden: j.hidden, disabled: "disabled" in j ? j.disabled : false, required: "required" in j ? j.required : false, errors: "errors" in j ? [...j.errors] : [] };
    if ("reset" in j && j.reset) line.reset = j.reset;
    if (all || line.hidden || line.disabled || line.required || line.errors.length || line.reset) out.push(line);
  };
  for (const [code, j] of Object.entries(r.fields)) add(code, j);
  for (const [table, lines] of Object.entries(r.tables)) {
    lines.forEach((cells, i) => {
      for (const [code, j] of Object.entries(cells)) add(code in BUTTON_LABEL ? `${table}[${i + 1}] ${BUTTON_LABEL[code]}` : `${table}[${i + 1}].${code}`, j);
    });
  }
  return out;
}

export function renderFvLine(l: FvCheckLine): string {
  const marks = [l.hidden ? "非表示" : "", l.disabled ? "入力不可" : "", l.required ? "必須" : ""].filter(Boolean);
  const parts = [marks.length ? marks.join("・") : "（印なし）"];
  if (l.errors.length) parts.push(`誤り「${l.errors.join("」「")}」`);
  if (l.reset) parts.push(`保存の前に ${l.reset.lookup === "CLEAR" ? "ルックアップを解除して " : ""}${"value" in l.reset ? JSON.stringify(l.reset.value) : ""} を入れる`.trim());
  return `${l.field}: ${parts.join("、")}`;
}

export function fvCheckSettings(input: FvCheckInput): FvCheckResult {
  const { normalized, engine } = input;
  if (!normalized.saved) throw new InputError("fv normalize のエラーがあるので判定しない");
  if (input.records.length > FV_CHECK_RECORDS_MAX) throw new InputError(`レコードは 1 回 ${FV_CHECK_RECORDS_MAX} 件まで`);
  const events = validateFvEvents(input.events);
  const lang: FvLang = input.lang ?? "ja";
  const wantUser = input.user ?? "authoring";
  const found = input.usersInfo && input.usersInfo.userCodes[wantUser];
  if (input.user && !found) throw new InputError(`--user ${input.user} が${input.usersOrigin.kind === "file" ? input.usersOrigin.file : "既定のテストデータ"}に居ない`);
  const loginUser = found
    ? { id: String(found.id), code: String(found.code), name: String(found.name ?? ""), email: String(found.email ?? ""), timezone: String(found.timezone ?? "Asia/Tokyo"), language: String(found.locale ?? "ja"), isGuest: false }
    : null;
  const targets = contextTargetsOf(input.fields.properties);
  const saved = normalized.saved as { pluginFields: never[]; pluginPP: unknown };
  const usersLabel = !input.usersInfo ? "なし" : input.usersOrigin.kind === "file" ? input.usersOrigin.file : "既定のテストデータ（架空）";
  const contextLine = `文脈: アプリ ${input.appId}、ログインユーザー ${loginUser ? loginUser.code : "指定なし（番兵）"}、言語 ${lang}、イベント ${events.join(" / ")}、ユーザー情報 ${usersLabel}`;
  const notice = "更新していません（判定の模擬）。項目検証の一覧編集向けの判定と同じ規則で、レコードの画面とは、必須の未入力を常に文に出す・テーブルの子の隠れたルックアップも解除する・グループは出さない、の 3 点が違います。画面への反映（枠線の色、グループの開閉）と、値の変更の後の再検査の順は模擬しません。";
  const records: FvCheckRecord[] = [];
  for (const { id, record } of input.records) {
    const rec: FvCheckRecord = { id, events: [] };
    for (const event of events) {
      // 文脈は runner を作る前に（コンストラクターが読む）。mobile はイベント名から
      engine.setContext({ appId: input.appId, mobile: event.startsWith("mobile."), loginUser, lookupTargets: targets.lookupTargets, relatedTargets: targets.relatedTargets, usersInfo: input.usersInfo, usersOrigin: input.usersOrigin });
      const r = fvJudgeRecord(engine, saved, record, { type: event, lang });
      rec.events.push({ event, ok: r.ok, lines: linesOf(r, !!input.all) });
    }
    records.push(rec);
  }
  const failed = records.some((r) => r.events.some((e) => !e.ok));
  const text: string[] = [notice, contextLine];
  for (const r of records) {
    for (const e of r.events) {
      const n = e.lines.filter((l) => l.errors.length).length;
      text.push(`レコード ${r.id}（${e.event}）: ${e.ok ? "誤りなし" : `誤り ${n} 項目`}${e.lines.length ? "" : "（印のある項目なし）"}`);
      for (const l of e.lines) text.push(`  ${renderFvLine(l)}`);
    }
  }
  return { text: text.join("\n"), records, contextLine, notice, failed };
}
