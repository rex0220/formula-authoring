/**
 * Worker に渡す仕事と返す結果（構造化クローンで渡せる形だけ。関数やクラスは渡さない）。
 * normalize / calc の評価（zip のコードの実行）は Worker の中で行い、主スレッドは時間上限で terminate する（計画 7 章・11 章、Codex レビュー BLOCKER 1）。
 * tools 0.2.0（MCP。計画 24 章）: 結果に findings と calc のレコードごとの行を足した（MCP が構造のまま返す。CLI は summary / text を使う）。vendorDir（moment の置き場所）
 */
import type { FieldsFile } from "../commands/fields.ts";
import type { KintoneRecord } from "../commands/record.ts";
import type { CalcRecordResult } from "../commands/calc.ts";
import type { Finding } from "../normalize/findings.ts";
import type { Policy } from "../normalize/policy.ts";
import type { UsersOrigin, UsersSource } from "../users/index.ts";
import type { CalcEvent } from "../engine.ts";

export interface EvalJob {
  kind: "normalize" | "calc";
  /** 読み込み元（絶対パス。CLI が .env から決める） */
  pluginZip?: string;
  devPluginDir?: string;
  mode?: "build" | "dev";
  /** moment（vendor/）の置き場所（省略すれば tools の vendor/。MCP は束ねた本体の隣） */
  vendorDir?: string;
  /** 接続先（検証済み。APP_URL などの元。無ければ既定） */
  baseUrl?: string;
  settingsText: string;
  settingsFile: string;
  fields: FieldsFile;
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
  };
}

export interface EvalOutcome {
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
  /** エンジンの読み込みの注意 */
  engineWarnings: string[];
}

export type EvalMessage = { ok: true; outcome: EvalOutcome } | { ok: false; error: { name: string; message: string; code?: string } };
