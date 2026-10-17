/**
 * 作業フォルダーの形とアプリのフォルダー（print-craft-authoring tools 2.0.0 の写し。print-craft-authoring-mcp の実装案 15 章。計算式プラグイン用は 2026-10-17 工程 1 の後半）。
 *   - 形は 2 つ（15.4）: 接続のファイル（kSQL の ksql.config.json と同じ形。connections.ts）があれば **profile の形**、無ければ **1 接続の形**
 *     （.env の KINTONE_*、settings/ fields/ records/ users/。kintone/ の下はいつも変えない）。接続のファイルが無く environments.json（1.x の形）が
 *     あれば止まる（legacy-config-present。1 接続の形に黙って戻らない）。environments.json は読まない
 *   - profile の形のアプリのフォルダー: kintone/<profile>/<アプリ番号>-<アプリ名>/（番号の後ろは目印。番号で探すので、アプリ名が変わっても動く）
 *       fields.json、records/<レコード番号>.json
 *       rex0220-formula-app<番号>-<YYYYMMDD>-<HHmmss>.json … 設定画面のダウンロード（名前はそのまま）と pull。一番新しいものが今の設定
 *       …-edit.json … ダウンロード / pull を AI が直したもの（edit で写す。ダウンロードのファイルは書き換えない）
 *       その他の *.json … AI が新しく作る設定（normalize --out の書き出し先）
 *       .formula-app.json … アプリのフォルダーの印（どの接続のアプリか。フォルダーを作るときだけ置く。15.5）
 *   - 1 つの profile は 1 つのスペース（ゲストスペースは profile の guestSpaceId）
 * inbox/ … ダウンロードを置く場所（take がアプリのフォルダーへ名前のまま移す）
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { ConnectionError, PROFILE_NAME_RE, loadConnections, sameIdentity, type ConnectionSet, type Env, type ProfileDef } from "./connections.ts";
import { PathError, isInside, realResolve, safeFileName } from "./safe-path.ts";
import { PermissionError } from "./permission-error.ts";

export const KINTONE_ROOT = "kintone";
export const INBOX = "inbox";
/** 1.x の作業フォルダーの環境の定義（2.0.0 から読まない。あれば移行を求めて止まる） */
export const LEGACY_WORKSPACE_FILE = "environments.json";
/** アプリのフォルダーの印（15.5） */
export const APP_MARKER = ".formula-app.json";
/** 設定画面のダウンロードのファイル名の接頭辞（kit の exportFileName。計算式プラグインの src/config/main.ts の exportPrefix） */
export const SNAPSHOT_PREFIX = "rex0220-formula";
export const SNAPSHOT_RE = /^rex0220-formula-app(\d+)-(\d{8})-(\d{6})\.json$/;
export const EDIT_RE = /^rex0220-formula-app(\d+)-(\d{8})-(\d{6})-edit\.json$/;

const MARKER_MAX_BYTES = 4 * 1024;

export class WorkspaceError extends Error {}

/**
 * 動く形（15.4、15.11。r3 MAJOR 7）: single（1 接続の形。CLI だけ）、profiles（接続のファイルがある）、not-configured（MCP で接続のファイルが無い）、
 * legacy-blocked（接続のファイルが無く environments.json がある）。どの形でも settings/ などのローカルの操作は動く。kintone/** を読む・書くのは profiles だけ
 */
export type WorkspaceMode =
  | { kind: "single" }
  | { kind: "profiles"; connections: ProfilesContext }
  | { kind: "not-configured" }
  | { kind: "legacy-blocked" };

/** profile の形の文脈: 呼び出しの初めに読んだ接続（秘密を含む。外に出さない）と、確定の前に読み直す関数 */
export interface ProfilesContext {
  set: ConnectionSet;
  reload: () => ConnectionSet;
}

export interface ModeOptions {
  /** 接続のファイルの絶対パス（設定されていなければ undefined、設定されていて空なら ""） */
  configFile: string | undefined;
  /** そのプロセスが知っている作業フォルダー（この中の接続のファイルは使わない） */
  workspaceRoots: readonly string[];
  /** env: と passwordEnv を引く環境変数 */
  env: Env;
  /** 接続のファイルが無いときの形: CLI は single（.env の 1 接続）、MCP は not-configured */
  surface: "cli" | "mcp";
}

/** 1.x の environments.json があるか（リンク切れの symlink も「ある」） */
export function hasLegacyConfig(cwd: string): boolean {
  try {
    lstatSync(path.join(cwd, LEGACY_WORKSPACE_FILE));
    return true;
  } catch {
    return false;
  }
}

/** 移行で止まっているときの誤り（kintone を使う操作と kintone/** の操作が投げる） */
export function legacyBlockedError(): ConnectionError {
  return new ConnectionError(
    `${LEGACY_WORKSPACE_FILE} は tools 2.0.0 から使わない。kintone の接続のファイル（ksql.config.json と同じ形）を書いて設定し（CLI は FORMULA_KINTONE_CONFIG）、${LEGACY_WORKSPACE_FILE} を消す（バージョンアップ手順）`,
    "legacy-config-present"
  );
}

/**
 * 動く形を決める（15.4 の表）。接続のファイルが設定されていれば読む（空・読めない・形が違うのは誤り。1 接続の形に戻らない）。
 * 設定されていなければ、environments.json があれば legacy-blocked、無ければ CLI は single、MCP は not-configured
 */
export function modeOf(cwd: string, opt: ModeOptions): WorkspaceMode {
  if (opt.configFile !== undefined) {
    if (!opt.configFile.trim()) throw new ConnectionError("kintone の接続のファイル（FORMULA_KINTONE_CONFIG）が空。ファイルのパスを書くか、設定を消す", "unreadable");
    const load = (): ConnectionSet => loadConnections(opt.configFile, { workspaceRoots: opt.workspaceRoots, env: opt.env });
    return { kind: "profiles", connections: { set: load(), reload: load } };
  }
  if (hasLegacyConfig(cwd)) return { kind: "legacy-blocked" };
  return opt.surface === "cli" ? { kind: "single" } : { kind: "not-configured" };
}

/** kintone を使う操作・アプリのフォルダーの操作の前に: profile の形でなければ止める（未設定・移行で止まっている・1 接続の形の理由で） */
export function requireProfiles(mode: WorkspaceMode, what: string): ProfilesContext {
  if (mode.kind === "profiles") return mode.connections;
  if (mode.kind === "legacy-blocked") throw legacyBlockedError();
  if (mode.kind === "not-configured") throw new ConnectionError("kintone の接続のファイルが設定されていない（ksql.config.json と同じ形のファイルを設定に選ぶ）", "not-configured");
  throw new ConnectionError(`${what} は kintone の接続のファイル（FORMULA_KINTONE_CONFIG）があるときだけ使える`, "not-configured");
}

/** アプリのフォルダーの名前（番号-アプリ名。名前が使えなければ番号だけ） */
export function folderNameOf(appId: number, appName: string): string {
  const name = safeFileName(appName, "");
  return name ? `${appId}-${name}` : String(appId);
}

export function profileDirOf(cwd: string, profile: string): string {
  if (!PROFILE_NAME_RE.test(profile)) throw new WorkspaceError(`profile の名前が使えない: ${profile.slice(0, 40)}`);
  return path.join(cwd, KINTONE_ROOT, profile);
}

/**
 * フォルダー・ファイルの実体（symlink を解いたもの）が作業フォルダーの中か。外なら一覧を作らず・読まずに PathError。リンク切れ・ループも PathError
 * （kintone/<profile> や inbox が外への symlink のとき、外のファイルの名前を出さない。B1 の Codex レビュー BLOCKER 1）
 */
export function assertInsideWorkspace(cwd: string, p: string): void {
  const rel = path.relative(cwd, p);
  const root = realResolve(".", cwd);
  if (!isInside(realResolve(rel, cwd), root)) throw new PathError(`${rel} の実体が作業フォルダーの外を指している（symlink など）`);
}

/** 今あるアプリのフォルダー（番号で探す。無ければ null。同じ番号が 2 つあれば止まる）。kintone/ と profile のフォルダーの実体が作業フォルダーの中のときだけ一覧する */
export function findAppDir(cwd: string, profile: string, appId: number): string | null {
  const dir = profileDirOf(cwd, profile);
  if (!existsSync(dir)) return null;
  assertInsideWorkspace(cwd, path.join(cwd, KINTONE_ROOT));
  assertInsideWorkspace(cwd, dir);
  const hits = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && (d.name === String(appId) || d.name.startsWith(`${appId}-`)))
    .map((d) => d.name);
  if (hits.length > 1) throw new WorkspaceError(`アプリ ${appId} のフォルダーが 2 つある: ${hits.join(", ")}（kintone/${profile}/ の下を 1 つにする）`);
  return hits.length ? path.join(dir, hits[0]) : null;
}

/** アプリのフォルダー（あればそれ、無ければ 番号-アプリ名 で作る場所。作るのは ensureAppFolder） */
export function appDirFor(cwd: string, profile: string, appId: number, appName: string): string {
  return findAppDir(cwd, profile, appId) ?? path.join(profileDirOf(cwd, profile), folderNameOf(appId, appName));
}

/** ファイルが kintone/<profile>/<番号>-…/ の中（records/ などの下を含む）なら、そのフォルダーと profile と番号 */
export function appFolderOfFile(cwd: string, file: string): { dir: string; profile: string; appId: number } | null {
  const rel = path.relative(path.join(cwd, KINTONE_ROOT), path.resolve(cwd, file)).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const [profile, folder, ...rest] = rel.split("/");
  if (!profile || !folder || rest.length === 0 || !PROFILE_NAME_RE.test(profile)) return null;
  const m = folder.match(/^([1-9]\d*)(?:-|$)/);
  if (!m) return null;
  return { dir: path.join(cwd, KINTONE_ROOT, profile, folder), profile, appId: Number(m[1]) };
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** ダウンロードと同じ名前（kit の exportFileName と同じ。日時はこの PC の時刻） */
export function snapshotNameOf(appId: number, now: Date = new Date()): string {
  return `${SNAPSHOT_PREFIX}-app${appId}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
}

export function editNameOf(snapshotFile: string): string {
  return snapshotFile.replace(/\.json$/, "-edit.json");
}

// ---- アプリのフォルダーの印（15.5） ----

export interface AppMark {
  schemaVersion: 1;
  profile: string;
  origin: string;
  guestSpaceId: number | null;
  appId: number;
}

export function markOf(def: ProfileDef, appId: number): AppMark {
  return { schemaVersion: 1, profile: def.profile, origin: def.baseUrl, guestSpaceId: def.guestSpaceId, appId };
}

export type AppMarkState = { state: "missing" } | { state: "invalid" } | { state: "ok"; mark: AppMark };

/** 印を読む（無い・壊れている・読めた） */
export function readAppMark(dir: string): AppMarkState {
  const file = path.join(dir, APP_MARKER);
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return { state: "missing" };
  }
  if (!st.isFile() || st.size > MARKER_MAX_BYTES) return { state: "invalid" };
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const ok =
      v &&
      v.schemaVersion === 1 &&
      typeof v.profile === "string" &&
      typeof v.origin === "string" &&
      (v.guestSpaceId === null || (typeof v.guestSpaceId === "number" && Number.isSafeInteger(v.guestSpaceId))) &&
      typeof v.appId === "number" &&
      Number.isSafeInteger(v.appId);
    return ok ? { state: "ok", mark: v as unknown as AppMark } : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

/** アプリのフォルダーの印が、今の接続のこのアプリのものか（無い・壊れている・違うは ConnectionError。conflict） */
export function assertAppMark(dir: string, def: ProfileDef, appId: number): void {
  const shownDir = `kintone/${def.profile}/${path.basename(dir)}`;
  const r = readAppMark(dir);
  if (r.state === "missing") {
    throw new ConnectionError(`${shownDir} に印（${APP_MARKER}）が無い。tools が作ったフォルダーでないので使わない（名前を変えて退け、fields か pull で作り直す。中のファイルは後で移す）`, "app-marker-missing");
  }
  if (r.state === "invalid") throw new ConnectionError(`${shownDir} の印（${APP_MARKER}）が壊れている。名前を変えて退け、fields か pull で作り直す`, "app-marker-invalid");
  const m = r.mark;
  if (m.appId !== appId || !sameIdentity({ profile: m.profile, baseUrl: m.origin, host: "", guestSpaceId: m.guestSpaceId }, { profile: def.profile, baseUrl: def.baseUrl, host: "", guestSpaceId: def.guestSpaceId })) {
    throw new ConnectionError(`${shownDir} は別の接続（profile・接続先・ゲストスペース・アプリのどれかが違う）のフォルダー。profile の接続を変えたなら、名前を変えて退け、fields か pull で作り直す`, "app-identity-conflict");
  }
}

/**
 * アプリのフォルダーを使う（fields / pull / take だけが呼ぶ。15.5）。あれば印を確かめる。無ければ、同じ親の一時フォルダー（. で始まる名前）に印を置いてから
 * 最後の名前に付け替える（途中で止まっても印の無いフォルダーを残さない。r3 MINOR 1）。付け替えの先が既にあれば（同時に作った）、その印を確かめて使う。
 * dir は appDirFor の値（書ける場所と許可は呼ぶ側が先に確かめる）
 */
export function ensureAppFolder(dir: string, def: ProfileDef, appId: number): void {
  if (existsSync(dir)) {
    assertAppMark(dir, def, appId);
    return;
  }
  const parent = path.dirname(dir);
  mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(dir)}.${randomBytes(6).toString("hex")}.tmp`);
  mkdirSync(tmp);
  try {
    writeFileSync(path.join(tmp, APP_MARKER), JSON.stringify(markOf(def, appId), null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    if (existsSync(dir)) {
      // 確かめた後にほかの処理が作った
      rmSync(tmp, { recursive: true, force: true });
    } else {
      try {
        renameSync(tmp, dir);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY" && code !== "EPERM") throw e;
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  assertAppMark(dir, def, appId);
}

/**
 * kintone/** の中のファイル・フォルダーを通常の操作で読む・一覧する前に（15.5、r3 MAJOR 3）: profile の形で、フォルダーの profile が接続のファイルにあり、
 * 印が今の接続のこのアプリのものか。kintone/ の外なら何もしない。profile が無い = denied（PermissionError）、印 = conflict（ConnectionError）
 */
export function assertUsableInKintone(cwd: string, file: string, mode: WorkspaceMode): void {
  const abs = path.resolve(cwd, file);
  if (!isInside(abs, path.join(cwd, KINTONE_ROOT))) return;
  if (mode.kind !== "profiles") {
    if (mode.kind === "legacy-blocked") throw legacyBlockedError();
    throw new PermissionError("kintone/ の下は、kintone の接続のファイルがあるときだけ使う（今の形では settings/ などを使う）");
  }
  const folder = appFolderOfFile(cwd, abs);
  if (!folder) throw new PermissionError(`アプリのフォルダー（kintone/<profile>/<番号>-…/）の中でない: ${path.relative(cwd, abs)}`);
  const def = mode.connections.set.profiles.get(folder.profile);
  if (!def) throw new PermissionError(`profile「${folder.profile}」は接続のファイル（${mode.connections.set.fileName}）に無い（使われていないフォルダー）`);
  assertAppMark(folder.dir, def, folder.appId);
}

// ---- 一覧 ----

export interface AppFolderList {
  dir: string;
  hasFields: boolean;
  /** ダウンロードと pull（新しい順） */
  snapshots: string[];
  /** 直したもの（新しい順） */
  edits: string[];
  /** AI が作った設定など、その他の json（. で始まる印などは出さない） */
  others: string[];
  records: string[];
}

const stampOf = (name: string): string => {
  const m = name.match(/-(\d{8})-(\d{6})(?:-edit)?\.json$/);
  return m ? `${m[1]}${m[2]}` : "";
};
const newestFirst = (a: string, b: string): number => stampOf(b).localeCompare(stampOf(a)) || b.localeCompare(a);

/** アプリのフォルダーの一覧。cwd を渡すと、フォルダーと records の実体が作業フォルダーの中か確かめてから一覧する */
export function listAppFolder(dir: string, cwd?: string): AppFolderList {
  if (cwd !== undefined) for (const d of [dir, path.join(dir, "records")]) if (existsSync(d)) assertInsideWorkspace(cwd, d);
  const files = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
  const names = files.filter((d) => d.isFile() && d.name.endsWith(".json") && !d.name.startsWith(".")).map((d) => d.name);
  const sub = (name: string, filter: (n: string) => boolean): string[] => {
    const p = path.join(dir, name);
    return existsSync(p) ? readdirSync(p).filter((n) => !n.startsWith(".") && filter(n)).sort() : [];
  };
  return {
    dir,
    hasFields: names.includes("fields.json"),
    snapshots: names.filter((n) => SNAPSHOT_RE.test(n)).sort(newestFirst),
    edits: names.filter((n) => EDIT_RE.test(n)).sort(newestFirst),
    others: names.filter((n) => n !== "fields.json" && !SNAPSHOT_RE.test(n) && !EDIT_RE.test(n)).sort(),
    records: sub("records", (n) => n.endsWith(".json"))
  };
}

/** profile のフォルダーの中のアプリのフォルダーと印の状態（診断と files の一覧。中身は返さない。15.5） */
export function appFoldersOf(cwd: string, def: ProfileDef): Array<{ name: string; appId: number | null; mark: "ok" | "missing" | "invalid" | "conflict" }> {
  const dir = profileDirOf(cwd, def.profile);
  if (!existsSync(dir)) return [];
  assertInsideWorkspace(cwd, path.join(cwd, KINTONE_ROOT));
  assertInsideWorkspace(cwd, dir);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const m = d.name.match(/^([1-9]\d*)(?:-|$)/);
      const appId = m ? Number(m[1]) : null;
      const r = readAppMark(path.join(dir, d.name));
      if (r.state !== "ok") return { name: d.name, appId, mark: r.state };
      const ok = appId !== null && r.mark.appId === appId && r.mark.profile === def.profile && r.mark.origin === def.baseUrl && r.mark.guestSpaceId === def.guestSpaceId;
      return { name: d.name, appId, mark: ok ? ("ok" as const) : ("conflict" as const) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** kintone/ の下の profile のフォルダーのうち、接続のファイルに無いもの（使われていないフォルダー。診断で名前だけ示す） */
export function unusedProfileDirs(cwd: string, set: ConnectionSet): string[] {
  const root = path.join(cwd, KINTONE_ROOT);
  if (!existsSync(root)) return [];
  assertInsideWorkspace(cwd, root);
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !set.profiles.has(d.name))
    .map((d) => d.name)
    .sort();
}
