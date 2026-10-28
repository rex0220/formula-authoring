/**
 * 項目検証プラグイン（rex0220 field validation）の設定を扱うための決まり（field-validation/docs/オーサリングツール_実装計画.md 7 章）。
 * 項目検証の zip は読まない。式は計算式プラグインの zip のエンジンで評価する（項目検証の同梱のエンジンは計算式のものの名前を変えた写し）。
 */

/** 封筒の pluginID（設定画面のダウンロードの識別子） */
export const FV_CONFIG_PLUGIN_ID = "rex0220 field validation plugin";
/** kintone のプラグイン ID（5 変種とも同じ鍵） */
export const FV_PLUGIN_ID = "iciolillbpdfcppoeibhnpfbhmbghkbo";
/** 扱う項目検証の版の下限（取り込み方「全置換 / 項目の置換」と元の値の形が Ver.72 から） */
export const FV_MIN_VERSION = 72;
/** 項目検証の式の評価に使う計算式の zip の版の下限（2026-10-28 Takashi「計算式 v102 以降、項目検証 v72 以降が対象。多少違っても問題ない」） */
export const FV_MIN_FORMULA_VERSION = 102;

/** 設定画面のダウンロードの名前（kit の exportFileName。名前はそのまま置く） */
export const FV_SNAPSHOT_PREFIX = "rex0220-field-validation";
export const FV_SNAPSHOT_RE = /^rex0220-field-validation-app(\d+)-(\d{8})-(\d{6})\.json$/;
export const FV_EDIT_RE = /^rex0220-field-validation-app(\d+)-(\d{8})-(\d{6})-edit\.json$/;

/**
 * 項目検証の版 → 同梱のエンジン。engineSha256 は同じ中身の計算式の zip の desktop_js/KintoneFormula.min.js（名前を戻すと 1 バイトも違わない。2026-10-28 段階 0 で確かめた）。
 * 計算式の zip のエンジンが違えば、評価は続けて情報 engine.differs で知らせる
 */
export const FV_ENGINES: ReadonlyArray<{ fvVersion: number; formulaVersion: number; engineSha256: string }> = [
  { fvVersion: 72, formulaVersion: 102, engineSha256: "023c3504afd44f70ddbcba5929806889beaaedba33f597c74d95be076d5c5230" }
];

/** 項目検証の版に同梱のエンジン（表の中で、その版以下の一番新しい行） */
export function engineOfFv(fvVersion: number): (typeof FV_ENGINES)[number] | undefined {
  return [...FV_ENGINES].filter((e) => e.fvVersion <= fvVersion).sort((a, b) => b.fvVersion - a.fvVersion)[0];
}

/**
 * 項目検証では使わない更新系の関数（2026-10-28 Takashi「TLTABLE のような更新系の関数は項目検証で利用しない」）。
 * 副作用のある関数（計算式の FUNCTION_TAGS.sideEffect）と、テーブルの値を返す関数（エンジンの説明文で確かめた 5 つ。TPDIC などはその引数の補助）
 */
export const FV_TABLE_PRODUCERS: readonly string[] = ["TLTABLE", "TABLE_SORT", "TABLE_MAP", "TABLE_DATA", "CSV_TVAL"];

export function fvUpdateFunctions(sideEffect: readonly string[]): Set<string> {
  return new Set([...sideEffect, ...FV_TABLE_PRODUCERS]);
}
