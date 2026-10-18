/**
 * ボタン（BUTTON / DIALOG）のクリックの模擬（計画 26 章。2026-10-18 Takashi「案 1 + 案 2」）。
 * デスクトップ formula1.js の buttonClick と同じ手順を Node で踏む:
 *   押す前の表示（式の返り値 = { TYPE, TITLE, HTML, ICON, SCAN, CSS … }）→ EV_SET("click", 1) → 式をもう一度評価（BUTTON / DIALOG は evInfo.click のときだけ
 *   FSET / FSET_TADD を実行してレコードの写しを変える）→ 全項目を再計算（calcRecord。実機の formulaFields）→ 押す前のレコードとの差（レコード全体。計算式の無い項目も）。
 *   - レコードは写し。kintone には何も送らない。実機の record.set の後の change イベントは起きない（デスクトップも skipEvent で抑えている）
 *   - EV_SET は tools が内部で呼ぶだけ（設定に入れられない規則は変えない）。副作用のある関数の policy の承認は normalize が確かめ済み（承認が無ければ calc / try に来ない）
 *   - クリック時の式の評価が失敗したら、実機と同じく何も変えない（エラーのダイアログ。record.set は呼ばれない）
 *   - 模擬できないもの: ボタンの見た目と位置、CSS、ダイアログの表示（HTML の見え方）。最後の確認は利用者が実機のテスト用アプリで押す（AI作業手順）
 */
import type { CalcEvent, Engine } from "../engine.ts";
import { quiet } from "../input.ts";
import type { CalcLine } from "./calc.ts";
import type { KintoneRecord } from "./record.ts";

/** クリックを模擬できる式の返り値の TYPE */
export const CLICK_TYPES: readonly string[] = ["BUTTON", "DIALOG"];

export interface ClickResult {
  /**
   * 押す前の表示（式の返り値）。BUTTON: TYPE / TITLE / CSS / DETAIL / EDIT、DIALOG: TYPE / TITLE / HTML / ICON / SCAN（キャンセルの有無）/ CSS。
   * ERROR_MESSAGE は CSS の解析の失敗。返り値がボタンでない・評価できないときは null（errors の display）
   */
  display: Record<string, unknown> | null;
  /** 押した後に変わる項目（FSET の直後の全項目の再計算を含む。押す前のレコードとの差。テーブルは行の配列。項目コード順）。変わらなければ空 */
  changes: CalcLine[];
  /** phases: display = 押す前の表示、click = クリック時の式の評価、top / table / 2nd … = 再計算の段、runtime = sink */
  errors: Array<{ fieldcode: string; phases: string[]; message: string }>;
  sinks: string[];
  /** 実行時の sink が呼ばれた = 結果を採らない */
  failed: boolean;
}

export interface ClickInput {
  engine: Engine;
  /** normalize の結果の保存値（pluginFields = 行、pluginPP = 計算に使う項目定義） */
  saved: { pluginFields: unknown; pluginPP: unknown };
  /** 型変換（PUT の形）に使う項目定義（normalize の pp） */
  typePP: unknown;
  /** 押す前のレコード（写しにして使う。呼ぶ側の値は変えない） */
  record: KintoneRecord;
  /** ボタンの行の項目コード（スペース項目は "(要素ID)"）と、その保存値の formula（コメントを除いたもの） */
  code: string;
  formula: string;
  evType: string;
  event?: CalcEvent;
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

const short = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : [...s].length > 80 ? [...s].slice(0, 80).join("") + "…" : s;
};

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 式の返り値がボタン（BUTTON / DIALOG）か */
export function isButtonDisplay(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && CLICK_TYPES.includes(String((v as Record<string, unknown>).TYPE));
}

/** 押す前の表示の 1 行の説明（BUTTON「加算」 / DIALOG「確認」 HTML "…" ICON question キャンセル あり） */
export function describeDisplay(d: Record<string, unknown> | null): string {
  if (!d) return "（表示なし）";
  const parts = [`${String(d.TYPE)}「${String(d.TITLE ?? "")}」`];
  if (d.TYPE === "DIALOG") {
    parts.push(`HTML ${short(d.HTML ?? "")}`);
    parts.push(`ICON ${String(d.ICON ?? "info")}`);
    parts.push(`キャンセル ${d.SCAN === false || d.SCAN === 0 || d.SCAN === "0" ? "なし" : "あり"}`);
  }
  if (d.DETAIL !== undefined) parts.push(`DETAIL ${String(d.DETAIL)}`);
  if (d.EDIT !== undefined) parts.push(`EDIT ${String(d.EDIT)}`);
  if (d.CSS !== undefined) parts.push(`CSS ${short(d.CSS)}`);
  if (d.ERROR_MESSAGE !== undefined) parts.push(`！ ${String(d.ERROR_MESSAGE)}`);
  return parts.join(" ");
}

/**
 * クリックの模擬。record は写して使う。sink の記録は呼ぶ側の記録と混ぜない（最初と最後に空にする）
 */
export function clickFormula(input: ClickInput): ClickResult {
  const { engine } = input;
  const api = engine.api;
  const before = structuredClone(input.record) as Record<string, { value?: unknown }>;
  const work = structuredClone(input.record);
  const errors: ClickResult["errors"] = [];
  engine.clearSinkCalls();
  const kf = api.createRunner(input.saved.pluginPP as never, work as never, input.evType, input.event as never) as unknown as { dq: (f: string) => unknown; initTableInfo: (t: string) => void };
  kf.initTableInfo("");
  let display: Record<string, unknown> | null = null;
  try {
    const v = plain(quiet(() => kf.dq(input.formula)));
    if (isButtonDisplay(v)) display = v;
    else errors.push({ fieldcode: input.code, phases: ["display"], message: `式の返り値がボタンでない（BUTTON / DIALOG の返り値 { TYPE, TITLE, … } でなく ${short(v)}）。クリックを模擬できない` });
  } catch (e) {
    errors.push({ fieldcode: input.code, phases: ["display"], message: messageOf(e) });
  }
  let clicked = false;
  if (display) {
    try {
      // 実機の buttonClick と同じ: 同じインスタンスで EV_SET("click", 1) → 式（BUTTON / DIALOG が FSET を実行する）
      quiet(() => kf.dq('EV_SET("click", 1)'));
      quiet(() => kf.dq(input.formula));
      clicked = true;
    } catch (e) {
      errors.push({ fieldcode: input.code, phases: ["click"], message: `クリック時の式の評価に失敗（実機ではエラーのダイアログが出て、レコードは変わらない）: ${messageOf(e)}` });
    }
    if (clicked) {
      // 全項目の再計算（実機の formulaFields。新しいインスタンスなので click は消えている = BUTTON の FSET は走らない）
      const r = quiet(() => api.calcRecord(input.saved.pluginFields as never, input.saved.pluginPP as never, work as never, { maxTableRows: api.BULK_MAX_TABLE_ROWS, evType: input.evType, event: input.event, typePP: input.typePP as never }));
      const byField = new Map<string, { fieldcode: string; phases: string[]; message: string }>();
      for (const e of r.errors) {
        const key = `${e.fieldcode}\u0000${e.message}`;
        const cur = byField.get(key) ?? { fieldcode: e.fieldcode || "(全体)", phases: [], message: e.message };
        cur.phases.push(e.rowIndex !== undefined ? `${e.phase}[${e.rowIndex}]` : e.phase);
        byField.set(key, cur);
      }
      errors.push(...byField.values());
    }
  }
  const sinks = engine.sinkCalls().map((s) => `${s.sink} ${s.detail}`.trim());
  engine.clearSinkCalls();
  const changes: CalcLine[] = [];
  if (clicked) {
    const after = work as Record<string, { value?: unknown }>;
    // 項目コード順（レコードのキーの順は取得の形に依るので揃えない）
    for (const code of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0))) {
      const b = plain(before[code]?.value);
      const a = plain(after[code]?.value);
      if (JSON.stringify(b) !== JSON.stringify(a)) changes.push({ fieldcode: code, before: b, after: a, changed: true, marks: [] });
    }
  }
  for (const sk of sinks) errors.push({ fieldcode: "(sink)", phases: ["runtime"], message: `実行時の sink が呼ばれた: ${sk}（走査で止められなかった副作用。この結果は採らない）` });
  return { display, changes, errors, sinks, failed: sinks.length > 0 };
}
