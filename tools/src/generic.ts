/**
 * 汎用のオーサリングの入口（`@rex0220/formula-authoring-tools/generic`）。
 * 計算式エンジンを使うプラグインのうち、authoring API の契約（plugin-config-kit の src/authoring.ts）を zip に載せたものを扱う。
 * 設計は kintone-plugin の work-link/plugin-authoring-plan.md。計算式・項目検証の入口（`./core`）とは別で、`./core` の出口と動きは変えていない。
 */
/** この入口の版。出口の形を変えるときに上げる（MCP が互換表で見る） */
export const GENERIC_API_VERSION = 1;

export { AUTHORING_GLOBAL, GENERIC_PLUGINS, UnknownPluginError, genericPlugin, type GenericPlugin } from "./generic/registry.ts";
export { GenericZipError, readGenericZip, type GenericZipErrorCode, type GenericZipSources } from "./generic/zip.ts";
export { GENERIC_METHODS, GenericPluginError, classifyGenericError, runGenericJob, type GenericDescribe, type GenericErrorKind, type GenericJob, type GenericMessage, type GenericMethod } from "./generic/host.ts";
export { GENERIC_DEFAULT_TIMEOUT_SEC, GENERIC_MAX_TIMEOUT_SEC, GenericCallError, GenericTimeoutError, callGeneric, type GenericRunOptions } from "./generic/run.ts";
export {
  SourceError, addRow, assertSource, canonicalJson, diffSource, digestOfJson, getRow, moveRow, patchCommon, patchRow, removeRow, renderDiff, renumber, setRow, summarizeSource,
  type GenericSource, type GenericSourceRow, type SourceDiff
} from "./generic/source.ts";
export {
  GENERIC_MAX_APPS, GenericDefsError, checkSource, checkWithDefs, fetchGenericDefs,
  type FetchDefsOptions, type GenericAppDefs, type GenericCaller, type GenericCheckResult, type GenericDefs, type GenericIssue
} from "./generic/check.ts";
export {
  GENERIC_MAX_FILE_BYTES, GenericFileError, SOURCE_FILE_KIND, digestOfText, importFileName, listWorkFiles, readSourceFile, readWorkText, renderSourceFile, resolveWorkFile,
  saveNewImportFile, saveNewSourceFile, updateSourceFile,
  type GenericFileStatus, type ReadSourceResult, type SourceFile, type WorkFileInfo, type WriteResult
} from "./generic/files.ts";
