/**
 * 作業フォルダーの形とアプリのフォルダー（print-craft-authoring tools 2.0.0 の写し。print-craft-authoring-mcp の実装案 15 章）: 動く形の決め方（接続のファイル、environments.json）、
 * kintone/<profile>/<番号>-<アプリ名>/、アプリのフォルダーの印、take、作業フォルダーの外を指すフォルダー、CLI の流れ（take → files → fields --summary → normalize → edit → calc）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEngine, PLUGIN_ZIP } from "./helpers.mjs";
import {
  APP_MARKER,
  EDIT_RE,
  SNAPSHOT_RE,
  isEditName,
  isSnapshotName,
  appDirFor,
  appFolderOfFile,
  appFoldersOf,
  assertInsideWorkspace,
  assertUsableInKintone,
  editNameOf,
  ensureAppFolder,
  findAppDir,
  folderNameOf,
  listAppFolder,
  modeOf,
  readAppMark,
  requireProfiles,
  snapshotNameOf,
  unusedProfileDirs
} from "../src/workspace.ts";
import { ConnectionError, pickProfile } from "../src/connections.ts";
import { PermissionError, classOfAppPath } from "../src/permission.ts";
import { PathError } from "../src/safe-path.ts";
import { MAX_INPUT_BYTES } from "../src/input.ts";
import { takeInbox } from "../src/commands/take.ts";
import { normalizeSettings } from "../src/commands/normalize.ts";
import { EXPORT, FIELDS_FILE } from "./fixtures.mjs";
import { CONN, makeConnWorkspace } from "./conn-helper.mjs";

const skip = existsSync(PLUGIN_ZIP) ? false : `fixture の zip が無い: ${PLUGIN_ZIP}`;
const engine = skip ? null : await loadEngine();
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KINTONE_|KSQL_|FORMULA_)/.test(k)));
const run = (args, cwd, env = {}) => spawnSync(process.execPath, ["--no-warnings", CLI, ...args], { encoding: "utf8", env: { ...baseEnv, FORMULA_PLUGIN_ZIP: PLUGIN_ZIP, FORMULA_NO_WORKER: "1", ...env }, cwd });
const APP = 2305;
const NAME = "テーブル内集計";
const DL = `rex0220-formula-app${APP}-20261005-125115.json`;
const code = (c) => (e) => e instanceof ConnectionError && e.code === c;

/** 計算式プラグインの設定のダウンロードと同じ形（封筒の appId。fixture の 2305 を normalize したもの） */
async function snapshotText() {
  const r = await normalizeSettings({ settingsText: JSON.stringify(EXPORT()), settingsFile: "x.json", fields: FIELDS_FILE(), engine });
  assert.ok(r.output, r.summary);
  return JSON.stringify(r.output, null, 2) + "\n";
}
const RECORD = { appId: APP, id: 3, record: { $id: { type: "RECORD_NUMBER", value: "3" }, 商品セット: { type: "CHECK_BOX", value: [] }, 金額合計: { type: "NUMBER", value: "" }, テーブル: { type: "SUBTABLE", value: [] } } };

test("フォルダーの名前: 番号-アプリ名、名前が使えなければ番号だけ。ファイルの置き場所から profile と番号を知る。ダウンロードと同じ名前（rex0220-formula-app<番号>-<日時>.json）", () => {
  assert.equal(folderNameOf(APP, "テーブル内集計(計算式)"), `${APP}-テーブル内集計(計算式)`);
  assert.equal(folderNameOf(APP, "a/b"), `${APP}-a_b`);
  assert.equal(folderNameOf(APP, ""), String(APP));
  for (const bad of ["CON", "NUL", ".", ".."]) assert.ok(!new RegExp(`^${APP}-(CON|NUL|\\.|\\.\\.)$`).test(folderNameOf(APP, bad)), bad);
  assert.ok(folderNameOf(APP, "あ".repeat(300)).length < 260, "長い名前は切る");
  const root = "/w";
  assert.deepEqual(appFolderOfFile(root, `/w/kintone/dev/${APP}-x/records/3.json`), { dir: path.join(root, "kintone", "dev", `${APP}-x`), profile: "dev", appId: APP });
  assert.equal(appFolderOfFile(root, "/w/settings/a.json"), null);
  assert.equal(appFolderOfFile(root, "/w/kintone/dev/a.json"), null);
  assert.equal(appFolderOfFile(root, `/w/kintone/x.cybozu.com/${APP}-x/a.json`), null, "ホスト名のフォルダーは profile の形でない");
  assert.equal(appFolderOfFile(root, "/w/kintone/dev/0123-x/a.json"), null);
  const name = snapshotNameOf(APP, new Date(2026, 9, 5, 12, 51, 15));
  assert.equal(name, DL, "設定画面のダウンロードと同じ名前");
  assert.ok(SNAPSHOT_RE.test(name) && EDIT_RE.test(editNameOf(name)) && !SNAPSHOT_RE.test(editNameOf(name)));
  assert.ok(!SNAPSHOT_RE.test("rex0220-print-craft-app1-20261005-125115.json"), "印刷屋のダウンロードは対象外");
});

test("動く形（15.4）: 接続のファイルがあれば profiles、空・読めないのは誤り（1 接続に戻らない）、無くて environments.json があれば legacy-blocked、無ければ CLI は single・MCP は not-configured", () => {
  const t = makeConnWorkspace();
  try {
    const opt = (configFile, surface = "cli") => ({ configFile, workspaceRoots: [t.root], env: {}, surface });
    assert.equal(modeOf(t.root, opt(t.connFile)).kind, "profiles");
    assert.throws(() => modeOf(t.root, opt("")), code("unreadable"));
    assert.throws(() => modeOf(t.root, opt(path.join(t.base, "無い.json"))), code("unreadable"));
    assert.equal(modeOf(t.root, opt(undefined)).kind, "single");
    assert.equal(modeOf(t.root, opt(undefined, "mcp")).kind, "not-configured");
    writeFileSync(path.join(t.root, "environments.json"), "{}");
    assert.equal(modeOf(t.root, opt(undefined)).kind, "legacy-blocked");
    assert.equal(modeOf(t.root, opt(t.connFile)).kind, "profiles", "接続のファイルがあれば environments.json は読まない");
    assert.throws(() => requireProfiles({ kind: "legacy-blocked" }, "fields"), code("legacy-config-present"));
    assert.throws(() => requireProfiles({ kind: "not-configured" }, "fields"), code("not-configured"));
    assert.throws(() => requireProfiles({ kind: "single" }, "take"), (e) => code("not-configured")(e) && /take は kintone の接続のファイル（FORMULA_KINTONE_CONFIG）/.test(e.message));
    assert.ok(requireProfiles(t.mode(), "x").set.profiles.has("dev"));
  } finally {
    t.cleanup();
  }
});

test("アプリのフォルダー: 番号で探す（名前が変わっても）、同じ番号が 2 つなら止まる、. で始まるもの（一時フォルダー）は数えない。作るときは印（.formula-app.json）を先に置く", () => {
  const t = makeConnWorkspace();
  try {
    const def = pickProfile(t.mode().connections.set, "dev");
    assert.equal(findAppDir(t.root, "dev", APP), null);
    const dir = appDirFor(t.root, "dev", APP, NAME);
    assert.equal(dir, path.join(t.root, "kintone", "dev", `${APP}-${NAME}`));
    ensureAppFolder(dir, def, APP);
    assert.equal(APP_MARKER, ".formula-app.json");
    assert.deepEqual(readAppMark(dir), { state: "ok", mark: { schemaVersion: 1, profile: "dev", origin: "https://dev-x.cybozu.com", guestSpaceId: null, appId: APP } });
    assert.deepEqual(readdirSync(path.join(t.root, "kintone", "dev")), [`${APP}-${NAME}`], "一時フォルダーを残さない");
    assert.equal(appDirFor(t.root, "dev", APP, "新しい名前"), dir, "番号で探す");
    ensureAppFolder(dir, def, APP);
    assert.throws(() => ensureAppFolder(dir, def, 101), code("app-identity-conflict"), "番号の違う印");
    mkdirSync(path.join(t.root, "kintone", "dev", `.${APP}-x.abc.tmp`));
    assert.equal(findAppDir(t.root, "dev", APP), dir, "途中で止まった一時フォルダーは数えない");
    assert.equal(findAppDir(t.root, "dev", 230), null, "230 は 2305 と区別する");
    mkdirSync(path.join(t.root, "kintone", "dev", String(APP)));
    assert.throws(() => findAppDir(t.root, "dev", APP), /フォルダーが 2 つある/);
    rmSync(path.join(t.root, "kintone", "dev", String(APP)), { recursive: true });
    const bare = path.join(t.root, "kintone", "dev", "101-手で作った");
    mkdirSync(bare);
    assert.throws(() => ensureAppFolder(bare, def, 101), (e) => code("app-marker-missing")(e) && /tools が作ったフォルダーでない/.test(e.message));
    assert.equal(existsSync(path.join(bare, APP_MARKER)), false, "後から印を置かない");
  } finally {
    t.cleanup();
  }
});

test("通常の操作で kintone/ の下を読む前（15.5）: profile の形だけ、接続のファイルにある profile、印が合うフォルダーだけ。診断は名前と印の状態だけ", () => {
  const t = makeConnWorkspace();
  try {
    const mode = t.mode();
    const dir = t.appFolder("dev", APP, NAME, FIELDS_FILE());
    assertUsableInKintone(t.root, path.join(dir, "fields.json"), mode);
    assertUsableInKintone(t.root, path.join(t.root, "settings", "a.json"), { kind: "single" });
    assert.throws(() => assertUsableInKintone(t.root, path.join(dir, "fields.json"), { kind: "single" }), PermissionError);
    assert.throws(() => assertUsableInKintone(t.root, path.join(dir, "fields.json"), { kind: "legacy-blocked" }), code("legacy-config-present"));
    const stage = path.join(t.root, "kintone", "stage", `${APP}-x`);
    mkdirSync(stage, { recursive: true });
    assert.throws(() => assertUsableInKintone(t.root, path.join(stage, "a.json"), mode), (e) => e instanceof PermissionError && /profile「stage」/.test(e.message));
    const bare = path.join(t.root, "kintone", "dev", "101-手で作った");
    mkdirSync(bare);
    assert.throws(() => assertUsableInKintone(t.root, path.join(bare, "a.json"), mode), code("app-marker-missing"));
    const def = pickProfile(mode.connections.set, "dev");
    assert.deepEqual(appFoldersOf(t.root, def), [
      { name: "101-手で作った", appId: 101, mark: "missing" },
      { name: `${APP}-${NAME}`, appId: APP, mark: "ok" }
    ]);
    assert.deepEqual(unusedProfileDirs(t.root, mode.connections.set), ["stage"]);
  } finally {
    t.cleanup();
  }
});

test("take: inbox のダウンロードを、封筒の appId で profile（--profile か defaultProfile）のアプリのフォルダーへ名前のまま移す。印を先に置く。計算式プラグインでないもの・名前と appId が違うもの・印が合わないフォルダーには移さない", { skip }, async () => {
  const t = makeConnWorkspace();
  const inbox = path.join(t.root, "inbox");
  mkdirSync(inbox);
  try {
    const text = await snapshotText();
    writeFileSync(path.join(inbox, DL), text);
    writeFileSync(path.join(inbox, "other.json"), JSON.stringify({ pluginID: "rex0220 Print craft plugin", appId: APP }));
    writeFileSync(path.join(inbox, "rex0220-formula-app101-20261005-125115.json"), text);
    const r = takeInbox(t.root, t.mode());
    assert.deepEqual(r.moved.map((m) => m.to.replace(/\\/g, "/")), [`kintone/dev/${APP}-${NAME}/${DL}`], JSON.stringify(r));
    const dir = path.join(t.root, "kintone", "dev", `${APP}-${NAME}`);
    assert.equal(readFileSync(path.join(dir, DL), "utf8"), text, "中身も名前もそのまま");
    assert.equal(readAppMark(dir).state, "ok", "印を置いた");
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.file, s.reason]));
    assert.match(reasons["inbox/other.json"], /計算式・項目検証のプラグインの設定のファイルではない/);
    assert.match(reasons["inbox/rex0220-formula-app101-20261005-125115.json"], new RegExp(`ファイル名のアプリ 101 と封筒の appId ${APP} が違う`));
    // --profile prod は prod のフォルダーへ
    writeFileSync(path.join(inbox, DL), text);
    const p = takeInbox(t.root, t.mode(), "prod");
    assert.deepEqual(p.moved.map((m) => m.to.replace(/\\/g, "/")), [`kintone/prod/${APP}-${NAME}/${DL}`]);
    // 同じものをもう一度置いたら inbox から消すだけ、違う中身なら移さない
    writeFileSync(path.join(inbox, DL), text);
    assert.deepEqual(takeInbox(t.root, t.mode()).moved.map((m) => m.same), [true]);
    writeFileSync(path.join(inbox, DL), text.replace(`"appName": "${NAME}"`, '"appName": "別の名前"'));
    assert.match(takeInbox(t.root, t.mode()).skipped.find((s) => s.file.endsWith(DL)).reason, /同じ名前の別の中身がある/);
    // 印が合わないフォルダー（接続先を変えた profile）: skipped にせず、何も変えずに止める（conflict）
    t.writeConn({ ...CONN, profiles: { ...CONN.profiles, dev: { ...CONN.profiles.dev, baseUrl: "https://dev-z.cybozu.com" } } });
    const dl2 = DL.replace("20261005-125115", "20261006-090000");
    writeFileSync(path.join(inbox, dl2), text);
    writeFileSync(path.join(inbox, DL), text);
    assert.throws(() => takeInbox(t.root, t.mode()), code("app-identity-conflict"));
    assert.ok(!existsSync(path.join(dir, dl2)), "置かない");
    assert.ok(existsSync(path.join(inbox, dl2)) && existsSync(path.join(inbox, DL)), "同じものでも inbox から消さない");
    assert.throws(() => takeInbox(t.root, { kind: "single" }), code("not-configured"));
  } finally {
    t.cleanup();
  }
});

test("項目検証のダウンロード: take が移し、ダウンロード・-edit.json は計算式と別に一覧し、どちらの名前も書き換えない場所に分ける", { skip }, async () => {
  const t = makeConnWorkspace();
  const inbox = path.join(t.root, "inbox");
  mkdirSync(inbox);
  try {
    const fvName = `rex0220-field-validation-app${APP}-20261005-130000.json`;
    const fvText = JSON.stringify({ date: "2026-10-05T04:00:00.000Z", pluginName: "項目検証", pluginID: "rex0220 field validation plugin", PluginVersion: "72", appId: APP, appName: NAME, pluginEnable: true, pluginInfos: [] }, null, 2);
    writeFileSync(path.join(inbox, DL), await snapshotText());
    writeFileSync(path.join(inbox, fvName), fvText);
    // 名前と pluginID のプラグインが違うもの（項目検証の名前で計算式の中身）は移さない
    writeFileSync(path.join(inbox, `rex0220-field-validation-app${APP}-20261005-140000.json`), await snapshotText());
    const r = takeInbox(t.root, t.mode());
    assert.deepEqual(r.moved.map((m) => path.basename(m.to)).sort(), [DL, fvName].sort(), JSON.stringify(r));
    assert.match(r.skipped[0].reason, /rex0220-formula-app<番号>-<日時>\.json）ではない/);
    const dir = path.join(t.root, "kintone", "dev", `${APP}-${NAME}`);
    const fvEdit = fvName.replace(/\.json$/, "-edit.json");
    writeFileSync(path.join(dir, fvEdit), fvText);
    writeFileSync(path.join(dir, "AI-作った.json"), "{}");
    const l = listAppFolder(dir, t.root);
    assert.deepEqual([l.snapshots, l.edits, l.fvSnapshots, l.fvEdits, l.others], [[DL], [], [fvName], [fvEdit], ["AI-作った.json"]]);
    assert.deepEqual([classOfAppPath(fvName), classOfAppPath(fvEdit), classOfAppPath("AI-作った.json")], ["snapshot", "edit", "newsettings"]);
    assert.ok(isSnapshotName(fvName) && isEditName(fvEdit) && !isSnapshotName(fvEdit));
    assert.match(snapshotNameOf(APP, new Date(2026, 9, 28, 9, 5, 7), "field-validation"), new RegExp(`^rex0220-field-validation-app${APP}-20261028-090507\\.json$`));
    // CLI: edit --plugin field-validation は項目検証の一番新しいダウンロードを写す（既定は計算式）。files は両方を分けて出す
    rmSync(path.join(dir, fvEdit));
    const env = { FORMULA_KINTONE_CONFIG: t.connFile };
    let cli = run(["edit", "--app", String(APP), "--plugin", "field-validation"], t.root, env);
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    assert.ok(existsSync(path.join(dir, fvEdit)), "項目検証の -edit.json");
    assert.match(cli.stdout, /fv normalize .*→ fv diff .*→ fv check /);
    cli = run(["edit", "--app", String(APP)], t.root, env);
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(existsSync(path.join(dir, DL.replace(/\.json$/, "-edit.json"))), "既定は計算式");
    assert.equal(run(["edit", "--app", String(APP), "--plugin", "print-craft"], t.root, env).status, 2);
    cli = run(["files", "--app", String(APP)], t.root, env);
    assert.match(cli.stdout, new RegExp(`項目検証のダウンロード / fv pull（新しい順。先頭が今の設定）: \\n  ${fvName}  ← 今の設定`));
  } finally {
    t.cleanup();
  }
});

test("take: 呼び出しの途中で選んだ profile の接続が変われば止める（同じものが既にあるときも inbox から消さない）。ほかの profile だけの書き換えでは続ける", { skip }, async () => {
  const t = makeConnWorkspace();
  const inbox = path.join(t.root, "inbox");
  mkdirSync(inbox);
  const rotated = (token) => ({ ...CONN, profiles: { ...CONN.profiles, dev: { ...CONN.profiles.dev, tokenMap: { ...CONN.profiles.dev.tokenMap, [`APP${APP}`]: token } } } });
  try {
    const text = await snapshotText();
    writeFileSync(path.join(inbox, DL), text);
    assert.equal(takeInbox(t.root, t.mode()).moved.length, 1);
    const dir = path.join(t.root, "kintone", "dev", `${APP}-${NAME}`);
    writeFileSync(path.join(inbox, DL), text);
    const before = t.mode();
    t.writeConn(rotated("rotated-1"));
    assert.throws(() => takeInbox(t.root, before), code("connection-changed"));
    assert.ok(existsSync(path.join(inbox, DL)), "同じものでも消さない");
    rmSync(path.join(inbox, DL));
    const dl2 = DL.replace("20261005-125115", "20261006-090000");
    writeFileSync(path.join(inbox, dl2), text);
    const before2 = t.mode();
    t.writeConn(rotated("rotated-2"));
    assert.throws(() => takeInbox(t.root, before2), (e) => code("connection-changed")(e) && /この呼び出しで移したのは 0 件/.test(e.message));
    assert.ok(!existsSync(path.join(dir, dl2)) && existsSync(path.join(inbox, dl2)));
    const before3 = t.mode();
    t.writeConn({ ...rotated("rotated-2"), profiles: { ...rotated("rotated-2").profiles, prod: { ...CONN.profiles.prod, baseUrl: "https://y.cybozu.com" } } });
    assert.deepEqual(takeInbox(t.root, before3).moved.map((m) => path.basename(m.to)), [dl2]);
  } finally {
    t.cleanup();
  }
});

test("take: 同じアプリでアプリ名の違うダウンロードを一度に置いても、アプリのフォルダーは 1 つ（一番新しいダウンロードのアプリ名）。名前が変わっても番号で探す", { skip }, async () => {
  const t = makeConnWorkspace();
  const inbox = path.join(t.root, "inbox");
  mkdirSync(inbox);
  try {
    const base = JSON.parse(await snapshotText());
    const older = `rex0220-formula-app${APP}-20261001-090000.json`;
    const newer = `rex0220-formula-app${APP}-20261002-090000.json`;
    writeFileSync(path.join(inbox, older), JSON.stringify({ ...base, appName: "旧名" }));
    writeFileSync(path.join(inbox, newer), JSON.stringify({ ...base, appName: "新名" }));
    const r = takeInbox(t.root, t.mode());
    assert.deepEqual(r.skipped, []);
    const dev = path.join(t.root, "kintone", "dev");
    assert.deepEqual(readdirSync(dev).filter((n) => !n.startsWith(".")), [`${APP}-新名`], "同じ番号のフォルダーを 2 つ作らない");
    assert.equal(findAppDir(t.root, "dev", APP), path.join(dev, `${APP}-新名`));
    const newest = `rex0220-formula-app${APP}-20261003-090000.json`;
    writeFileSync(path.join(inbox, newest), JSON.stringify({ ...base, appName: "もっと新しい名前" }));
    assert.deepEqual(takeInbox(t.root, t.mode()).moved.map((m) => path.dirname(m.to).replace(/\\/g, "/")), [`kintone/dev/${APP}-新名`], "今あるフォルダーへ（名前を付け替えない）");
  } finally {
    t.cleanup();
  }
});

test("take: 読めない inbox のファイルの理由は決まった文（JSON の断片・秘密の値・環境変数の名前・絶対パスを出さない）。CLI の出力にも出さない", { skip }, async () => {
  const t = makeConnWorkspace();
  const inbox = path.join(t.root, "inbox");
  mkdirSync(inbox);
  const SENTINEL = "SECRET-tok-0123456789";
  try {
    writeFileSync(path.join(inbox, DL), `{"pluginID":"rex0220 formula plugin","token":${SENTINEL},"ref":"env:MY_SECRET_VAR"}`);
    writeFileSync(path.join(inbox, `rex0220-formula-app${APP}-20261005-125116.json`), `{"password": "${SENTINEL}" `);
    writeFileSync(path.join(inbox, "big.json"), Buffer.alloc(MAX_INPUT_BYTES + 10, 0x20));
    writeFileSync(path.join(inbox, "array.json"), "[1, 2]");
    const r = takeInbox(t.root, t.mode());
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.file, s.reason]));
    assert.match(reasons[`inbox/${DL}`], /^JSON として読めない.*（中身は返さない）$/);
    assert.match(reasons[`inbox/rex0220-formula-app${APP}-20261005-125116.json`], /^JSON として読めない/);
    assert.match(reasons["inbox/big.json"], /^大きすぎる/);
    assert.equal(reasons["inbox/array.json"], "JSON の最上位がオブジェクトでない");
    const text = JSON.stringify(r);
    for (const v of [SENTINEL, "MY_SECRET_VAR", t.root, t.base]) assert.ok(!text.includes(v), `返さない: ${v}`);
    const cli = run(["take"], t.root, { FORMULA_KINTONE_CONFIG: t.connFile });
    assert.equal(cli.status, 1, cli.stderr);
    for (const v of [SENTINEL, "MY_SECRET_VAR"]) assert.ok(!cli.stderr.includes(v) && !cli.stdout.includes(v), `CLI に出さない: ${v}`);
    assert.match(cli.stderr, new RegExp(`移さない: inbox/rex0220-formula-app${APP}-20261005-125115\\.json（JSON として読めない`));
  } finally {
    t.cleanup();
  }
});

test("アプリのフォルダーを作る途中で止まった・同時に作った（15.5）: . で始まる一時フォルダーは採用も一覧もしない。別のプロセスと同時に作っても印は 1 つで、一時フォルダーを残さない", async () => {
  const t = makeConnWorkspace();
  try {
    const def = pickProfile(t.mode().connections.set, "dev");
    const profileDir = path.join(t.root, "kintone", "dev");
    mkdirSync(path.join(profileDir, `.${APP}-x.abcdef.tmp`), { recursive: true });
    writeFileSync(path.join(profileDir, `.${APP}-x.abcdef.tmp`, APP_MARKER), JSON.stringify({ schemaVersion: 1, profile: "dev", origin: "https://dev-x.cybozu.com", guestSpaceId: null, appId: APP }));
    assert.equal(findAppDir(t.root, "dev", APP), null, "一時フォルダーを採用しない");
    assert.deepEqual(appFoldersOf(t.root, def), [], "一覧に出さない");
    const dir = path.join(profileDir, `${APP}-${NAME}`);
    ensureAppFolder(dir, def, APP);
    assert.equal(readAppMark(dir).state, "ok");
    assert.equal(findAppDir(t.root, "dev", APP), dir);
    const target = path.join(profileDir, "101-同時");
    const script = [
      `import { ensureAppFolder } from ${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).href)};`,
      `import { loadConnections, pickProfile } from ${JSON.stringify(new URL("../src/connections.ts", import.meta.url).href)};`,
      `const [file, dir] = process.argv.slice(1);`,
      `const def = pickProfile(loadConnections(file, { workspaceRoots: [], env: {} }), "dev");`,
      `ensureAppFolder(dir, def, 101);`
    ].join("\n");
    const { spawn } = await import("node:child_process");
    const runs = Array.from({ length: 4 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script, t.connFile, target], { stdio: ["ignore", "ignore", "pipe"] });
      let err = "";
      c.stderr.on("data", (d) => (err += d));
      c.on("close", (code) => resolve({ code, err }));
    }));
    for (const r of await Promise.all(runs)) assert.equal(r.code, 0, r.err);
    assert.equal(readAppMark(target).state, "ok");
    assert.deepEqual(readdirSync(profileDir).filter((n) => n.startsWith(".101-")), [], "一時フォルダーを残さない");
  } finally {
    t.cleanup();
  }
});

test("take: 行き先に置いた後に inbox の元を消せなくても、置いたことを返す（leftInInbox と注意）", { skip: skip || process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const t = makeConnWorkspace();
  const inbox = path.join(t.root, "inbox");
  mkdirSync(inbox);
  try {
    writeFileSync(path.join(inbox, DL), await snapshotText());
    chmodSync(inbox, 0o555);
    const r = takeInbox(t.root, t.mode());
    assert.deepEqual(r.moved.map((m) => [m.same, m.leftInInbox]), [[false, true]]);
    assert.match(r.warnings.join("\n"), /行き先に置いたが、inbox から消せなかった/);
    assert.deepEqual(takeInbox(t.root, t.mode()).moved.map((m) => [m.same, m.leftInInbox]), [[true, true]], "同じものの経路も消せなければそう返す");
    chmodSync(inbox, 0o755);
    assert.deepEqual(takeInbox(t.root, t.mode()).moved.map((m) => [m.same, m.leftInInbox]), [[true, undefined]], "次の take で消す");
    assert.deepEqual(readdirSync(inbox), []);
  } finally {
    chmodSync(inbox, 0o755);
    t.cleanup();
  }
});

test("listAppFolder: ダウンロード / pull は新しい順、-edit.json とその他の設定は分ける。. で始まるもの（印）は出さない", () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "formula-ws-"));
  try {
    for (const n of ["rex0220-formula-app1-20261001-090000.json", "rex0220-formula-app1-20261005-125115.json", "rex0220-formula-app1-20261001-090000-edit.json", "新しい設定.json", "fields.json", APP_MARKER]) writeFileSync(path.join(work, n), "{}");
    const l = listAppFolder(work);
    assert.deepEqual(l.snapshots, ["rex0220-formula-app1-20261005-125115.json", "rex0220-formula-app1-20261001-090000.json"]);
    assert.deepEqual(l.edits, ["rex0220-formula-app1-20261001-090000-edit.json"]);
    assert.deepEqual(l.others, ["新しい設定.json"]);
    assert.equal(l.hasFields, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("フォルダーの実体が作業フォルダーの外（symlink / junction）なら一覧しない: kintone/ と profile のフォルダー、アプリのフォルダーと records、inbox", (t2) => {
  const t = makeConnWorkspace();
  const outside = mkdtempSync(path.join(os.tmpdir(), "formula-outside-"));
  const link = (target, at) => symlinkSync(target, at, "junction");
  try {
    mkdirSync(path.join(outside, "dev", `${APP}-外`), { recursive: true });
    writeFileSync(path.join(outside, "99.json"), "{}");
    try {
      link(outside, path.join(t.root, "kintone"));
    } catch (e) {
      t2.skip(`symlink を作れない: ${e.message}`);
      return;
    }
    assert.throws(() => findAppDir(t.root, "dev", APP), PathError, "kintone/ が外");
    assert.throws(() => assertInsideWorkspace(t.root, path.join(t.root, "kintone")), /kintone の実体が作業フォルダーの外を指している/);
    rmSync(path.join(t.root, "kintone"));
    mkdirSync(path.join(t.root, "kintone"));
    link(path.join(outside, "dev"), path.join(t.root, "kintone", "dev"));
    assert.throws(() => findAppDir(t.root, "dev", APP), PathError, "profile のフォルダーが外");
    rmSync(path.join(t.root, "kintone", "dev"));
    const app = t.appFolder("dev", APP, NAME);
    assert.equal(findAppDir(t.root, "dev", APP), app, "中なら今までどおり");
    link(outside, path.join(app, "records"));
    assert.throws(() => listAppFolder(app, t.root), PathError, "records が外");
    const files = run(["files", "--app", String(APP)], t.root, { FORMULA_KINTONE_CONFIG: t.connFile });
    assert.equal(files.status, 2, files.stderr);
    assert.match(files.stderr, /作業フォルダーの外を指している/);
    assert.ok(!files.stdout.includes("99.json") && !files.stderr.includes("99.json"), "外のファイルの名前を出さない");
    rmSync(path.join(app, "records"));
    link(outside, path.join(t.root, "inbox"));
    assert.throws(() => takeInbox(t.root, t.mode()), PathError, "inbox が外");
    const take = run(["take"], t.root, { FORMULA_KINTONE_CONFIG: t.connFile });
    assert.equal(take.status, 2, take.stderr);
    assert.match(take.stderr, /inbox の実体が作業フォルダーの外を指している（symlink など）/);
  } finally {
    t.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("CLI（接続のファイルあり）: take → files → fields --summary → normalize は fields.json を同じフォルダーから、ダウンロードは書き換えない → edit → normalize --out → calc --id 3 は records/3.json。--profile で prod", { skip }, async () => {
  const t = makeConnWorkspace();
  const env = { FORMULA_KINTONE_CONFIG: t.connFile };
  try {
    mkdirSync(path.join(t.root, "inbox"));
    writeFileSync(path.join(t.root, "inbox", DL), await snapshotText());
    const tk = run(["take"], t.root, env);
    assert.equal(tk.status, 0, tk.stderr);
    const dir = path.join(t.root, "kintone", "dev", `${APP}-${NAME}`);
    writeFileSync(path.join(dir, "fields.json"), JSON.stringify(FIELDS_FILE()));
    mkdirSync(path.join(dir, "records"));
    writeFileSync(path.join(dir, "records", "3.json"), JSON.stringify(RECORD));
    const snap = path.join("kintone", "dev", `${APP}-${NAME}`, DL);
    const f = run(["files", "--app", String(APP)], t.root, env);
    assert.equal(f.status, 0, f.stderr);
    assert.match(f.stdout, new RegExp(`${DL}  ← 今の設定`));
    assert.match(f.stdout, /profile dev、https:\/\/dev-x\.cybozu\.com/);
    assert.match(f.stdout, /records\/: 3\.json/);
    const s = run(["fields", "--app", String(APP), "--summary"], t.root, env);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, new RegExp(`^アプリ ${APP} `));
    const n1 = run(["normalize", snap, "--check"], t.root, env);
    assert.equal(n1.status, 0, n1.stderr + n1.stdout);
    assert.match(n1.stdout, /--check: 入力と出力の差 0/);
    const n1b = run(["normalize", snap, "--out", snap, "--force"], t.root, env);
    assert.equal(n1b.status, 1, n1b.stderr);
    assert.match(n1b.stderr, /ダウンロード \/ pull のファイルは書き換えない/);
    const e = run(["edit", "--app", String(APP)], t.root, env);
    assert.equal(e.status, 0, e.stderr);
    const editFile = path.join("kintone", "dev", `${APP}-${NAME}`, DL.replace(".json", "-edit.json"));
    assert.equal(readFileSync(path.join(t.root, editFile), "utf8"), readFileSync(path.join(t.root, snap), "utf8"));
    assert.match(run(["edit", "--app", String(APP)], t.root, env).stdout, /既にある（続けて直す）/);
    const n3 = run(["normalize", editFile, "--out", editFile, "--force"], t.root, env);
    assert.equal(n3.status, 0, n3.stderr + n3.stdout);
    assert.equal(run(["normalize", editFile, "--profile", "prod"], t.root, env).status, 2, "--profile とフォルダーの profile が違う");
    // アプリのフォルダーの中のファイルは同じフォルダーの fields.json だけ（別の fields で検査しない）
    mkdirSync(path.join(t.root, "fields"), { recursive: true });
    writeFileSync(path.join(t.root, "fields", `${APP}.json`), JSON.stringify(FIELDS_FILE()));
    const nf = run(["normalize", editFile, "--fields", `fields/${APP}.json`], t.root, env);
    assert.equal(nf.status, 1, nf.stderr);
    assert.match(nf.stderr, /同じフォルダーの fields\.json で検査する/);
    assert.equal(run(["normalize", editFile, "--fields", path.join("kintone", "dev", `${APP}-${NAME}`, "fields.json")], t.root, env).status, 0, "同じフォルダーの fields.json なら付けてもよい");
    const c = run(["calc", editFile, "--app", String(APP), "--id", "3"], t.root, env);
    assert.notEqual(c.status, 2, c.stderr);
    assert.match(c.stdout + c.stderr, /3/, "records/3.json を使った");
    assert.equal(run(["calc", editFile, "--app", "101", "--id", "3"], t.root, env).status, 2, "--app とフォルダーのアプリが違う");
    // --profile prod のフォルダーはまだ無い
    const fp = run(["files", "--app", String(APP), "--profile", "prod"], t.root, env);
    assert.equal(fp.status, 1);
    assert.match(fp.stderr, new RegExp(`kintone/prod/${APP}-…）が無い。先に .* fields --app ${APP} --profile prod`));
    // version は接続の形を出す（値は出さない）
    const v = run(["version"], t.root, env);
    assert.match(v.stdout, /kintone の接続: 接続のファイル connections\.json（profile: dev, prod。既定 dev）/);
    assert.ok(!v.stdout.includes("dev-token"), "トークンを出さない");
  } finally {
    t.cleanup();
  }
});

test("CLI: --profile と --guest と --out の決まり、environments.json が残っていれば kintone を使うコマンドは止まる（settings/ の作業は動く）、接続のファイルの設定が空・相対パス（OS）は誤り、.env の相対パスは使える", { skip }, () => {
  const t = makeConnWorkspace();
  try {
    const env = { FORMULA_KINTONE_CONFIG: t.connFile };
    const g = run(["fields", "--app", String(APP), "--guest", "1"], t.root, env);
    assert.equal(g.status, 2);
    assert.match(g.stderr, /--guest を使わない/);
    const o = run(["fields", "--app", String(APP), "--out", "fields/x.json"], t.root, env);
    assert.equal(o.status, 2);
    assert.match(o.stderr, /--out を使わない/);
    const pf = run(["pull", "--app", String(APP), "--force"], t.root, env);
    assert.equal(pf.status, 2);
    assert.match(pf.stderr, /--force は使えない/);
    const unknown = run(["files", "--app", String(APP), "--profile", "stage"], t.root, env);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /profile「stage」は接続のファイル（connections\.json）に無い/);
    // 接続のファイルが無いとき（1 接続の形）
    const np = run(["fields", "--app", String(APP), "--profile", "dev", "--summary"], t.root);
    assert.equal(np.status, 2);
    assert.match(np.stderr, /--profile は kintone の接続のファイル/);
    for (const cmd of [["take"], ["edit", "--app", "1"], ["files", "--app", "1"]]) {
      const r = run(cmd, t.root);
      assert.equal(r.status, 2, cmd.join(" "));
      assert.match(r.stderr, /接続のファイル（FORMULA_KINTONE_CONFIG）があるときだけ使える/);
    }
    const empty = run(["files", "--app", "1"], t.root, { FORMULA_KINTONE_CONFIG: "" });
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /接続のファイル（FORMULA_KINTONE_CONFIG）が空/);
    const relOs = run(["files", "--app", "1"], t.root, { FORMULA_KINTONE_CONFIG: "../connections.json" });
    assert.equal(relOs.status, 1);
    assert.match(relOs.stderr, /絶対パスで書く/);
    writeFileSync(path.join(t.root, ".env"), "FORMULA_KINTONE_CONFIG=../connections.json\n");
    const relEnv = run(["files", "--app", String(APP)], t.root);
    assert.equal(relEnv.status, 1, relEnv.stderr);
    assert.match(relEnv.stderr, new RegExp(`kintone/dev/${APP}-…）が無い`), "接続のファイルを読めた（フォルダーがまだ無いと言う）");
    rmSync(path.join(t.root, ".env"));
    // environments.json が残っている
    writeFileSync(path.join(t.root, "environments.json"), JSON.stringify({ environments: {} }));
    const legacy = run(["fields", "--app", String(APP), "--summary"], t.root);
    assert.equal(legacy.status, 1);
    assert.match(legacy.stderr, /environments\.json は tools 2\.0\.0 から使わない/);
    mkdirSync(path.join(t.root, "settings"));
    mkdirSync(path.join(t.root, "fields"));
    writeFileSync(path.join(t.root, "settings", "a.json"), JSON.stringify(EXPORT()));
    writeFileSync(path.join(t.root, "fields", `${APP}.json`), JSON.stringify(FIELDS_FILE()));
    const local = run(["normalize", "settings/a.json", "--fields", `fields/${APP}.json`], t.root);
    assert.equal(local.status, 0, local.stderr + local.stdout);
    const withConn = run(["files", "--app", String(APP)], t.root, env);
    assert.match(withConn.stderr, new RegExp(`${APP}-…）が無い`), "接続のファイルがあれば environments.json は読まない");
    // 1 接続の形で kintone/ の下を読ませない
    mkdirSync(path.join(t.root, "kintone", "dev", `${APP}-x`), { recursive: true });
    writeFileSync(path.join(t.root, "kintone", "dev", `${APP}-x`, "a.json"), JSON.stringify(EXPORT()));
    rmSync(path.join(t.root, "environments.json"));
    const single = run(["summary", `kintone/dev/${APP}-x/a.json`], t.root);
    assert.equal(single.status, 1, single.stderr);
    assert.match(single.stderr, /接続のファイルがあるときだけ使う/);
  } finally {
    t.cleanup();
  }
});
