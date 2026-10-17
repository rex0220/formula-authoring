/** samples/ の雛形が normalize で通ること（エラー 0、--check 差 0） */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import { REPO_ROOT } from "../src/paths.ts";
import { normalizeSettings } from "../src/commands/normalize.ts";
import { readFieldsFile } from "../src/input.ts";
import { defaultUsersInfo, validateUsersSource } from "../src/users/index.ts";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;

test("samples/settings-source.json が normalize で通る（エラー 0、--check 差 0）。samples/users.json は --users の形", { skip }, async () => {
  const engine = await loadEngine();
  const settings = path.join(REPO_ROOT, "samples", "settings-source.json");
  const fields = readFieldsFile(path.join(REPO_ROOT, "samples", "fields-2305.json"));
  const res = await normalizeSettings({ settingsText: readFileSync(settings, "utf8"), settingsFile: "samples/settings-source.json", fields, engine, check: true, usersInfo: defaultUsersInfo() });
  assert.equal(res.findings.count("error"), 0, res.summary);
  assert.deepEqual(res.checkDiffs, []);
  const users = validateUsersSource(JSON.parse(readFileSync(path.join(REPO_ROOT, "samples", "users.json"), "utf8")), "samples/users.json");
  assert.equal(users.users.length, 10);
});
