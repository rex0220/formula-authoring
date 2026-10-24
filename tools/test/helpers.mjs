/**
 * テストの共通: fixture の zip（formula の dist の Ver.101 以降の zip。隣のリポジトリから）と engine の読み込み。
 * 1 プロセスで読める zip は 1 つなので、engine のテストは同じ zip を使う。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { devPluginZip, FORMULA_ROOT } from "../src/dev-paths.ts";
import { readPluginZip } from "../src/plugin-zip.ts";

export const PLUGIN_ZIP = devPluginZip() ?? path.join(FORMULA_ROOT, "dist", "formula-plugin101.zip");
/** fixture の zip の manifest の版（"101"、"102" …）。版を書き込んだ試験にしない（zip を新しい版にしても通るように。2026-10-24 Takashi「OK」） */
export const PLUGIN_VERSION = existsSync(PLUGIN_ZIP) ? readPluginZip(PLUGIN_ZIP).pluginVersion : "";
const engineModule = await import(pathToFileURL(path.join(import.meta.dirname, "..", "src", "engine.ts")).href);
export const loadEngine = (opt = {}) => engineModule.loadEngine({ pluginZip: PLUGIN_ZIP, mode: "dev", ...opt });
export const SENTINEL_USER = engineModule.SENTINEL_USER;
