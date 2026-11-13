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

export const GENERIC_PLUGINS: Readonly<Record<string, GenericPlugin>> = { aggregate: AGGREGATE };

export class UnknownPluginError extends Error {}

export function genericPlugin(name: string): GenericPlugin {
  const p = Object.prototype.hasOwnProperty.call(GENERIC_PLUGINS, name) ? GENERIC_PLUGINS[name] : undefined;
  if (!p) throw new UnknownPluginError(`汎用のオーサリングが扱うプラグインではない: ${name}（扱うのは ${Object.keys(GENERIC_PLUGINS).join(", ")}）`);
  return p;
}
