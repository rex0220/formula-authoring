/**
 * 保存の約束（tools 0.2.0。計画 24.2.1 / 24.4。print-craft-authoring tools 2.0.0 の save.ts（print-craft MCP の pcraft_save_settings / pcraft_update_button の本体）を計算式用に。
 * formula MCP の fml_save_settings / fml_update_fields の本体。CLI は使わない）。
 *   - 新しい設定（saveNewSettings）: expectedAbsent: true が要る。同じ名前のファイルがあれば conflict（上書きしない）。
 *     ダウンロード / pull の名前（rex0220-formula-app<番号>-<日時>.json）と -edit.json の名前では新しく保存しない（-edit.json は edit で写す）
 *   - 既存の設定の項目の行（updateFields）: 読んだ時点の digest（expectedDigest）を確かめ、違えば conflict。rows（fieldcode の行。1〜50 行）を
 *     fieldcode で差し替える（行の元の値 state / formulaSet / edit / hide / rank だけ。設定に無い fieldcode には足さない = 項目はアプリの項目定義で決まる）。
 *     common（pluginInfos と封筒以外の最上位のキー）はキーごとに丸ごと置き換える
 *   - 項目定義: アプリのフォルダーの中なら常に同じフォルダーの fields.json（別のファイルを渡されたら拒否）。それ以外は引数の fields、無ければ封筒の appId の fields/<appId>.json
 *   - 検査（normalize）は tools の runEval（Worker。時間上限）で行う。エラーが 1 つでもあれば確定しない。警告は確定を止めない（findings で返す）
 *   - 入力の大きさ: content / rows / common は 256 KiB まで
 *   - 確定の仕方: normalize → 書ける場所・kintone/ の下の許可（profile の形、印、ダウンロードのファイル）を確かめ、書く先のフォルダーが無ければ作る
 *     （kintone/ の下のアプリのフォルダーは作らない。先に fields か pull）→ 確定先と同じフォルダーに一時ファイル → ロックを取る →
 *     書ける場所・許可と接続（接続のファイルを読み直す）・digest・ロックがまだ自分のものかをもう一度確かめる → 確定 → 片付け。
 *     新しい設定はハードリンクで確定し（同じ名前があれば失敗する = 上書きしない）、既存の設定は名前の付け替えで確定する
 *   - ロックと片付けは commit-file.ts（所有者の印付きのロック、60 秒より古いロックの回収。確定の後の片付けの失敗は確定の失敗にしない = ok に cleanup の文を添える）
 *   - 状態: ok / invalid（normalize のエラー、入力の誤り、知らない profile）/ conflict（同じ名前がある、digest が違う、競合、アプリのフォルダーの印、途中で接続が変わった）/
 *     denied（書けない場所、ダウンロードのファイル、作業フォルダーの外、接続のファイルに無い profile）/ failed（接続のファイルの誤り、移行で止まっている、zip が読めない、
 *     時間切れ、読み書きの失敗など想定外）。code に誤りの種類（接続の誤りは ConnectionError の code。print-craft MCP の 5.2、15.10 の約束）
 * パスは作業フォルダーからの相対で受け取る（..・絶対パス・ドライブ名は safe-path.ts が止める）。応答の文に設定・レコードの中身を入れない
 * 項目検証の保存（fv/save.ts。tools 0.6.0）も、ここの部品（入力の読み方、項目定義の決め方、検査、確定、誤りの分け方）を使う
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { jsonErrorWhere } from "../json-error.ts";
import { InputError, readFieldsFile } from "../input.ts";
import { FORMULA_CONFIG_PLUGIN_ID } from "../meta.ts";
import { ENVELOPE_KEYS, ROW_SOURCE_KEYS, type Lang } from "../normalize/model.ts";
import type { Policy } from "../normalize/policy.ts";
import type { Finding } from "../normalize/findings.ts";
import { PathError, WRITE_ROOTS, resolveRead, resolveWrite } from "../safe-path.ts";
import { PermissionError, assertChangeAllowed } from "../permission.ts";
import { appFolderOfFile, assertUsableInKintone, isEditName, isSnapshotName, type WorkspaceMode } from "../workspace.ts";
import { ConnectionError } from "../connections.ts";
import { DEFAULT_USERS, type UsersOrigin, type UsersSource } from "../users/index.ts";
import { diffSettings, type FieldChange } from "./diff.ts";
import { FileExistsError, LockBusyError, acquireLock, cleanupAll, placeNew, tempPathFor, withRetry, type Lock } from "../commit-file.ts";
import { EvalError, EvalTimeoutError, runEval, type RunOptions } from "../worker/run.ts";
import { builtinErrorName } from "../worker/eval-run.ts";
import type { EvalJob, EvalOutcome } from "../worker/eval-job.ts";

export type SaveStatus = "ok" | "invalid" | "conflict" | "denied" | "failed";

export interface SaveResult {
  status: SaveStatus;
  /** 作業フォルダーからの相対パス（区切りは /） */
  path: string;
  /** 確定したファイルの digest（sha256。ok のとき） */
  digest?: string;
  findings: Finding[];
  /** normalize の要約（検査まで進んだとき） */
  summary?: string;
  /** updateFields: 前の内容と確定した内容の差（項目ごと。affectsRecords = 既存レコードの値に影響する） */
  diff?: { fields: FieldChange[]; common: string[] };
  /** fvUpdateRows: 前の内容と確定した内容の差（fv diff と同じ行の文と、変わった行の項目コード） */
  fvDiff?: { lines: string[]; changed: string[] };
  /** status が ok でないときの理由（決まった文） */
  message?: string;
  /** status が ok でないときの誤りの種類（ConflictError、PermissionError、PathError、InputError、NormalizeError、接続の誤りの code など。想定外の失敗は Error） */
  code?: string;
  /** code が PluginZipError のときの、zip の誤りの種類（MCP が種類ごとの決まった文にする） */
  zipCode?: string;
  /** ok だが、確定の後に一時ファイルかロックを消せなかった（確定はしている。利用者に伝えて消してもらう） */
  cleanup?: string[];
}

/** 評価（normalize）の読み込み元（Worker に渡す。中核は環境変数を読まない） */
export interface EvalSource {
  pluginZip?: string;
  devPluginDir?: string;
  mode?: "build" | "dev";
  /** moment の置き場所（MCP は束ねた本体の隣の vendor/） */
  vendorDir?: string;
}

export interface SaveContext {
  /** 作業フォルダーの実際のパス */
  root: string;
  /** 動く形（kintone/ の下を読む・変えてよいか。workspace.ts の modeOf） */
  mode: WorkspaceMode;
  policy: Policy;
  source: EvalSource;
  /** Worker の動かし方（時間上限、入口、出力の受け取り先） */
  run?: RunOptions;
  /** 評価の文脈の接続先（検証済み。APP_URL などの元） */
  baseUrl?: string;
  /** ユーザー情報のテストデータ（無ければ既定の架空の 10 人） */
  usersSource?: UsersSource;
  usersOrigin?: UsersOrigin;
  lang?: Lang;
  /** 試験用: 確定の直後（片付けの前）に呼ぶ。MCP は渡さない */
  afterPlace?: () => void;
}

/** 入力（content / rows / common）の上限（バイト） */
export const MAX_SAVE_INPUT_BYTES = 256 * 1024;
/** updateFields の rows の行数の上限 */
export const MAX_UPDATE_ROWS = 50;
/** updateFields の common で置き換えられる共通の設定のキー（封筒と pluginInfos 以外の最上位のキー。設定ファイル仕様の順。Codex のレビュー MAJOR 4） */
export const COMMON_KEYS: readonly string[] = ["pluginEnable", "pluginProductEnv", "toolEnable", "pluginComment", "pluginDescription", "pluginBtnInfo", "pluginListInfo", "authority", "pluginMiscInfo"];

/** ファイルの digest（sha256。fml_summary が返し、fml_update_fields が照合する） */
export function digestOf(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export const rel = (root: string, abs: string): string => path.relative(root, abs).replace(/\\/g, "/");

export class SaveDenied extends Error {}
export class ConflictError extends Error {}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** AI の入力の JSON を読む（読めないときは位置だけ。中身は返さない） */
export function parseInput(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new InputError(`${what} を JSON として読めない${jsonErrorWhere(e)}（中身は返さない）`);
  }
}

export function tooLarge(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MAX_SAVE_INPUT_BYTES;
}

/**
 * 項目定義: アプリのフォルダーの中なら同じフォルダーの fields.json だけ。それ以外は引数の fields、無ければ封筒の appId の fields/<appId>.json（CLI の既定と同じ）
 */
export function fieldsFileFor(ctx: SaveContext, target: string, fields: string | undefined, envelope: Record<string, unknown>): string {
  const folder = appFolderOfFile(ctx.root, target);
  if (folder) {
    const own = resolveRead(path.join(folder.dir, "fields.json"), ctx.root);
    assertUsableInKintone(ctx.root, own, ctx.mode);
    if (!existsSync(own)) throw new InputError(`アプリのフォルダーに fields.json が無い: ${rel(ctx.root, own)}（fields コマンドか fml_fields で取る）`);
    if (fields !== undefined && resolveRead(fields, ctx.root) !== own) throw new SaveDenied(`アプリのフォルダーの中の設定は、同じフォルダーの fields.json で検査する（fields は渡さないか、${rel(ctx.root, own)} にする）`);
    return own;
  }
  const appId = typeof envelope.appId === "number" && Number.isInteger(envelope.appId) && envelope.appId > 0 ? envelope.appId : undefined;
  const relFile = fields ?? (appId !== undefined ? path.join("fields", `${appId}.json`) : undefined);
  if (!relFile) throw new InputError("fields（項目定義のファイル）が要る（設定の封筒に appId があれば fields/<appId>.json を既定にする。アプリのフォルダー kintone/<profile>/<番号>-…/ の中なら同じフォルダーの fields.json を使う）");
  const file = resolveRead(relFile, ctx.root);
  assertUsableInKintone(ctx.root, file, ctx.mode);
  if (!existsSync(file)) throw new InputError(`項目定義のファイルが無い: ${rel(ctx.root, file)}（fields コマンドか fml_fields で取る）`);
  return file;
}

/** 検査（Worker で normalize。項目検証は kind "fv-normalize"）。zip が読めない・時間切れは EvalError / EvalTimeoutError のまま投げる（failed） */
export async function normalizeText(ctx: SaveContext, target: string, text: string, fieldsFile: string, kind: "normalize" | "fv-normalize" = "normalize"): Promise<EvalOutcome> {
  const job: EvalJob = {
    kind,
    pluginZip: ctx.source.pluginZip, devPluginDir: ctx.source.devPluginDir, mode: ctx.source.mode, vendorDir: ctx.source.vendorDir,
    baseUrl: ctx.baseUrl, settingsText: text, settingsFile: rel(ctx.root, target), fields: readFieldsFile(fieldsFile),
    usersSource: ctx.usersSource ?? DEFAULT_USERS, usersOrigin: ctx.usersOrigin ?? { kind: "default" }, policy: ctx.policy, lang: ctx.lang
  };
  return runEval(job, ctx.run);
}

/** 一時ファイルを書き、ロックを取って確かめ直してから確定する。確定したら digest と片付けの失敗の文を返す（readAgain = 読み直しに案内するツール） */
export function commit(ctx: SaveContext, target: string, text: string, mode: "new" | "replace", recheck: () => void, readAgain = "fml_summary"): { digest: string; cleanup: string[] } {
  const tmp = tempPathFor(target);
  let lock: Lock | undefined;
  let digest: string | undefined;
  let failure: unknown;
  // 書く先（symlink の差し替えを含む）、kintone/ の下の許可（profile、印、操作 × 場所、接続のファイルを読み直して接続が同じか）、ダウンロードのファイル
  const checkTarget = (): void => {
    if (resolveWrite(rel(ctx.root, target), WRITE_ROOTS.settings, ctx.root) !== target) throw new SaveDenied("書く先のフォルダーが途中で変わった（symlink など）");
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
    if (isSnapshotName(path.basename(target))) throw new SaveDenied("ダウンロード / pull のファイルは書き換えない。edit で -edit.json に写して直す");
  };
  try {
    // 一時ファイルとロックを作る前にも（normalize の間に接続が変わったフォルダー・差し替えられたフォルダーに何も作らない）
    checkTarget();
    // 書く先のフォルダー（まだ settings/ が無い作業フォルダーなど）を作る。書ける場所と許可を確かめた後だけ
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
    lock = acquireLock(target);
    // 確定の直前にもう一度。digest / 無いことも
    checkTarget();
    recheck();
    // 長く止まっている間に、古いとみなされて他の保存にロックを取られていたら確定しない
    if (!lock.owned()) throw new ConflictError(`ロックを失った（保存が 60 秒より長く止まった）。 で読み直してやり直す`);
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

/**
 * 誤りを状態に分ける（print-craft MCP の 5.2 の約束）: 競合は conflict、書けない場所・ダウンロードのファイル・作業フォルダーの外は denied、
 * 入力（項目定義のファイル、JSON）の誤りは invalid、zip が読めない・時間切れ・読み書きの失敗など想定外は failed
 */
function statusOf(e: unknown): Exclude<SaveStatus, "ok"> {
  if (e instanceof ConnectionError) return connectionStatusOf(e);
  if (e instanceof ConflictError || e instanceof FileExistsError || e instanceof LockBusyError) return "conflict";
  if (e instanceof SaveDenied || e instanceof PermissionError || e instanceof PathError) return "denied";
  if (e instanceof InputError || e instanceof SyntaxError) return "invalid";
  if (e instanceof EvalError && e.kind === "input") return "invalid";
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
  if (e instanceof EvalError) return { input: "InputError", zip: "PluginZipError", users: "UsersDataError", policy: "PolicyError", other: e.innerName }[e.kind];
  if (e instanceof EvalTimeoutError) return "EvalTimeoutError";
  if (e instanceof InputError) return "InputError";
  if (e instanceof PathError) return "PathError";
  // それ以外（想定外）は組み込みの名前だけ（name / constructor.name は使わない）
  return builtinErrorName(e);
}

/**
 * 結果に入れる誤りの文: 中核の決まった文（接続、競合、権限、パス、入力、時間切れ、Worker の input / zip / users / policy）はそのまま。
 * Worker の中のそれ以外の例外（zip のコードが投げたもの。値を含みうる）と想定外の誤りは種類だけ（Codex の r2 レビュー R1）
 */
function safeMessageOf(e: unknown): string {
  if (e instanceof ConnectionError || e instanceof ConflictError || e instanceof FileExistsError || e instanceof LockBusyError || e instanceof SaveDenied || e instanceof PermissionError || e instanceof PathError || e instanceof InputError || e instanceof EvalTimeoutError) return e.message;
  if (e instanceof EvalError) return e.kind === "other" ? `評価の途中で想定外の誤り（${e.innerName}）。誤りの文は値やパスを含みうるので返さない` : e.message;
  if (e instanceof SyntaxError) return "JSON の構文の誤り（中身は返さない）";
  return `想定外の誤り（${builtinErrorName(e)}）。誤りの文は値やパスを含みうるので返さない`;
}

export function errorResult(root: string, target: string, e: unknown, findings: Finding[] = []): SaveResult {
  return { status: statusOf(e), code: codeOf(e), path: rel(root, target), findings, message: safeMessageOf(e), ...(e instanceof EvalError && e.kind === "zip" && e.code ? { zipCode: e.code } : {}) };
}

function invalid(root: string, target: string, message: string, code = "InputError"): SaveResult {
  return { status: "invalid", code, path: rel(root, target), findings: [], message };
}

export function finish(ctx: SaveContext, target: string, outcome: EvalOutcome, run: () => { digest: string; cleanup: string[] }, extra: Partial<SaveResult> = {}): SaveResult {
  const findings = outcome.normalize.findings;
  try {
    const { digest, cleanup } = run();
    return {
      status: "ok", path: rel(ctx.root, target), digest, findings, summary: outcome.normalize.summary, ...extra,
      ...(cleanup.length ? { cleanup, message: `確定したが、一時ファイルかロックを消せなかった（.${path.basename(target)}.* を消してよい）` } : {})
    };
  } catch (e) {
    return { ...errorResult(ctx.root, target, e, findings), summary: outcome.normalize.summary };
  }
}

/** 新しい設定を保存する（expectedAbsent: true が要る。同じ名前のファイルがあれば conflict） */
export async function saveNewSettings(ctx: SaveContext, opt: { path: string; content: string; fields?: string; expectedAbsent: true }): Promise<SaveResult> {
  if (opt.expectedAbsent !== true) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: "新しい設定の保存は expectedAbsent: true が要る（既存のファイルを直すなら fml_update_fields）" };
  if (tooLarge(opt.content)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `content は ${MAX_SAVE_INPUT_BYTES.toLocaleString()} バイトまで` };
  let target: string;
  try {
    target = resolveWrite(opt.path, WRITE_ROOTS.settings, ctx.root);
    const name = path.basename(target);
    if (isSnapshotName(name)) throw new SaveDenied("ダウンロード / pull の名前（rex0220-formula-app<番号>-<日時>.json、項目検証は rex0220-field-validation-app…）では新しく保存しない");
    if (isEditName(name)) throw new SaveDenied("-edit.json の名前では新しく保存しない（ダウンロード / pull を直すなら edit（fml_edit）で写してから fml_update_fields）");
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
  } catch (e) {
    return errorResult(ctx.root, path.resolve(ctx.root, opt.path), e);
  }
  if (existsSync(target)) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "同じ名前のファイルがある（新しい設定の保存は上書きしない。直すなら fml_update_fields）" };
  let outcome: EvalOutcome;
  try {
    const envelope = parseInput(opt.content, "content");
    if (!isPlainObject(envelope)) throw new InputError("content の最上位はオブジェクト（封筒形式の設定 JSON）");
    outcome = await normalizeText(ctx, target, opt.content, fieldsFileFor(ctx, target, opt.fields, envelope));
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  if (outcome.normalize.hasErrors || !outcome.normalize.output) return { status: "invalid", code: "NormalizeError", path: rel(ctx.root, target), findings: outcome.normalize.findings, summary: outcome.normalize.summary, message: "normalize のエラーがあるので保存しない" };
  const text = JSON.stringify(outcome.normalize.output, null, 2) + "\n";
  return finish(ctx, target, outcome, () =>
    commit(ctx, target, text, "new", () => {
      if (existsSync(target)) throw new ConflictError("確定の直前に同じ名前のファイルができた");
    })
  );
}

/** updateFields の rows を読む（行の元の値だけ。fieldcode は設定にあるものだけ） */
/**
 * rows を読む。設定のファイルにある fieldcode の行は差し替え（replace）、無い fieldcode の行は足す（added。2026-10-18: ヘッダーのボタンや、計算式の無かった項目に式を足せなかった。
 * 足した行がアプリに無い項目なら normalize が field.missing で止める）。足す行の省いた値は既定（state は formulaSet があれば true、edit / hide は false、rank は ""）
 */
function parseRows(text: string, current: Array<Record<string, unknown>>): { replace: Map<string, Record<string, unknown>>; added: Array<Record<string, unknown>> } {
  const v = parseInput(text, "rows");
  if (!Array.isArray(v)) throw new InputError("rows は行（fieldcode を持つオブジェクト）の配列");
  if (v.length === 0) throw new InputError("rows が空");
  if (v.length > MAX_UPDATE_ROWS) throw new InputError(`rows は 1 回に ${MAX_UPDATE_ROWS} 行まで（${v.length} 行）`);
  const known = new Set<string>(ROW_SOURCE_KEYS);
  const codes = new Set(current.map((r) => (isPlainObject(r) ? String(r.fieldcode ?? "") : "")));
  const out = new Map<string, Record<string, unknown>>();
  const added: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  v.forEach((row, i) => {
    if (!isPlainObject(row)) throw new InputError(`rows[${i}] はオブジェクト`);
    const code = row.fieldcode;
    if (typeof code !== "string" || !code) throw new InputError(`rows[${i}] に fieldcode（文字列）が要る`);
    const unknown = Object.keys(row).filter((k) => !known.has(k));
    if (unknown.length) throw new InputError(`rows[${i}]（${code}）に行の元の値でないキーがある: ${unknown.join(", ")}（使えるのは ${ROW_SOURCE_KEYS.join(", ")}。画面の値（type、fieldlabel など）は normalize が項目定義から補う）`);
    if (seen.has(code)) throw new InputError(`rows の fieldcode が重複: ${code}`);
    seen.add(code);
    if (codes.has(code)) { out.set(code, row); return; }
    const formulaSet = row.formulaSet ?? "";
    added.push({ fieldcode: code, state: row.state ?? String(formulaSet).trim() !== "", formulaSet, edit: row.edit ?? false, hide: row.hide ?? false, rank: row.rank ?? "" });
  });
  return { replace: out, added };
}

/** updateFields の common を読む（共通の設定のキー COMMON_KEYS だけ。封筒・pluginInfos・知らないキーは invalid） */
function parseCommon(text: string): Record<string, unknown> {
  const v = parseInput(text, "common");
  if (!isPlainObject(v)) throw new InputError(`common は共通の設定のキー（${COMMON_KEYS.join("、")}）を持つオブジェクト`);
  const fixed = Object.keys(v).filter((k) => k === "pluginInfos" || (ENVELOPE_KEYS as readonly string[]).includes(k));
  if (fixed.length) throw new InputError(`common で変えられないキー: ${fixed.join(", ")}（項目の行は rows、封筒（appId など）は変えない）`);
  const unknown = Object.keys(v).filter((k) => !COMMON_KEYS.includes(k));
  if (unknown.length) throw new InputError(`common に共通の設定でないキーがある: ${unknown.join(", ")}（使えるのは ${COMMON_KEYS.join("、")}）`);
  if (!Object.keys(v).length) throw new InputError("common が空（変えないなら渡さない）");
  return v;
}

/**
 * 既存の設定の項目の行を差し替える（rows は fieldcode の行の JSON の配列の文字列。common は共通の設定の JSON の文字列）。
 * expectedDigest は fml_summary（summary）が返した値。差し替えた後の設定を normalize し、エラーが無ければ確定する
 */
export async function updateFields(ctx: SaveContext, opt: { path: string; expectedDigest: string; rows: string; common?: string; fields?: string }): Promise<SaveResult> {
  if (tooLarge(opt.rows)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `rows は ${MAX_SAVE_INPUT_BYTES.toLocaleString()} バイトまで` };
  if (opt.common !== undefined && tooLarge(opt.common)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `common は ${MAX_SAVE_INPUT_BYTES.toLocaleString()} バイトまで` };
  let target: string;
  try {
    target = resolveRead(opt.path, ctx.root);
    resolveWrite(opt.path, WRITE_ROOTS.settings, ctx.root);
    if (isSnapshotName(path.basename(target))) throw new SaveDenied("ダウンロード / pull のファイルは書き換えない。edit（fml_edit）で -edit.json に写して直す");
    assertUsableInKintone(ctx.root, target, ctx.mode);
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
  } catch (e) {
    return errorResult(ctx.root, path.resolve(ctx.root, opt.path), e);
  }
  if (!existsSync(target)) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "ファイルが無い（新しい設定なら fml_save_settings）" };
  const current = readFileSync(target);
  if (digestOf(current) !== opt.expectedDigest) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "読んだ後にファイルが変わった（digest が違う）。fml_summary で読み直す" };
  let settings: Record<string, unknown>;
  try {
    const v = parseInput(current.toString("utf8").replace(/^﻿/, ""), "設定のファイル");
    if (!isPlainObject(v)) throw new InputError("設定のファイルの最上位はオブジェクト");
    if (v.pluginID !== FORMULA_CONFIG_PLUGIN_ID) throw new InputError(`計算式プラグインの設定のファイルではない（封筒の pluginID が "${FORMULA_CONFIG_PLUGIN_ID}" でない）`);
    if (!Array.isArray(v.pluginInfos)) throw new InputError("設定のファイルに pluginInfos（項目の行）が無い");
    settings = v;
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  const rows = settings.pluginInfos as Array<Record<string, unknown>>;
  let next: Record<string, unknown>;
  try {
    const { replace, added } = parseRows(opt.rows, rows);
    const common = opt.common !== undefined ? parseCommon(opt.common) : {};
    const merged = rows.map((r) => {
      const code = isPlainObject(r) ? String(r.fieldcode ?? "") : "";
      const rep = replace.get(code);
      return rep ? { ...r, ...rep } : r;
    });
    next = { ...settings, ...common, pluginInfos: [...merged, ...added] };
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  let outcome: EvalOutcome;
  try {
    outcome = await normalizeText(ctx, target, JSON.stringify(next), fieldsFileFor(ctx, target, opt.fields, settings));
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  if (outcome.normalize.hasErrors || !outcome.normalize.output) return { status: "invalid", code: "NormalizeError", path: rel(ctx.root, target), findings: outcome.normalize.findings, summary: outcome.normalize.summary, message: "normalize のエラーがあるので保存しない（ファイルは変えていない）" };
  const output = outcome.normalize.output;
  const text = JSON.stringify(output, null, 2) + "\n";
  const name = rel(ctx.root, target);
  // グループの行（値を計算しない）は項目定義から。読めなければ括弧の形（ヘッダー・スペース項目）だけで決める
  let displayCodes: Set<string> | undefined;
  try {
    const f = readFieldsFile(fieldsFileFor(ctx, target, opt.fields, settings));
    displayCodes = new Set(Object.values(f.properties).filter((p) => p.type === "GROUP").map((p) => p.code));
  } catch {
    displayCodes = undefined;
  }
  const d = diffSettings(settings, output, { before: `${name}（前）`, after: name }, { displayCodes });
  return finish(
    ctx, target, outcome,
    () =>
      commit(ctx, target, text, "replace", () => {
        if (digestOf(readFileSync(target)) !== opt.expectedDigest) throw new ConflictError("確定の直前にファイルが変わった（digest が違う）。fml_summary で読み直す");
      }),
    { diff: { fields: d.fields, common: d.common } }
  );
}
