/**
 * テストの共通: fixture の zip（formula の dist の Ver.101 以降の zip。隣のリポジトリから）と engine の読み込み。
 * 1 プロセスで読める zip は 1 つなので、engine のテストは同じ zip を使う。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { devPluginZip, FORMULA_ROOT } from "../src/dev-paths.ts";

export const PLUGIN_ZIP = devPluginZip() ?? path.join(FORMULA_ROOT, "dist", "formula-plugin101.zip");
const engineModule = await import(pathToFileURL(path.join(import.meta.dirname, "..", "src", "engine.ts")).href);
export const loadEngine = (opt = {}) => engineModule.loadEngine({ pluginZip: PLUGIN_ZIP, mode: "dev", ...opt });
export const SENTINEL_USER = engineModule.SENTINEL_USER;
