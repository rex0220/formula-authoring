/**
 * 中核の入口（@rex0220/formula-authoring-tools/core。formula MCP が使う）。cli.ts と dev-paths.ts は含めない（環境変数と process.cwd を読むのは CLI だけ）。
 * 工程 0（2026-10-17）: 読み込み（engine）、ダミー層（context）、ユーザー情報のテストデータ、zip の読み込み、安全なパス、接続。
 * tools 0.2.0（計画 24.4。CORE_API_VERSION 2）: 作業フォルダーとアプリのフォルダー（workspace）、接続のファイル（connections）、kintone/ の下の許可（permission）、
 * ファイルの確定とロック（commit-file）、take、保存の約束（save: saveNewSettings / updateFields）、users の参照するコードの取得、JSON の誤りの文、行のキー
 * tools 0.3.0（計画 25 章。CORE_API_VERSION は 2 のまま = 足しただけ）: 同梱のサンプルアプリ（sample-app）と式の試し計算（try: trySettings。評価の仕事の kind "try"）
 * tools 0.4.0（計画 26 章。2 のまま）: ボタンのクリックの模擬（click: clickFormula。calc の click、try の式の click）
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
export { diffSettings, isDisplayRow, type DiffResult, type FieldChange } from "./commands/diff.ts";
export {
  DEFAULT_MAX_CALLS, USER_INFO_FUNCTIONS, UsersPullError, pullReferencedUsers, pullUsers, referencedCodesOf, scanUserInfoCalls, usersFileNameOf, type PullUsersOptions, type ReferencedCodes
} from "./commands/users.ts";
export { normalizeSettings, findCycles, stronglyConnected, type ContextNeeds, type NormalizeInput, type NormalizeResult } from "./commands/normalize.ts";
export { DEFAULT_EVENT, EVENT_RE, RECORDS_MAX, calcSettings, renderClick, renderLine, validateEvent, type CalcInput, type CalcLine, type CalcRecordResult, type CalcResult } from "./commands/calc.ts";
// tools 0.4.0（計画 26 章。CORE_API_VERSION は 2 のまま = 足しただけ）: ボタン（BUTTON / DIALOG）のクリックの模擬（calc の click、try の式の click）
export { CLICK_TYPES, clickFormula, describeDisplay, isButtonDisplay, type ClickInput, type ClickResult } from "./commands/click.ts";
export { takeInbox, type TakeResult } from "./commands/take.ts";
// tools 0.3.0（計画 25 章）: 同梱のサンプルアプリと式の試し計算（try / fml_try）
export { SAMPLE_APP, describeSampleApp, sampleApp, type SampleApp, type SampleRecord } from "./sample-app.ts";
export { TRY_DEFAULT_AS, TRY_MAX_FORMULAS, TRY_MAX_FORMULA_CHARS, buildTryEnvelope, resolveTryTarget, spacersOf, trySettings, type TryFormula, type TryFormulaResult, type TryInput, type TryResult, type TryTarget, type TryValue } from "./commands/try.ts";
export {
  EXTRA_TYPES, TRY_MAX_DATA, TRY_MAX_EXTRA_FIELDS, TRY_MAX_OPTIONS, TRY_MAX_TABLE_ROWS, TRY_MAX_VALUE_CHARS, TYPE_ALIASES, applyData, canonicalType, checkDataList, convertValue, emptyRecordOf, extendFields, normalizeDefaults, type TryData, type TryFieldDef
} from "./commands/try-data.ts";
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
// 項目検証（field-validation/docs/オーサリングツール_実装計画.md の段階 1）: 項目検証の規則（元の値・行・式の検査と派生値・保存値・判定）。式は計算式の zip のエンジンで評価する
export {
  FV_CONFIG_PLUGIN_ID, FV_PLUGIN_ID, FV_MIN_VERSION, FV_MIN_FORMULA_VERSION, FV_SNAPSHOT_PREFIX, FV_SNAPSHOT_RE, FV_EDIT_RE, FV_ENGINES, FV_TABLE_PRODUCERS, engineOfFv, fvUpdateFunctions
} from "./fv/meta.ts";
export {
  FV_TARGET_TYPES, FV_ELEMENT_TYPES, FV_BUTTON_TYPE, FV_COLUMN_DENY, FV_SOURCE_KEYS, FV_DERIVED_KEYS, FV_ROW_KEYS, FV_COMMON_KEYS, FV_BORDER_DEFAULTS, fvBorderOf, fvSourceOf,
  type FvSource, type FvSourceInfo, type FvSourceCond, type FvSourceTbl, type FvBorder
} from "./fv/model.ts";
export { fvPropsOf, fvRowsOf, fvApplySource, fvHasSetting, type FvProp, type FvRow, type FvRowCond, type FvTblChild, type FvLayoutRow, type FvApplyResult } from "./fv/rows.ts";
export { FV_INFO_KEYS, fvStrip, fvDerive, fvBuildSaved, type FvColumn, type FvFormulaError, type FvDeriveContext } from "./fv/derive.ts";
export { FV_JUDGE_DEFAULT_EVENT, fvJudgeRecord, type FvJudgement, type FvJudgeResult, type FvJudgeOptions, type FvLang } from "./fv/judge.ts";
// 項目検証の段階 2: コマンド（fv normalize / check / summary / diff / pull）と、計算式・項目検証のダウンロード / -edit.json の名前の判定
export { FV_PLUGIN_NAME, fvNormalizeSettings, outputInfos as fvOutputInfos, type FvNormalizeInput, type FvNormalizeResult } from "./fv/normalize.ts";
export { FV_CHECK_EVENTS_MAX, FV_CHECK_RECORDS_MAX, FV_EVENT_RE, fvCheckSettings, linesOf as fvLinesOf, renderFvLine, validateFvEvents, type FvCheckInput, type FvCheckLine, type FvCheckRecord, type FvCheckResult } from "./fv/check.ts";
export { fvDiffSettings, fvSummarizeSettings, type FvDiffResult } from "./fv/summary.ts";
export { fvDefaultPullName, fvPullSettings, type FvPullOptions } from "./fv/pull.ts";
// 項目検証の段階 7（tools 0.6.0）: 保存（formula MCP の fv_save_settings / fv_update_rows の本体）
export { fvSaveNewSettings, fvUpdateRows } from "./fv/save.ts";
export { editKindOf, isEditName, isSnapshotName, snapshotKindOf, type PluginKind } from "./workspace.ts";
