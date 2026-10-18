/**
 * 中核の入口（@rex0220/formula-authoring-tools/core。formula MCP が使う）。cli.ts と dev-paths.ts は含めない（環境変数と process.cwd を読むのは CLI だけ）。
 * 工程 0（2026-10-17）: 読み込み（engine）、ダミー層（context）、ユーザー情報のテストデータ、zip の読み込み、安全なパス、接続。
 * tools 0.2.0（計画 24.4。CORE_API_VERSION 2）: 作業フォルダーとアプリのフォルダー（workspace）、接続のファイル（connections）、kintone/ の下の許可（permission）、
 * ファイルの確定とロック（commit-file）、take、保存の約束（save: saveNewSettings / updateFields）、users の参照するコードの取得、JSON の誤りの文、行のキー
 */
export const CORE_API_VERSION = 2;

export { createContext, type WorkContext } from "./context.ts";
export { PathError, WRITE_ROOTS, isInside, realResolve, resolveRead, resolveWrite, resolveWriteDir, safeFileName } from "./safe-path.ts";
export { FORMULA_PLUGIN_ID, FORMULA_CONFIG_PLUGIN_ID, MIN_PLUGIN_VERSION, SUPPORTED_API_VERSIONS, REQUIRED_API, isSupportedPluginVersion, schemaRevisionOf, toolsMeta, type ToolsMeta } from "./meta.ts";
export {
  DEFAULT_CONTEXT_BASE_URL, SENTINEL_USER, loadEngine, momentFileOf, resolvePluginSources,
  type CalcEvent, type Engine, type EngineContext, type EngineSource, type FormulaAuthoringApi, type FormulaInstance, type LoadEngineOptions, type LoginUser, type SinkCall
} from "./engine.ts";
export { PluginZipError, pluginIdOf, readPluginZip, type PluginSources, type PluginZipErrorCode, type PluginZipErrorInfo } from "./plugin-zip.ts";
export { DEFAULT_USERS, UsersDataError, buildUsersInfo, defaultUsersInfo, summarizeUsers, validateUsersSource, type UsersInfoTable, type UsersOrigin, type UsersSource } from "./users/index.ts";
export { AuthError, baseUrlFromEnv, describeAuth, kintoneConfigPath, loadAuth, loadUserApiAuth, pluginZipPath, unquote, type KintoneAuth, type LoadAuthOptions } from "./env.ts";
export { KintoneUrlError, isKintoneBaseUrl, normalizeKintoneBaseUrl } from "./kintone-url.ts";
export { InputError, MAX_INPUT_BYTES, PLUGIN_NAME, formatDate, jsonDiff, readFieldsFile, readJsonLimited, readTextLimited, relativeSettingsPath } from "./input.ts";
export { jsonErrorText, jsonErrorWhere } from "./json-error.ts";
export { ALLOWED_APIS, ALLOWED_USER_APIS, NotAllowedError, RECEIVE_LIMITS, RestError, createRestClient, type AllowedApi, type AllowedUserApi, type FetchLike, type RestClient } from "./kintone-rest.ts";
export { scanFormula, scanFormulas, type ScanResult } from "./scan.ts";
export { contextTargetsOf, fetchFields, listFields, referenceTablesOf, summarizeFields, type FieldProperty, type FieldsFile, type FieldsOptions, type LayoutRow } from "./commands/fields.ts";
export { describeRecord, fetchRecord, narrowRecord, shapeLines, summarizeRecord, usedFieldCodes, type KintoneRecord, type RecordFile, type RecordOptions } from "./commands/record.ts";
export { LIST_LIMIT, QUERY_MAX, QueryError, SHAPE_TEXT_MAX, listQueryOf, listRecordShapes, type RecordShape, type RecordShapes } from "./commands/records.ts";
export { defaultPullName, pullSettings, type PullOptions, type PullResult } from "./commands/pull.ts";
export { bodyOf, rowsOf, summarizeSettings, type Envelope, type SourceRow } from "./commands/summary.ts";
export { diffSettings, type DiffResult, type FieldChange } from "./commands/diff.ts";
export {
  DEFAULT_MAX_CALLS, USER_INFO_FUNCTIONS, UsersPullError, pullReferencedUsers, pullUsers, referencedCodesOf, scanUserInfoCalls, usersFileNameOf, type PullUsersOptions, type ReferencedCodes
} from "./commands/users.ts";
export { normalizeSettings, findCycles, stronglyConnected, type ContextNeeds, type NormalizeInput, type NormalizeResult } from "./commands/normalize.ts";
export { DEFAULT_EVENT, EVENT_RE, RECORDS_MAX, calcSettings, validateEvent, type CalcInput, type CalcLine, type CalcRecordResult, type CalcResult } from "./commands/calc.ts";
export { takeInbox, type TakeResult } from "./commands/take.ts";
export {
  COMMON_KEYS, MAX_SAVE_INPUT_BYTES, MAX_UPDATE_ROWS, connectionStatusOf, digestOf, saveNewSettings, updateFields, type EvalSource, type SaveContext, type SaveResult, type SaveStatus
} from "./commands/save.ts";
export { DEFAULT_POLICY, POLICY_FILE, PolicyError, loadPolicy, parsePolicy, type Policy } from "./normalize/policy.ts";
export { Findings, type Finding, type Level } from "./normalize/findings.ts";
export { ENVELOPE_KEYS, OUTER_KEYS, ROW_SCREEN_KEYS, ROW_SOURCE_KEYS, materialsOf, viewsOf, type FormulaSaved, type FormulaSource, type Lang } from "./normalize/model.ts";
export { DEFAULT_TIMEOUT_SEC, EvalError, EvalTimeoutError, MAX_TIMEOUT_SEC, runEval, type RunOptions } from "./worker/run.ts";
export { builtinErrorName, classifyEvalError, runEvalJob } from "./worker/eval-run.ts";
export type { EvalErrorKind, EvalJob, EvalMessage, EvalOutcome } from "./worker/eval-job.ts";
// 作業フォルダーとアプリのフォルダー（workspace）、接続のファイル（connections）、kintone/ の下の許可（permission）、ファイルの確定とロック（commit-file）
export {
  APP_MARKER, EDIT_RE, INBOX, KINTONE_ROOT, LEGACY_WORKSPACE_FILE, SNAPSHOT_PREFIX, SNAPSHOT_RE, WorkspaceError,
  appDirFor, appFolderOfFile, appFoldersOf, assertAppMark, assertInsideWorkspace, assertUsableInKintone, editNameOf, ensureAppFolder, findAppDir, folderNameOf,
  hasLegacyConfig, legacyBlockedError, listAppFolder, markOf, modeOf, profileDirOf, readAppMark, requireProfiles, snapshotNameOf, unusedProfileDirs,
  type AppFolderList, type AppMark, type AppMarkState, type ModeOptions, type ProfilesContext, type WorkspaceMode
} from "./workspace.ts";
export {
  CONNECTION_MAX_BYTES, ConnectionError, FALLBACK_PROFILE, PROFILE_NAME_RE, assertSameConnection, authFor, identityOf, loadConnections, pickProfile, sameIdentity, semanticDigest,
  snapshotOf, userApiAuthFor, type ConnectionErrorCode, type ConnectionSet, type ConnectionSnapshot, type Env, type LoadConnectionsOptions, type ProfileDef, type ProfileIdentity
} from "./connections.ts";
export { PermissionError, assertChangeAllowed, classOfAppPath, type ChangeOp, type TargetClass } from "./permission.ts";
export {
  FileExistsError, LOCK_STALE_MS, LockBusyError, acquireLock, cleanupAll, lockPathFor, placeNew, tempPathFor, withRetry, writeNewFile, type Lock, type WriteNewResult
} from "./commit-file.ts";
