/**
 * 中核の入口（@rex0220/formula-authoring-tools/core。後の MCP が使う）。cli.ts と dev-paths.ts は含めない（環境変数と process.cwd を読むのは CLI だけ）。
 * 工程 0（2026-10-17）: 読み込み（engine）、ダミー層（context）、ユーザー情報のテストデータ、zip の読み込み、安全なパス、接続。コマンドは工程 1 以降で足す
 */
export const CORE_API_VERSION = 1;

export { createContext, type WorkContext } from "./context.ts";
export { PathError, WRITE_ROOTS, isInside, realResolve, resolveRead, resolveWrite } from "./safe-path.ts";
export { FORMULA_PLUGIN_ID, MIN_PLUGIN_VERSION, SUPPORTED_API_VERSIONS, REQUIRED_API, isSupportedPluginVersion, schemaRevisionOf, toolsMeta, type ToolsMeta } from "./meta.ts";
export {
  DEFAULT_CONTEXT_BASE_URL, SENTINEL_USER, loadEngine, resolvePluginSources,
  type CalcEvent, type Engine, type EngineContext, type EngineSource, type FormulaAuthoringApi, type FormulaInstance, type LoadEngineOptions, type LoginUser, type SinkCall
} from "./engine.ts";
export { PluginZipError, pluginIdOf, readPluginZip, type PluginSources, type PluginZipErrorCode, type PluginZipErrorInfo } from "./plugin-zip.ts";
export { DEFAULT_USERS, UsersDataError, buildUsersInfo, defaultUsersInfo, summarizeUsers, validateUsersSource, type UsersInfoTable, type UsersOrigin, type UsersSource } from "./users/index.ts";
export { AuthError, baseUrlFromEnv, describeAuth, kintoneConfigPath, loadAuth, pluginZipPath, unquote, type KintoneAuth, type LoadAuthOptions } from "./env.ts";
export { KintoneUrlError, isKintoneBaseUrl, normalizeKintoneBaseUrl } from "./kintone-url.ts";
export { InputError, MAX_INPUT_BYTES, PLUGIN_NAME, formatDate, jsonDiff, readFieldsFile, readJsonLimited, readTextLimited, relativeSettingsPath } from "./input.ts";
export { ALLOWED_APIS, ALLOWED_USER_APIS, NotAllowedError, RECEIVE_LIMITS, RestError, createRestClient, type AllowedApi, type AllowedUserApi, type FetchLike, type RestClient } from "./kintone-rest.ts";
export { scanFormula, scanFormulas, type ScanResult } from "./scan.ts";
export { contextTargetsOf, fetchFields, listFields, referenceTablesOf, summarizeFields, type FieldProperty, type FieldsFile, type FieldsOptions, type LayoutRow } from "./commands/fields.ts";
export { describeRecord, fetchRecord, narrowRecord, shapeLines, summarizeRecord, usedFieldCodes, type KintoneRecord, type RecordFile, type RecordOptions } from "./commands/record.ts";
export { LIST_LIMIT, QUERY_MAX, QueryError, SHAPE_TEXT_MAX, listQueryOf, listRecordShapes, type RecordShape, type RecordShapes } from "./commands/records.ts";
export { defaultPullName, pullSettings, type PullOptions, type PullResult } from "./commands/pull.ts";
export { bodyOf, rowsOf, summarizeSettings, type Envelope, type SourceRow } from "./commands/summary.ts";
export { diffSettings, type DiffResult, type FieldChange } from "./commands/diff.ts";
export { DEFAULT_MAX_CALLS, UsersPullError, pullUsers, usersFileNameOf, type PullUsersOptions } from "./commands/users.ts";
