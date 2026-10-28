/**
 * Worker に渡す仕事と返す結果（構造化クローンで渡せる形だけ。関数やクラスは渡さない）。
 * normalize / calc の評価（zip のコードの実行）は Worker の中で行い、主スレッドは時間上限で terminate する（計画 7 章・11 章、Codex レビュー BLOCKER 1）。
 * tools 0.2.0（MCP。計画 24 章）: 結果に findings と calc のレコードごとの行を足した（MCP が構造のまま返す。CLI は summary / text を使う）。vendorDir（moment の置き場所）
 * tools 0.3.0（計画 25 章）: kind "try"（同梱のサンプルアプリで式の試し計算。設定ファイル・項目定義は要らない）。結果の try
 * tools 0.4.0（計画 26 章）: calc.click（ボタンのクリックの模擬）、try の式の click
 * 項目検証（field-validation/docs/オーサリングツール_実装計画.md の段階 2）: kind "fv-normalize" / "fv-check"（項目検証の設定の検査と判定の模擬。式は計算式の zip のエンジン）
 */
import type { FieldsFile } from "../commands/fields.ts";
import type { KintoneRecord } from "../commands/record.ts";
import type { CalcRecordResult } from "../commands/calc.ts";
import type { Finding } from "../normalize/findings.ts";
import type { Policy } from "../normalize/policy.ts";
import type { UsersOrigin, UsersSource } from "../users/index.ts";
import type { CalcEvent } from "../engine.ts";
import type { TryFormula, TryResult } from "../commands/try.ts";
import type { TryData, TryFieldDef } from "../commands/try-data.ts";
import type { FvCheckResult } from "../fv/check.ts";

export interface EvalJob {
  kind: "normalize" | "calc" | "try" | "fv-normalize" | "fv-check";
  /** 読み込み元（絶対パス。CLI が .env から決める） */
  pluginZip?: string;
  devPluginDir?: string;
  mode?: "build" | "dev";
  /** moment（vendor/）の置き場所（省略すれば tools の vendor/。MCP は束ねた本体の隣） */
  vendorDir?: string;
  /** 接続先（検証済み。APP_URL などの元。無ければ既定） */
  baseUrl?: string;
  /** 設定と項目定義（normalize / calc。try では要らない） */
  settingsText?: string;
  settingsFile?: string;
  fields?: FieldsFile;
  usersSource: UsersSource;
  usersOrigin: UsersOrigin;
  policy: Policy;
  check?: boolean;
  lang?: "ja" | "en" | "zh";
  calc?: {
    appId: number;
    records: Array<{ id: string; record: KintoneRecord; fileAppId?: number; fileId?: number }>;
    evType?: string;
    event?: CalcEvent;
    mobile?: boolean;
    user?: string;
    /** ボタン（BUTTON / DIALOG）のクリックを模擬する行の項目コード（スペース項目は "(要素ID)"） */
    click?: string;
  };
  /** 項目検証の判定の模擬（kind "fv-check"。レコードごと・イベントごと） */
  fvCheck?: {
    appId: number;
    /** fileAppId / fileId はレコードのファイルの封筒の値（あれば appId と番号に合うか確かめる） */
    records: Array<{ id: string; record: KintoneRecord; fileAppId?: number; fileId?: number }>;
    events?: string[];
    user?: string;
    /** 印の無い項目も出す */
    all?: boolean;
  };
  /** 式の試し計算（kind "try"。サンプルアプリに 1 行だけの設定を組んで normalize + calc） */
  try?: {
    formulas: TryFormula[];
    /** 標本のレコードの番号（1〜3。省略は全部。data があるときの省略は無し） */
    records?: number[];
    /** 標本に足す項目（案 2）、架空の値のレコード（案 1）、その土台（1〜3）、利用者のアプリの項目定義（案 3） */
    fields?: TryFieldDef[];
    data?: TryData[];
    base?: number;
    appFields?: FieldsFile;
    evType?: string;
    event?: CalcEvent;
    mobile?: boolean;
    user?: string;
  };
}

export interface EvalOutcome {
  /** normalize の結果（try では式ごとの結果の集計: summary は試し計算の要約、hasErrors は ok でない式があるか、findings は空（式ごとの findings は try.results）） */
  normalize: {
    summary: string;
    hasErrors: boolean;
    warnings: number;
    /** 検査の結果（エラー / 警告 / 情報。MCP が返す） */
    findings: Finding[];
    output?: Record<string, unknown>;
    checkDiffs?: string[];
    /** 封筒の appId と、保存値の大きさの見積もり */
    appId?: number;
    size?: { bytes: number; keys: number };
  };
  calc?: {
    text: string;
    /** エラーか sink のあるレコードがある */
    failed: boolean;
    /** レコードごとの結果（項目ごとの前後の値。MCP が返す） */
    records: CalcRecordResult[];
    contextLine: string;
    notice: string;
    summary: string;
  };
  /** 式の試し計算の結果（kind "try"） */
  try?: TryResult;
  /** 項目検証の判定の模擬の結果（kind "fv-check"） */
  fvCheck?: FvCheckResult;
  /** エンジンの読み込みの注意 */
  engineWarnings: string[];
}

/**
 * Worker の中の誤りの種類（信頼できる境界 = 中核の eval-run.ts が instanceof で決める。zip のコードが name を偽装しても変わらない。Codex の r2 レビュー R1）:
 * input（中核の InputError）、zip（PluginZipError。code 付き）、users（UsersDataError）、policy（PolicyError）、other（zip のコードの例外など。文は信用しない）
 */
export type EvalErrorKind = "input" | "zip" | "users" | "policy" | "other";

export type EvalMessage = { ok: true; outcome: EvalOutcome } | { ok: false; error: { kind: EvalErrorKind; name: string; message: string; code?: string } };
