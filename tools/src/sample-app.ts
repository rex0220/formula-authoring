/**
 * サンプルアプリ（計画 25 章。工程 8）: 全項目タイプ × 2、テーブル 2 つ、レコード 3 件（1 = 典型、2 = 端、3 = 空）を tools に埋め込む。
 * 元は開発用の kintone に作ったアプリ「計算式サンプル」。scripts/gen-sample-app.mjs が fields / record で取り、接続先・ユーザー・組織・グループ・作成者・更新者・日時を
 * 架空の値（既定のテストデータの demo_user01 など、https://example.cybozu.com、2026-01-15）に置き換えて src/sample-app/ に書いた（実在の値は無い）。
 * try（式の試し計算。commands/try.ts）が項目定義とレコードとして使う。利用者のアプリ・レコード・接続とは無関係（appId は元のアプリの番号のまま）。
 * JSON はビルドで束ねる（dist/ に入る。npm のパッケージに src/ は要らない）。宣言（dist/types）には JSON の型を出さない（FieldsFile / KintoneRecord で注釈する）
 */
import fieldsJson from "./sample-app/fields.json" with { type: "json" };
import record1 from "./sample-app/record-1.json" with { type: "json" };
import record2 from "./sample-app/record-2.json" with { type: "json" };
import record3 from "./sample-app/record-3.json" with { type: "json" };
import { listFields, summarizeFields, type FieldProperty, type FieldsFile } from "./commands/fields.ts";
import type { KintoneRecord } from "./commands/record.ts";

export interface SampleRecord {
  /** レコード番号（1〜3。try の records で選ぶ） */
  id: number;
  /** 何のレコードか（典型 / 端 / 空） */
  label: string;
  record: KintoneRecord;
}

export interface SampleApp {
  fields: FieldsFile;
  records: SampleRecord[];
}

const LABELS: Record<number, string> = {
  1: "典型（全項目に値）",
  2: "端（0・負の小数・改行・未選択・月末と年末の日付）",
  3: "空（ほぼ全部空）"
};

interface RecordJson {
  appId: number;
  id: number;
  record: KintoneRecord;
}

function sampleRecord(data: RecordJson, id: number): SampleRecord {
  if (data.appId !== (fieldsJson as { appId: number }).appId || data.id !== id || !data.record || typeof data.record !== "object") throw new Error(`サンプルレコード ${id} の形が違う（src/sample-app/record-${id}.json）`);
  return { id, label: LABELS[id] ?? "", record: data.record };
}

/** 埋め込んだサンプルアプリ（読むだけ。計算に使うときは sampleApp() の写しを使う） */
export const SAMPLE_APP: SampleApp = {
  fields: fieldsJson as unknown as FieldsFile,
  records: [sampleRecord(record1 as RecordJson, 1), sampleRecord(record2 as RecordJson, 2), sampleRecord(record3 as RecordJson, 3)]
};

/** サンプルアプリの写し（calc はレコードを書き換えるので、呼ぶたびに写す） */
export function sampleApp(): SampleApp {
  return structuredClone(SAMPLE_APP);
}

const tableRows = (record: KintoneRecord, code: string): number => {
  const v = record[code]?.value;
  return Array.isArray(v) ? v.length : 0;
};

/** サンプルアプリの説明（try --describe / fml_try の describe）: 項目（1 項目 1 行。○ = 計算式を設定できる型）とレコード 3 件の形 */
export function describeSampleApp(targetTypes?: ReadonlySet<string>): string {
  const { fields, records } = SAMPLE_APP;
  const tables = Object.values(fields.properties).filter((p: FieldProperty) => p.type === "SUBTABLE").map((p) => p.code).sort();
  const lines = [
    `サンプルアプリ「${fields.appName}」（try / fml_try の試し計算に使う架空のアプリ。接続先 ${fields.baseUrl}。利用者のアプリではない）`,
    summarizeFields(fields),
    "",
    "項目（1 項目 1 行。○ = 計算式を設定できる型。テーブルの子は T1_ / T2_ の接頭辞）:",
    listFields(fields, { targetTypes }),
    "",
    "レコード（try の records で選ぶ。既定は 3 件とも）:",
    ...records.map((r) => `  ${r.id}: ${r.label}。${tables.map((t) => `${t} ${tableRows(r.record, t)} 行`).join("、")}`),
    "ユーザー・組織・グループの値は既定のテストデータ（架空の 10 人。demo_user01 …）のコード"
  ];
  return lines.join("\n");
}
