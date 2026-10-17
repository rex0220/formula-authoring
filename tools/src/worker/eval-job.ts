/**
 * Worker に渡す仕事と返す結果（構造化クローンで渡せる形だけ。関数やクラスは渡さない）。
 * normalize / calc の評価（zip のコードの実行）は Worker の中で行い、主スレッドは時間上限で terminate する（計画 7 章・11 章、Codex レビュー BLOCKER 1）。
 */
import type { FieldsFile } from "../commands/fields.ts";
import type { KintoneRecord } from "../commands/record.ts";
import type { Policy } from "../normalize/policy.ts";
import type { UsersOrigin, UsersSource } from "../users/index.ts";
import type { CalcEvent } from "../engine.ts";

export interface EvalJob {
  kind: "normalize" | "calc";
  /** 読み込み元（絶対パス。CLI が .env から決める） */
  pluginZip?: string;
  devPluginDir?: string;
  mode?: "build" | "dev";
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
    output?: Record<string, unknown>;
    checkDiffs?: string[];
  };
  calc?: {
    text: string;
    /** エラーか sink のあるレコードがある */
    failed: boolean;
  };
  /** エンジンの読み込みの注意 */
  engineWarnings: string[];
}

export type EvalMessage = { ok: true; outcome: EvalOutcome } | { ok: false; error: { name: string; message: string; code?: string } };
