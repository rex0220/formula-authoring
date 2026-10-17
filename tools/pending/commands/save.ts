/**
 * 保存の約束（段階 0-2 の段 5。print-craft-authoring-mcp の実装案 5.3。print-craft MCP の pcraft_save_settings / pcraft_update_button の本体）。
 *   - 新しい設定（saveNewSettings）: expectedAbsent: true が要る。同じ名前のファイルがあれば conflict（上書きしない）
 *   - 既存の設定のボタン 1 つ（updateButton）: 読んだ時点の digest（expectedDigest）を確かめ、違えば conflict。ボタンは menu の名前で選ぶ。
 *     無ければ末尾に足す
 *   - 項目定義: アプリのフォルダーの中なら常に同じフォルダーの fields.json（別のファイルを渡されたら拒否。Codex レビュー MAJOR 4）。
 *     それ以外は引数の fields が要る
 *   - 入力の大きさ: content / replacement は 256 KiB まで（印刷屋の保存値の上限に合わせる）
 *   - 確定の仕方: normalize（エラーが 1 つでもあれば確定しない）→ 書ける場所・kintone/ の下の許可（profile の形、印、ダウンロードのファイル）を確かめ、
 *     書く先のフォルダーが無ければ作る（kintone/ の下のアプリのフォルダーは作らない。先に fields か pull）→ 確定先と同じフォルダーに一時ファイル → ロックを取る →
 *     書ける場所・kintone/ の下の許可と接続（接続のファイルを読み直す）・digest・ロックがまだ自分のものかをもう一度確かめる → 確定 → 片付け。
 *     新しい設定はハードリンクで確定し（同じ名前があれば失敗する = 上書きしない）、既存の設定は名前の付け替えで確定する
 *     （Codex レビュー MAJOR 5: 確かめてから確定までの間に作られた・変えられたファイルを上書きしない）
 *   - ロックと片付けは commit-file.ts（所有者の印付きのロック、60 秒より古いロックの回収。一時ファイルとロックの片付けは別々に試し、
 *     確定の後の片付けの失敗は確定の失敗にしない＝ ok に cleanup の文を添える。Codex 再レビュー MAJOR 3、4）
 *   - 警告は確定を止めない（findings で返す）
 *   - 状態: ok / invalid（normalize のエラー、入力の誤り、知らない profile）/ conflict（同じ名前がある、digest が違う、競合、アプリのフォルダーの印、
 *     途中で接続が変わった）/ denied（書けない場所、ダウンロードのファイル、作業フォルダーの外、接続のファイルに無い profile）/ failed（接続のファイルの誤り、
 *     移行で止まっている、読み書きの失敗など想定外）。code に誤りの種類（接続の誤りは ConnectionError の code。print-craft MCP の 5.2、15.10 の約束）
 * パスは作業フォルダーからの相対で受け取る（..・絶対パス・ドライブ名は safe-path.ts が止める）。
 */
import { createHash } from "node:crypto";
import { jsonErrorWhere } from "../json-error.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Engine } from "../engine.ts";
import type { Policy } from "../normalize/policy.ts";
import type { Finding } from "../normalize/findings.ts";
import { PathError, WRITE_ROOTS, resolveRead, resolveWrite } from "../safe-path.ts";
import { PermissionError, assertChangeAllowed } from "../permission.ts";
import { SNAPSHOT_RE, appFolderOfFile, assertUsableInKintone, type WorkspaceMode } from "../workspace.ts";
import { ConnectionError } from "../connections.ts";
import { InputError, normalizeSettings, readFieldsFile } from "./normalize.ts";
import { FileExistsError, LockBusyError, acquireLock, cleanupAll, placeNew, tempPathFor, withRetry, type Lock } from "../commit-file.ts";

export type SaveStatus = "ok" | "invalid" | "conflict" | "denied" | "failed";

export interface SaveResult {
  status: SaveStatus;
  /** 作業フォルダーからの相対パス（区切りは /） */
  path: string;
  /** 確定したファイルの digest（sha256。ok のとき） */
  digest?: string;
  findings: Finding[];
  /** status が ok でないときの理由（決まった文） */
  message?: string;
  /** status が ok でないときの誤りの種類（ConflictError、PermissionError、PathError、InputError など。想定外の失敗は Error） */
  code?: string;
  /** ok だが、確定の後に一時ファイルかロックを消せなかった（確定はしている。利用者に伝えて消してもらう） */
  cleanup?: string[];
}

export interface SaveContext {
  /** 作業フォルダーの実際のパス（WorkContext.root） */
  root: string;
  engine: Engine;
  policy: Policy;
  /** iframe の同一オリジンの判定に使う接続先（検証済み） */
  baseUrl?: string;
  /** 動く形（kintone/ の下を読む・変えてよいか。workspace.ts の modeOf） */
  mode: WorkspaceMode;
  /** 試験用: 確定の直後（片付けの前）に呼ぶ。print-craft MCP と CLI は渡さない */
  afterPlace?: () => void;
}

/** 入力（content / replacement）の上限（バイト） */
export const MAX_SAVE_INPUT_BYTES = 256 * 1024;

/** ファイルの digest（sha256。pcraft_buttons が返し、pcraft_update_button が照合する） */
export function digestOf(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

const rel = (root: string, abs: string): string => path.relative(root, abs).replace(/\\/g, "/");

class SaveDenied extends Error {}
class ConflictError extends Error {}

/** 項目定義: アプリのフォルダーの中なら同じフォルダーの fields.json だけ。それ以外は引数の fields が要る */
function fieldsFileFor(ctx: SaveContext, target: string, fields: string | undefined): string {
  const folder = appFolderOfFile(ctx.root, target);
  if (folder) {
    const own = resolveRead(path.join(folder.dir, "fields.json"), ctx.root);
    assertUsableInKintone(ctx.root, own, ctx.mode);
    if (!existsSync(own)) throw new InputError(`アプリのフォルダーに fields.json が無い: ${rel(ctx.root, own)}（fields コマンドか pcraft_fields で取る）`);
    if (fields !== undefined && resolveRead(fields, ctx.root) !== own) throw new SaveDenied(`アプリのフォルダーの中の設定は、同じフォルダーの fields.json で検査する（fields は渡さないか、${rel(ctx.root, own)} にする）`);
    return own;
  }
  if (!fields) throw new InputError("fields（項目定義のファイル）が要る（アプリのフォルダー kintone/<profile>/<番号>-…/ の中なら同じフォルダーの fields.json を使う）");
  const file = resolveRead(fields, ctx.root);
  assertUsableInKintone(ctx.root, file, ctx.mode);
  if (!existsSync(file)) throw new InputError(`項目定義のファイルが無い: ${rel(ctx.root, file)}（fields コマンドか pcraft_fields で取る）`);
  return file;
}

function tooLarge(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MAX_SAVE_INPUT_BYTES;
}

/** 一時ファイルを書き、ロックを取って確かめ直してから確定する。確定したら digest と片付けの失敗の文を返す */
function commit(ctx: SaveContext, target: string, text: string, mode: "new" | "replace", recheck: () => void): { digest: string; cleanup: string[] } {
  const tmp = tempPathFor(target);
  let lock: Lock | undefined;
  let digest: string | undefined;
  let failure: unknown;
  // 書く先（symlink の差し替えを含む）、kintone/ の下の許可（profile、印、操作 × 場所、接続のファイルを読み直して接続が同じか）、ダウンロードのファイル
  const checkTarget = (): void => {
    if (resolveWrite(rel(ctx.root, target), WRITE_ROOTS.settings, ctx.root) !== target) throw new SaveDenied("書く先のフォルダーが途中で変わった（symlink など）");
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
    if (SNAPSHOT_RE.test(path.basename(target))) throw new SaveDenied("ダウンロード / pull のファイルは書き換えない。edit で -edit.json に写して直す");
  };
  try {
    // 一時ファイルとロックを作る前にも（normalize の間に接続が変わったフォルダー・差し替えられたフォルダーに何も作らない。Codex 再々レビュー MAJOR 1）
    checkTarget();
    // 書く先のフォルダー（まだ settings/ が無い作業フォルダーなど）を作る。書ける場所と許可を確かめた後だけ（0-3b の試作で見つけた）
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    lock = acquireLock(target);
    // 確定の直前にもう一度。digest / 無いことも
    checkTarget();
    recheck();
    // 長く止まっている間に、古いとみなされて他の保存にロックを取られていたら確定しない
    if (!lock.owned()) throw new ConflictError("ロックを失った（保存が 60 秒より長く止まった）。pcraft_buttons で読み直してやり直す");
    if (mode === "new") withRetry(() => placeNew(tmp, target));
    else withRetry(() => renameSync(tmp, target));
    digest = digestOf(text);
    ctx.afterPlace?.();
  } catch (e) {
    failure = e;
  }
  const cleanup = cleanupAll([...(lock ? [() => void lock!.release()] : []), () => rmSync(tmp, { force: true })]);
  if (digest === undefined) throw failure;
  return { digest, cleanup };
}

async function normalizeText(ctx: SaveContext, target: string, text: string, fields: string | undefined) {
  const fieldsData = await readFieldsFile(fieldsFileFor(ctx, target, fields));
  ctx.engine.setContext({ baseUrl: ctx.baseUrl ?? "https://example.cybozu.com", appId: fieldsData.appId });
  return normalizeSettings({ settingsText: text, settingsFile: rel(ctx.root, target), fields: fieldsData, engine: ctx.engine, policy: ctx.policy, baseUrl: ctx.baseUrl });
}

/**
 * 誤りを状態に分ける（print-craft MCP の 5.2 の約束）: 競合は conflict、書けない場所・本番・ダウンロードのファイル・作業フォルダーの外は denied、
 * 入力（項目定義のファイル、JSON）の誤りは invalid、それ以外（読み書きの失敗など想定外）は failed。以前は失敗をすべて denied にしていた
 */
function statusOf(e: unknown): Exclude<SaveStatus, "ok"> {
  if (e instanceof ConnectionError) return connectionStatusOf(e);
  if (e instanceof ConflictError || e instanceof FileExistsError || e instanceof LockBusyError) return "conflict";
  if (e instanceof SaveDenied || e instanceof PermissionError || e instanceof PathError) return "denied";
  if (e instanceof InputError || e instanceof SyntaxError) return "invalid";
  return "failed";
}

/** 接続の誤りの状態（print-craft MCP の 15.10 の表） */
export function connectionStatusOf(e: ConnectionError): Exclude<SaveStatus, "ok"> {
  switch (e.code) {
    case "inside-workspace":
      return "denied";
    case "unknown-profile":
    case "guest-mismatch":
      return "invalid";
    case "app-marker-missing":
    case "app-marker-invalid":
    case "app-identity-conflict":
    case "connection-changed":
      return "conflict";
    default:
      return "failed";
  }
}

function codeOf(e: unknown): string {
  if (e instanceof ConnectionError) return e.code;
  if (e instanceof ConflictError || e instanceof FileExistsError || e instanceof LockBusyError) return "ConflictError";
  if (e instanceof SaveDenied || e instanceof PermissionError) return "PermissionError";
  return e instanceof Error ? e.constructor.name : "Error";
}

function errorResult(root: string, target: string, e: unknown, findings: Finding[] = []): SaveResult {
  return { status: statusOf(e), code: codeOf(e), path: rel(root, target), findings, message: e instanceof Error ? e.message : String(e) };
}

function finish(ctx: SaveContext, target: string, findings: Finding[], run: () => { digest: string; cleanup: string[] }): SaveResult {
  try {
    const { digest, cleanup } = run();
    return { status: "ok", path: rel(ctx.root, target), digest, findings, ...(cleanup.length ? { cleanup, message: `確定したが、一時ファイルかロックを消せなかった（.${path.basename(target)}.* を消してよい）` } : {}) };
  } catch (e) {
    return errorResult(ctx.root, target, e, findings);
  }
}

/** 新しい設定を保存する（expectedAbsent: true が要る。同じ名前のファイルがあれば conflict） */
export async function saveNewSettings(ctx: SaveContext, opt: { path: string; content: string; fields?: string; expectedAbsent: true }): Promise<SaveResult> {
  if (opt.expectedAbsent !== true) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: "新しい設定の保存は expectedAbsent: true が要る（既存のファイルを直すなら pcraft_update_button）" };
  if (tooLarge(opt.content)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `content は ${MAX_SAVE_INPUT_BYTES} バイトまで` };
  let target: string;
  try {
    target = resolveWrite(opt.path, WRITE_ROOTS.settings, ctx.root);
    if (SNAPSHOT_RE.test(path.basename(target))) throw new SaveDenied("ダウンロード / pull の名前（rex0220-print-craft-app<番号>-<日時>.json）では新しく保存しない");
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
  } catch (e) {
    return errorResult(ctx.root, path.resolve(ctx.root, opt.path), e);
  }
  if (existsSync(target)) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "同じ名前のファイルがある（新しい設定の保存は上書きしない。直すなら pcraft_update_button）" };
  let result;
  try {
    result = await normalizeText(ctx, target, opt.content, opt.fields);
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  if (!result.output) return { status: "invalid", code: "NormalizeError", path: rel(ctx.root, target), findings: result.findings.items, message: "normalize のエラーがあるので保存しない" };
  const text = JSON.stringify(result.output, null, 2) + "\n";
  return finish(ctx, target, result.findings.items, () =>
    commit(ctx, target, text, "new", () => {
      if (existsSync(target)) throw new ConflictError("確定の直前に同じ名前のファイルができた");
    })
  );
}

/**
 * 既存の設定のボタン 1 つを差し替える（無ければ末尾に足す）。expectedDigest は pcraft_buttons（buttons --json）が返した値。
 * replacement はボタン 1 つ（pluginInfos の 1 行）の JSON。その menu が button と違えば invalid
 */
export async function updateButton(ctx: SaveContext, opt: { path: string; button: string; expectedDigest: string; replacement: string; fields?: string }): Promise<SaveResult> {
  if (tooLarge(opt.replacement)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `replacement は ${MAX_SAVE_INPUT_BYTES} バイトまで` };
  let target: string;
  try {
    target = resolveRead(opt.path, ctx.root);
    resolveWrite(opt.path, WRITE_ROOTS.settings, ctx.root);
    if (SNAPSHOT_RE.test(path.basename(target))) throw new SaveDenied("ダウンロード / pull のファイルは書き換えない。edit で -edit.json に写して直す");
    assertUsableInKintone(ctx.root, target, ctx.mode);
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
  } catch (e) {
    return errorResult(ctx.root, path.resolve(ctx.root, opt.path), e);
  }
  if (!existsSync(target)) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "ファイルが無い（新しい設定なら pcraft_save_settings）" };
  const current = readFileSync(target);
  if (digestOf(current) !== opt.expectedDigest) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "読んだ後にファイルが変わった（digest が違う）。pcraft_buttons で読み直す" };
  let settings: Record<string, unknown>;
  let replacement: Record<string, unknown>;
  try {
    settings = JSON.parse(current.toString("utf8")) as Record<string, unknown>;
  } catch (e) {
    return { status: "invalid", code: "InputError", path: rel(ctx.root, target), findings: [], message: `設定のファイルを JSON として読めない${jsonErrorWhere(e)}（中身は返さない）` };
  }
  try {
    replacement = JSON.parse(opt.replacement) as Record<string, unknown>;
  } catch (e) {
    return { status: "invalid", code: "InputError", path: rel(ctx.root, target), findings: [], message: `replacement を JSON として読めない${jsonErrorWhere(e)}（中身は返さない）` };
  }
  if (!replacement || typeof replacement !== "object" || Array.isArray(replacement) || replacement.menu !== opt.button) {
    return { status: "invalid", code: "InputError", path: rel(ctx.root, target), findings: [], message: "replacement はボタン 1 つ（pluginInfos の 1 行）のオブジェクトで、menu が button と同じ" };
  }
  const rows = Array.isArray(settings.pluginInfos) ? [...(settings.pluginInfos as Array<Record<string, unknown>>)] : [];
  const i = rows.findIndex((r) => r && r.menu === opt.button);
  if (i >= 0) rows[i] = replacement;
  else rows.push(replacement);
  let result;
  try {
    result = await normalizeText(ctx, target, JSON.stringify({ ...settings, pluginInfos: rows }), opt.fields);
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  if (!result.output) return { status: "invalid", code: "NormalizeError", path: rel(ctx.root, target), findings: result.findings.items, message: "normalize のエラーがあるので保存しない" };
  const text = JSON.stringify(result.output, null, 2) + "\n";
  return finish(ctx, target, result.findings.items, () =>
    commit(ctx, target, text, "replace", () => {
      if (digestOf(readFileSync(target)) !== opt.expectedDigest) throw new ConflictError("確定の直前にファイルが変わった（digest が違う）。pcraft_buttons で読み直す");
    })
  );
}
