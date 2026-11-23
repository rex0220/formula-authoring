/**
 * 汎用のオーサリング（`./generic`）が扱うプラグインの表。
 * 設計は kintone-plugin の work-link/plugin-authoring-plan.md。計算式・項目検証・印刷屋・kSQL アクションはここには無い（それぞれの形のまま）。
 *
 * zip のコードを動かすのは、**プラグイン ID（PUBKEY から出る）がこの表にあり、SIGNATURE の検証に通った zip だけ**（zip.ts）。
 * プラグインを足すときは、ここに 1 つ書き、プラグインの zip に authoring API（plugin-config-kit の src/authoring.ts の契約）を載せる。
 */

/** プラグインの入口が API を置くグローバルの名前（plugin-config-kit の AUTHORING_GLOBAL と同じ） */
export const AUTHORING_GLOBAL = "rex0220PluginAuthoring";

export interface GenericPlugin {
  /** 表の名前（起動のときの指定、作業フォルダーのファイル名） */
  name: string;
  /** 利用者に見せる名前 */
  title: string;
  /** MCP のツールの名前の頭（`agg_check` など） */
  toolPrefix: string;
  /** kintone のプラグイン ID（PUBKEY の SHA-256 から。5 変種とも同じ鍵） */
  kintonePluginId: string;
  /** 設定の封筒の pluginID（authoring API の pluginId） */
  configPluginId: string;
  /** 扱う版の下限（manifest の version。authoring API を載せた版） */
  minPluginVersion: number;
  /** 対応する契約の版（authoring API の contractVersion） */
  contractVersions: readonly number[];
  /** zip の場所を書く環境変数（OS の環境変数か .env） */
  zipEnv: string;
  /** zip の中の、読む順のスクリプト（moment は tools の vendor/ を先に読む）。無ければ止める */
  scripts: readonly string[];
  /** authoring API の entry */
  apiEntry: string;
  /** 模擬（authoring API の simulate）がある製品。レコードを当てて確かめるツールを出す */
  simulate?: boolean;
  /**
   * 自アプリのプロセス管理の設定を読む製品（check.ts の fetchGenericStatus。動作テスト環境の GET）。
   * 検査・模擬に渡す項目定義の `own.status` に入る。印の無い製品では読まない
   */
  status?: boolean;
}

const AGGREGATE: GenericPlugin = {
  name: "aggregate",
  title: "アプリ集計",
  toolPrefix: "agg",
  kintonePluginId: "dnfmecefagpmheminfphakcfaoephohi",
  configPluginId: "rex0220 aggregate records plugin",
  minPluginVersion: 67,
  contractVersions: [1],
  zipEnv: "AGGREGATE_PLUGIN_ZIP",
  scripts: ["desktop_js/moment-timezone-with-data.min.js", "desktop_js/bignumber.min.js", "desktop_js/rex0220_decimal.min.js", "desktop_js/KintoneFormulaAggregate.min.js"],
  apiEntry: "config_js/aggregate-authoring-api.js"
};

/**
 * 項目書式（Ver.16〜）。authoring API の check が返す本体は「共通の設定 + pluginInfos」で、保存値そのものではない
 * （テーブルの書式に使う kintone の内部番号は設定画面の中からしか取れない。設定画面が取り込んで保存するときに作る）。模擬（simulate）あり
 */
const FIELD_FORMAT: GenericPlugin = {
  name: "field-format",
  title: "項目書式",
  toolPrefix: "ffmt",
  kintonePluginId: "oliedeaopbljhpcolhigchoocbfjkcdj",
  configPluginId: "rex0220 field format plugin",
  minPluginVersion: 16,
  contractVersions: [1],
  zipEnv: "FIELD_FORMAT_PLUGIN_ZIP",
  scripts: ["desktop_js/moment-timezone-with-data.min.js", "desktop_js/bignumber.min.js", "desktop_js/rex0220_decimal.min.js", "desktop_js/KintoneFormulaFormat.min.js"],
  apiEntry: "config_js/field-format-authoring-api.js",
  simulate: true
};

/**
 * 確認ダイアログ（Ver.6〜）。対象イベントの「プロセスアクション」は、アプリのプロセス管理のアクション（名前・元・先）で選ぶので、
 * 自アプリのプロセス管理を読む（status）。保存値の statusByLid（言語ごとの名前から既定の名称を引く表）も、そこから API が作る。
 * ユーザー情報のライブラリは読み込まない（UINFO などは使えない）。模擬（simulate）あり = レコードと場面を当てて、出るダイアログを確かめる
 */
const CONFIRM_DIALOG: GenericPlugin = {
  name: "confirm-dialog",
  title: "確認ダイアログ",
  toolPrefix: "cdlg",
  kintonePluginId: "bplhmcmehabodgedecoefphhapglkcem",
  configPluginId: "rex0220 Confirm dialog plugin",
  minPluginVersion: 6,
  contractVersions: [1],
  zipEnv: "CONFIRM_DIALOG_PLUGIN_ZIP",
  scripts: ["desktop_js/moment-timezone-with-data.min.js", "desktop_js/bignumber.min.js", "desktop_js/rex0220_decimal.min.js", "desktop_js/KintoneFormulaConfirmDialog.min.js"],
  apiEntry: "config_js/confirm-dialog-authoring-api.js",
  simulate: true,
  status: true
};

export const GENERIC_PLUGINS: Readonly<Record<string, GenericPlugin>> = { aggregate: AGGREGATE, "field-format": FIELD_FORMAT, "confirm-dialog": CONFIRM_DIALOG };

export class UnknownPluginError extends Error {}

export function genericPlugin(name: string): GenericPlugin {
  const p = Object.prototype.hasOwnProperty.call(GENERIC_PLUGINS, name) ? GENERIC_PLUGINS[name] : undefined;
  if (!p) throw new UnknownPluginError(`汎用のオーサリングが扱うプラグインではない: ${name}（扱うのは ${Object.keys(GENERIC_PLUGINS).join(", ")}）`);
  return p;
}
