/**
 * take [--profile <名前>]
 * inbox/ に置いた設定のダウンロード（rex0220-formula-app<番号>-<日時>.json。名前はそのまま）を、封筒の appId で
 * アプリのフォルダー kintone/<profile>/<番号>-<アプリ名>/ に移す（print-craft-authoring の take の写し。2026-10-05 Takashi「ダウンロードのファイル名をそのまま使いたい」）。
 * ダウンロードにはドメインが入っていないので、profile はほかのコマンドと同じ選び方（--profile、無ければ defaultProfile、無ければ dev。15.2）。
 * フォルダーが無ければ作り、中身より先に印を置く（15.5）。
 * 計算式プラグインの設定でないファイル、ファイル名の番号と封筒の appId が違うファイル、行き先に同じ名前の別の中身があるファイルは移さない（skipped に決まった文の理由）。
 * 印が合わない今あるフォルダー（印が無い・壊れている・別の接続）と、呼び出しの途中の接続の変化は、skipped にせず ConnectionError（conflict）で止める
 * （印は何かを変える前にすべて確かめる。Codex の実装レビュー MAJOR 4）
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, unlinkSync } from "node:fs";
import path from "node:path";
import { MAX_INPUT_BYTES } from "../input.ts";
import { jsonErrorWhere } from "../json-error.ts";
import { FORMULA_CONFIG_PLUGIN_ID } from "../meta.ts";
import { realResolve, resolveRead, resolveWrite, WRITE_ROOTS } from "../safe-path.ts";
import { assertChangeAllowed, PermissionError } from "../permission.ts";
import { FileExistsError, withRetry, writeNewFile } from "../commit-file.ts";
import { assertSameConnection, ConnectionError, pickProfile } from "../connections.ts";
import { appDirFor, assertAppMark, assertInsideWorkspace, ensureAppFolder, findAppDir, INBOX, requireProfiles, SNAPSHOT_RE, type WorkspaceMode } from "../workspace.ts";

export interface TakeResult {
  /** leftInInbox: 行き先には置いたが inbox の元を消せなかった（消してよい。次の take でも「同じもの」として消す） */
  moved: Array<{ file: string; to: string; same: boolean; leftInInbox?: boolean }>;
  /** reason は決まった文（ファイルの中身・絶対パス・秘密の値を入れない。Codex の実装レビュー BLOCKER 1） */
  skipped: Array<{ file: string; reason: string }>;
  /** 置いたが一時ファイルを消せなかった、など（移したことは変わらない） */
  warnings: string[];
}

/** inbox の元を消す（Windows の EPERM / EBUSY は短く待ってやり直す）。消せなければ false（行き先には置いてある） */
function removeSource(src: string, warnings: string[], rel: string): boolean {
  try {
    withRetry(() => unlinkSync(src));
    return true;
  } catch (e) {
    warnings.push(`${rel} は行き先に置いたが、inbox から消せなかった（${(e as NodeJS.ErrnoException).code ?? "理由は不明"}）。消してよい`);
    return false;
  }
}

/**
 * inbox のファイルを 1 回だけ読む（開いた fd から、上限 + 1 バイトまで）。同じ中身から JSON の検査と写しを行う。
 * 読めないときの理由は決まった文（JSON.parse の誤りの文には中身の一部が入るので使わない。位置だけ。Codex の実装レビュー BLOCKER 1）
 */
function readInbox(src: string): { text: string; data: Record<string, unknown> } | { reason: string } {
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(src, "r");
    if (!fstatSync(fd).isFile()) return { reason: "普通のファイルでない" };
    const buf = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let off = 0;
    for (;;) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
      if (off > MAX_INPUT_BYTES) return { reason: `大きすぎる（上限 ${MAX_INPUT_BYTES.toLocaleString()} バイト）` };
    }
    bytes = buf.subarray(0, off);
  } catch (e) {
    return { reason: `読めない（${(e as NodeJS.ErrnoException).code ?? "理由は不明"}）` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const text = bytes.toString("utf8");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { reason: `JSON として読めない${jsonErrorWhere(e)}（中身は返さない）` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { reason: "JSON の最上位がオブジェクトでない" };
  return { text, data: data as Record<string, unknown> };
}

interface Candidate {
  rel: string;
  src: string;
  name: string;
  appId: number;
  appName: string;
  text: string;
}

interface Plan extends Candidate {
  dir: string;
  dest: string;
}

export function takeInbox(cwdIn: string, mode: WorkspaceMode, profile?: string): TakeResult {
  // profile の形でなければ止める（未設定・移行で止まっている）。profile は 15.2 の選び方（決まらなければ誤り）
  const connections = requireProfiles(mode, "take");
  const def = pickProfile(connections.set, profile);
  // 作業フォルダーを最初に実際のパスに直す（移した先は実際のパスなので、相対パスの表示がずれないように。macOS の /var → /private/var）
  const cwd = realResolve(".", cwdIn);
  const result: TakeResult = { moved: [], skipped: [], warnings: [] };
  const inbox = path.join(cwd, INBOX);
  if (!existsSync(inbox)) return result;
  // inbox の実体が作業フォルダーの中か（外への symlink なら、外のファイルの名前を出さずに止める。B1 の Codex レビュー BLOCKER 1）
  assertInsideWorkspace(cwd, inbox);

  // 1. 読んで確かめ、行き先を決める（まだ何も変えない）
  const candidates: Candidate[] = [];
  for (const name of readdirSync(inbox).filter((n) => n.toLowerCase().endsWith(".json")).sort()) {
    const rel = `${INBOX}/${name}`;
    const src = resolveRead(rel, cwd);
    const read = readInbox(src);
    if ("reason" in read) {
      result.skipped.push({ file: rel, reason: read.reason });
      continue;
    }
    const data = read.data;
    if (data.pluginID !== FORMULA_CONFIG_PLUGIN_ID) {
      result.skipped.push({ file: rel, reason: "計算式プラグインの設定のファイルではない（pluginID が違う）" });
      continue;
    }
    const appId = data.appId;
    if (typeof appId !== "number" || !Number.isSafeInteger(appId) || appId <= 0) {
      result.skipped.push({ file: rel, reason: "封筒の appId が無い" });
      continue;
    }
    // 取り込むのはダウンロードの名前（rex0220-formula-app<番号>-<日時>.json）のファイルだけ（Codex レビュー MAJOR 3。名前は変えずに置く）
    if (!SNAPSHOT_RE.test(name)) {
      result.skipped.push({ file: rel, reason: "ダウンロードの名前（rex0220-formula-app<番号>-<日時>.json）ではない。設定画面のダウンロードの名前のまま inbox/ に置く" });
      continue;
    }
    const m = name.match(/-app(\d+)-/);
    if (m && Number(m[1]) !== appId) {
      result.skipped.push({ file: rel, reason: `ファイル名のアプリ ${m[1]} と封筒の appId ${appId} が違う` });
      continue;
    }
    candidates.push({ rel, src, name, appId, appName: typeof data.appName === "string" ? data.appName : "", text: read.text });
  }
  // 行き先のフォルダーはアプリごとに 1 つ（今あるフォルダー。無ければ、一番新しいダウンロード（名前の日時が最後のもの）のアプリ名で作る。
  // ファイルごとに決めると、同じアプリでアプリ名の違うダウンロードから、同じ番号のフォルダーを 2 つ作ってしまう。Codex の実装レビュー r2 MAJOR）
  const dirByApp = new Map<number, string>();
  for (const appId of new Set(candidates.map((c) => c.appId))) {
    const newest = candidates.filter((c) => c.appId === appId).reduce((a, b) => (b.name > a.name ? b : a));
    dirByApp.set(appId, appDirFor(cwd, def.profile, appId, newest.appName));
  }
  const plans: Plan[] = candidates.map((c) => {
    const dir = dirByApp.get(c.appId) as string;
    return { ...c, dir, dest: resolveWrite(path.join(dir, c.name), WRITE_ROOTS.kintone, cwd) };
  });

  // 2. 今あるアプリのフォルダーの印を、何かを変える前にすべて確かめる（印の無い・合わないフォルダーの中は読まない。食い違いは止める。15.5）
  const checked = new Set<string>();
  for (const p of plans) {
    if (checked.has(p.dir) || !existsSync(p.dir)) continue;
    assertAppMark(p.dir, def, p.appId);
    checked.add(p.dir);
  }

  // 3. 移す。印・接続の食い違い（ConnectionError）は止める（それまでに移したものは移したまま。件数を文に添える）
  for (const p of plans) {
    try {
      if (existsSync(p.dest)) {
        if (readFileSync(p.dest, "utf8") !== p.text) {
          result.skipped.push({ file: p.rel, reason: `行き先に同じ名前の別の中身がある: ${path.relative(cwd, p.dest)}` });
          continue;
        }
        // 同じものが既にある: inbox の元を消す前に、印と接続を確かめ直す（呼び出しの途中で接続が変わっていれば止める。Codex の実装レビュー MAJOR 4）
        assertAppMark(p.dir, def, p.appId);
        assertSameConnection({ set: connections.set, def }, connections.reload, p.appId);
        const removed = removeSource(p.src, result.warnings, p.rel);
        result.moved.push({ file: p.rel, to: path.relative(cwd, p.dest), same: true, ...(removed ? {} : { leftInInbox: true }) });
        continue;
      }
      // フォルダーを新しく作る前に、同じアプリのフォルダーが（別の処理で）別の名前で作られていないか探し直す（同じ番号のフォルダーを 2 つ作らない）
      if (!existsSync(p.dir)) {
        const found = findAppDir(cwd, def.profile, p.appId);
        if (found !== null && found !== p.dir) {
          result.skipped.push({ file: p.rel, reason: `同じアプリのフォルダーが移す途中で別の名前で作られた: ${path.relative(cwd, found)}。もう一度 take する` });
          continue;
        }
      }
      // 新しい名前のダウンロードを足すことだけ（permission.ts。profile、印、接続のファイルを読み直して接続が同じか）。フォルダーが無ければ印を置いてから作る（15.5）。
      // 確定の直前にも確かめ直し、新しいファイルとしてだけ置く（確かめた後に同じ名前ができても上書きしない。Codex 再レビュー BLOCKER 2）。inbox の元は置けてから消す
      assertChangeAllowed(cwd, p.dest, "snapshot", mode);
      ensureAppFolder(p.dir, def, p.appId);
      const { cleanup } = writeNewFile(p.dest, p.text, () => {
        if (resolveWrite(path.join(p.dir, p.name), WRITE_ROOTS.kintone, cwd) !== p.dest) throw new PermissionError(`書く先のフォルダーが途中で変わった（symlink など）: ${path.relative(cwd, p.dest)}`);
        assertChangeAllowed(cwd, p.dest, "snapshot", mode);
      });
      for (const c of cleanup) result.warnings.push(`${p.rel} は行き先に置いたが、一時ファイルを消せなかった（${c}）。${path.relative(cwd, path.dirname(p.dest))} の .${p.name}.*.tmp を消してよい`);
    } catch (e) {
      if (e instanceof ConnectionError) {
        throw new ConnectionError(`${e.message}（この呼び出しで移したのは ${result.moved.length} 件。inbox に残ったものは、直した後にもう一度 take する）`, e.code);
      }
      if (e instanceof PermissionError) {
        result.skipped.push({ file: p.rel, reason: e.message });
        continue;
      }
      if (e instanceof FileExistsError) {
        result.skipped.push({ file: p.rel, reason: `行き先に同じ名前のファイルができた（移す途中で）: ${path.relative(cwd, p.dest)}。もう一度 take する` });
        continue;
      }
      throw e;
    }
    const removed = removeSource(p.src, result.warnings, p.rel);
    result.moved.push({ file: p.rel, to: path.relative(cwd, p.dest), same: false, ...(removed ? {} : { leftInInbox: true }) });
  }
  return result;
}
