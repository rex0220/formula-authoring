/** 中核の入口（core.ts）: formula MCP が使う名前が消えないこと（tools 0.2.0。計画 24.4）と CORE_API_VERSION */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../src/core.ts";

const NAMES = [
  "CORE_API_VERSION", "loadEngine", "momentFileOf", "toolsMeta", "FORMULA_PLUGIN_ID", "FORMULA_CONFIG_PLUGIN_ID",
  "runEval", "runEvalJob", "classifyEvalError", "builtinErrorName", "EvalError", "EvalTimeoutError", "DEFAULT_TIMEOUT_SEC", "MAX_TIMEOUT_SEC",
  "saveNewSettings", "updateFields", "digestOf", "connectionStatusOf", "MAX_SAVE_INPUT_BYTES", "MAX_UPDATE_ROWS", "COMMON_KEYS",
  "modeOf", "requireProfiles", "findAppDir", "appDirFor", "appFolderOfFile", "editNameOf", "ensureAppFolder", "assertAppMark", "assertUsableInKintone", "listAppFolder", "appFoldersOf", "unusedProfileDirs", "hasLegacyConfig", "profileDirOf", "readAppMark", "legacyBlockedError",
  "KINTONE_ROOT", "INBOX", "APP_MARKER", "SNAPSHOT_RE", "EDIT_RE", "LEGACY_WORKSPACE_FILE", "WorkspaceError",
  "loadConnections", "pickProfile", "authFor", "userApiAuthFor", "assertSameConnection", "snapshotOf", "ConnectionError", "PROFILE_NAME_RE",
  "PermissionError", "assertChangeAllowed", "classOfAppPath",
  "writeNewFile", "acquireLock", "placeNew", "tempPathFor", "withRetry", "cleanupAll", "FileExistsError", "LockBusyError",
  "takeInbox", "pullSettings", "fetchFields", "listFields", "summarizeFields", "fetchRecord", "summarizeRecord", "listRecordShapes", "pullUsers", "pullReferencedUsers", "referencedCodesOf", "scanUserInfoCalls", "summarizeUsers", "validateUsersSource", "DEFAULT_USERS",
  "normalizeSettings", "calcSettings", "summarizeSettings", "rowsOf", "bodyOf", "diffSettings", "loadPolicy", "DEFAULT_POLICY",
  "readFieldsFile", "readJsonLimited", "readTextLimited", "InputError", "MAX_INPUT_BYTES", "jsonErrorWhere", "jsonErrorText",
  "createRestClient", "RestError", "NotAllowedError", "ALLOWED_APIS", "ALLOWED_USER_APIS", "RECEIVE_LIMITS",
  "resolveRead", "resolveWrite", "isInside", "realResolve", "WRITE_ROOTS", "PathError",
  "ENVELOPE_KEYS", "ROW_SOURCE_KEYS", "ROW_SCREEN_KEYS", "Findings"
];

test("core の入口に MCP が使う名前があり、CORE_API_VERSION は 2", () => {
  const missing = NAMES.filter((n) => core[n] === undefined);
  assert.deepEqual(missing, []);
  assert.equal(core.CORE_API_VERSION, 2);
  assert.deepEqual([...core.ROW_SOURCE_KEYS], ["fieldcode", "state", "formulaSet", "edit", "hide", "rank"]);
});
