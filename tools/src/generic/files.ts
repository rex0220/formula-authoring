/**
 * 汎用のオーサリングの作業フォルダー（2026-11-13 Takashi「OK」。kSQL アクションのオーサリングと同じ、**直下に JSON を置く**簡単な形）。
 * 計算式・項目検証の作業フォルダー（workspace.ts の、接続ごと・アプリごとのフォルダー）は使わない（共有の決まりに手を入れない）。
 * 使うのは、パスの守り（safe-path.ts の realResolve / isInside）と、ファイルの確定とロック（commit-file.ts）だけ。
 *
 * ファイルは 2 種類。どちらも作業フォルダーの直下の *.json。
 *   - **設定ファイル**（AI が読み書きする。元の値）: `{ kind: "rex0220-authoring-source", plugin, appId, appName, source: { common, rows } }`
 *     検査を通っていなくても保存できる（下書き）。直すのはツールだけ（digest を照合して入れ替える）
 *   - **取り込み用のファイル**（設定画面の「設定をアップロード」で読むもの。保存値の封筒）: 検査を通った設定ファイルからだけ作る。上書きしない
 * 設定画面でダウンロードしたファイル（保存値の封筒）を作業フォルダーに置けば、そこから設定ファイルを作れる（元は残す）。
 *
 * ここは「ファイルの読み書き」だけ。プラグインの API を呼ぶ・kintone を読むのは呼ぶ側（check.ts と MCP）。
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileExistsError, LockBusyError, acquireLock, cleanupAll, tempPathFor, withRetry, writeNewFile, type Lock } from "../commit-file.ts";
import { PathError, isInside, realResolve } from "../safe-path.ts";
import { assertSource, type GenericSource } from "./source.ts";
import { genericPlugin } from "./registry.ts";

export const SOURCE_FILE_KIND = "rex0220-authoring-source";
/** 1 つのファイルの上限（設定ファイル・取り込み用・ダウンロード）。超えたら読まない */
export const GENERIC_MAX_FILE_BYTES = 8 * 1024 * 1024;

export type GenericFileStatus = "saved" | "exists" | "conflict" | "busy" | "denied" | "invalid" | "missing";
export class GenericFileError extends Error {
  readonly status: GenericFileStatus;
  constructor(message: string, status: GenericFileStatus) {
    super(message);
    this.status = status;
  }
}

export interface SourceFile {
  kind: typeof SOURCE_FILE_KIND;
  /** 表の名前（registry.ts） */
  plugin: string;
  /** 自アプリ（プラグインを入れるアプリ）の番号 */
  appId: number;
  appName: string;
  source: GenericSource;
}

export const digestOfText = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/**
 * 作業フォルダーの直下のファイルの名前を、絶対パスにする。
 * 受けるのは名前だけ（フォルダーの区切り・`..`・先頭の `.` は受けない）で、拡張子は .json。symlink の先が作業フォルダーの外なら断る
 */
export function resolveWorkFile(root: string, name: string): string {
  if (typeof name !== "string" || !name || name !== path.basename(name) || /[\\/]/.test(name) || name.startsWith(".") || !/\.json$/i.test(name) || name.length > 200) {
    throw new GenericFileError(`ファイルの名前は、作業フォルダーの直下の .json の名前で書く（フォルダーの区切り・先頭の「.」は使えない）: ${String(name)}`, "denied");
  }
  let real: string;
  let realRoot: string;
  try {
    realRoot = realResolve(".", root);
    real = realResolve(name, root);
  } catch (e) {
    if (e instanceof PathError) throw new GenericFileError(e.message, "denied");
    throw e;
  }
  if (!isInside(real, realRoot) || path.dirname(real) !== realRoot) throw new GenericFileError(`作業フォルダーの直下でない場所は読み書きしない: ${name}`, "denied");
  return real;
}

function readText(file: string, name: string): string {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    throw new GenericFileError(`ファイルが無い: ${name}`, "missing");
  }
  if (!st.isFile()) throw new GenericFileError(`普通のファイルでない: ${name}`, "denied");
  if (st.size > GENERIC_MAX_FILE_BYTES) throw new GenericFileError(`ファイルが大きすぎる（${GENERIC_MAX_FILE_BYTES} バイトまで）: ${name}`, "invalid");
  return readFileSync(file, "utf8");
}

function parseSourceFile(text: string, name: string): SourceFile {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new GenericFileError(`JSON として読めない: ${name}（${e instanceof Error ? e.message : String(e)}）`, "invalid");
  }
  const o = v as Partial<SourceFile> | null;
  if (!o || typeof o !== "object" || o.kind !== SOURCE_FILE_KIND) throw new GenericFileError(`設定ファイルではない（kind が ${SOURCE_FILE_KIND} でない）: ${name}`, "invalid");
  genericPlugin(String(o.plugin));
  if (!Number.isInteger(o.appId) || (o.appId as number) < 1) throw new GenericFileError(`appId（自アプリの番号）が無い: ${name}`, "invalid");
  let source: GenericSource;
  try {
    source = assertSource(o.source);
  } catch (e) {
    throw new GenericFileError(`${name}: ${e instanceof Error ? e.message : String(e)}`, "invalid");
  }
  return { kind: SOURCE_FILE_KIND, plugin: String(o.plugin), appId: o.appId as number, appName: String(o.appName ?? ""), source };
}

/** 設定ファイルの中身を、決まった形の文字列にする（キーの順と字下げを固定。同じ中身なら同じ digest） */
export function renderSourceFile(file: SourceFile): string {
  const out: SourceFile = { kind: SOURCE_FILE_KIND, plugin: genericPlugin(file.plugin).name, appId: file.appId, appName: file.appName ?? "", source: assertSource(file.source) };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export interface ReadSourceResult { name: string; file: SourceFile; digest: string }

export function readSourceFile(root: string, name: string): ReadSourceResult {
  const target = resolveWorkFile(root, name);
  const text = readText(target, name);
  return { name, file: parseSourceFile(text, name), digest: digestOfText(text) };
}

/** 作業フォルダーのほかの JSON（設定画面でダウンロードしたファイルなど）を文字のまま読む */
export function readWorkText(root: string, name: string): { name: string; text: string; digest: string } {
  const text = readText(resolveWorkFile(root, name), name);
  return { name, text, digest: digestOfText(text) };
}

export interface WriteResult { status: "saved"; name: string; digest: string; warnings: string[] }

/** 新しいファイルとして置く（同じ名前があれば exists。上書きしない） */
function placeNewFile(root: string, name: string, text: string): WriteResult {
  const target = resolveWorkFile(root, name);
  if (Buffer.byteLength(text) > GENERIC_MAX_FILE_BYTES) throw new GenericFileError(`ファイルが大きすぎる（${GENERIC_MAX_FILE_BYTES} バイトまで）: ${name}`, "invalid");
  try {
    const r = writeNewFile(target, text, () => { resolveWorkFile(root, name); });
    return { status: "saved", name, digest: digestOfText(text), warnings: r.cleanup };
  } catch (e) {
    if (e instanceof FileExistsError) throw new GenericFileError(`同じ名前のファイルがある（上書きしない）: ${name}`, "exists");
    throw e;
  }
}

/** 設定ファイルを新しく置く（上書きしない） */
export function saveNewSourceFile(root: string, name: string, file: SourceFile): WriteResult {
  return placeNewFile(root, name, renderSourceFile(file));
}

/** 取り込み用のファイル（保存値の封筒）を新しく置く（上書きしない）。text は authoring API の writeEnvelope の結果 */
export function saveNewImportFile(root: string, name: string, text: string): WriteResult {
  return placeNewFile(root, name, text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * 設定ファイルを直す。読んだ時点の digest（expectedDigest）と違えば conflict（読んだ後に変わった）。
 * 入れ替えは、ロック → digest の確かめ直し → 隣の一時ファイル → rename。plugin と appId は変えられない
 */
export function updateSourceFile(root: string, name: string, expectedDigest: string, edit: (source: GenericSource) => GenericSource): WriteResult & { before: GenericSource; after: GenericSource } {
  const target = resolveWorkFile(root, name);
  const current = readText(target, name);
  if (digestOfText(current) !== expectedDigest) throw new GenericFileError(`読んだ後にファイルが変わった（digest が違う）。読み直してからやり直す: ${name}`, "conflict");
  const file = parseSourceFile(current, name);
  const after = assertSource(edit(JSON.parse(JSON.stringify(file.source)) as GenericSource));
  const text = renderSourceFile({ ...file, source: after });
  if (Buffer.byteLength(text) > GENERIC_MAX_FILE_BYTES) throw new GenericFileError(`ファイルが大きすぎる（${GENERIC_MAX_FILE_BYTES} バイトまで）: ${name}`, "invalid");
  const tmp = tempPathFor(target);
  let lock: Lock | undefined;
  try {
    try {
      lock = acquireLock(target);
    } catch (e) {
      if (e instanceof LockBusyError) throw new GenericFileError(`ほかの書き込みがこのファイルを直している。少し待ってやり直す: ${name}`, "busy");
      throw e;
    }
    if (digestOfText(readText(target, name)) !== expectedDigest) throw new GenericFileError(`確定の直前にファイルが変わった（digest が違う）。読み直してからやり直す: ${name}`, "conflict");
    writeFileSync(tmp, text, { flag: "wx" });
    resolveWorkFile(root, name);
    if (!lock.owned()) throw new GenericFileError(`ロックを失った（60 秒より長く止まった）。読み直してからやり直す: ${name}`, "conflict");
    withRetry(() => renameSync(tmp, target));
  } catch (e) {
    cleanupAll([...(lock ? [() => void lock!.release()] : []), () => rmSync(tmp, { force: true })]);
    throw e;
  }
  const warnings = cleanupAll([() => void lock!.release(), () => rmSync(tmp, { force: true })]);
  return { status: "saved", name, digest: digestOfText(text), warnings, before: file.source, after };
}

export interface WorkFileInfo {
  name: string;
  /** source = 設定ファイル / envelope = 保存値の封筒（設定画面のダウンロード、取り込み用のファイル）/ other = それ以外の JSON */
  type: "source" | "envelope" | "other" | "unreadable";
  bytes: number;
  digest?: string;
  plugin?: string;
  appId?: number;
  appName?: string;
  rows?: number;
  /** 封筒のとき: pluginID と PluginVersion */
  pluginId?: string;
  pluginVersion?: string;
  date?: string;
}

/** 作業フォルダーの直下の JSON の一覧（名前の順）。中身は種類が分かるだけ読む */
export function listWorkFiles(root: string): WorkFileInfo[] {
  const realRoot = realResolve(".", root);
  if (!existsSync(realRoot)) return [];
  const out: WorkFileInfo[] = [];
  for (const d of readdirSync(realRoot, { withFileTypes: true })) {
    if (!d.isFile() || d.name.startsWith(".") || !/\.json$/i.test(d.name)) continue;
    const file = path.join(realRoot, d.name);
    const bytes = lstatSync(file).size;
    if (bytes > GENERIC_MAX_FILE_BYTES) { out.push({ name: d.name, type: "unreadable", bytes }); continue; }
    try {
      const text = readFileSync(file, "utf8");
      const v = JSON.parse(text) as Record<string, unknown>;
      const digest = digestOfText(text);
      if (v && v.kind === SOURCE_FILE_KIND) {
        const s = v.source as { rows?: unknown[] } | undefined;
        out.push({ name: d.name, type: "source", bytes, digest, plugin: String(v.plugin ?? ""), appId: Number(v.appId) || undefined, appName: String(v.appName ?? ""), rows: Array.isArray(s?.rows) ? s.rows.length : undefined });
      } else if (v && typeof v.pluginID === "string") {
        out.push({ name: d.name, type: "envelope", bytes, digest, pluginId: v.pluginID, pluginVersion: String(v.PluginVersion ?? ""), appId: Number(v.appId) || undefined, appName: String(v.appName ?? ""), date: String(v.date ?? "") });
      } else out.push({ name: d.name, type: "other", bytes, digest });
    } catch {
      out.push({ name: d.name, type: "unreadable", bytes });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** 取り込み用のファイルの名前（設定画面のダウンロードと同じ並び: <頭>-app<番号>-<YYYYMMDD>-<HHmmss>-import.json） */
export function importFileName(plugin: string, appId: number, now: Date = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${genericPlugin(plugin).name}-app${appId}-${stamp}-import.json`;
}
