/**
 * CLI が読む・書くパスを作業フォルダー（cwd）の中の決まった場所に限る（Codex 1-10 レビュー BLOCKER 5）。
 * テンプレートでは AI が `npx @rex0220/formula-authoring-tools …` を確認なしに呼べるので、--out などで policy/ や .env を上書きしたり、
 * 作業フォルダーの外へ書いたり、.env を読んだりできないようにする。
 *   - path.resolve → 存在する最も深い親の realpath（junction / symlink を解く）→ cwd の realpath の中か
 *   - Windows は大文字小文字を区別せずに比べる。UNC や別ドライブは外れる
 *   - 書き込み先は roots（fields/ records/ settings/ out/ temp/）のどれかの下。Windows の予約名（CON、NUL、COM1 …）は使わない
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export class PathError extends Error {}

/** 書き込みを許す場所（cwd からの相対）。kintone/ は environments.json があるときのアプリのフォルダー（workspace.ts） */
export const WRITE_ROOTS = {
  fields: ["fields", "kintone"],
  records: ["records", "kintone"],
  settings: ["settings", "temp", "kintone"],
  out: ["out", "kintone"],
  /** users --pull の出力（個人情報。.gitignore）と --users のテストデータ */
  users: ["users", "kintone"],
  kintone: ["kintone"]
} as const;

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function norm(p: string): string {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/**
 * 存在する最も深い親の realpath に残りを足した絶対パス。
 * 親を探すのは lstat で「本当に無い」（ENOENT / ENOTDIR）ときだけ上がり、リンク切れ・ループ・アクセス不能は止める（fail closed。再レビュー MAJOR 5）
 */
export function realResolve(target: string, cwd: string): string {
  const abs = path.resolve(cwd, target);
  let dir = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      lstatSync(dir);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        const parent = path.dirname(dir);
        if (parent === dir) throw new PathError(`パスを解決できない: ${target}`);
        rest.unshift(path.basename(dir));
        dir = parent;
        continue;
      }
      throw new PathError(`パスを解決できない（アクセスできない: ${code ?? "不明"}）: ${target}`);
    }
  }
  let real: string;
  try {
    real = realpathSync.native(dir);
  } catch (e) {
    throw new PathError(`パスを解決できない（リンク切れ・ループ・アクセスできない場所: ${(e as NodeJS.ErrnoException).code ?? "不明"}）: ${target}`);
  }
  return rest.length ? path.join(real, ...rest) : real;
}

export function isInside(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 読む入力（設定 JSON、fields、record）: cwd の中。.env と node_modules と .git は読まない */
export function resolveRead(target: string, cwd: string): string {
  if (!target || typeof target !== "string") throw new PathError("ファイルのパスが要る");
  const real = realResolve(target, cwd);
  const cwdReal = realResolve(".", cwd);
  if (!isInside(real, cwdReal)) throw new PathError(`読むファイルは作業フォルダーの中に置く: ${target}`);
  const rel = path.relative(cwdReal, real).replace(/\\/g, "/");
  if (/^\.env(\.|$)/i.test(path.basename(real)) || /^(node_modules|\.git)(\/|$)/i.test(rel)) throw new PathError(`このファイルは tools では読まない: ${target}`);
  return real;
}

/** 書き込み先: cwd の中の roots のどれかの下（root そのものではない）。返すのは絶対パス */
export function resolveWrite(target: string, roots: readonly string[], cwd: string): string {
  if (!target || typeof target !== "string") throw new PathError("書き込み先のパスが要る");
  const real = realResolve(target, cwd);
  const cwdReal = realResolve(".", cwd);
  if (!isInside(real, cwdReal)) throw new PathError(`書き込み先は作業フォルダーの中: ${target}`);
  const ok = roots.some((r) => {
    const root = path.join(cwdReal, r);
    return isInside(real, root) && norm(real) !== norm(root);
  });
  if (!ok) throw new PathError(`書き込み先は ${roots.map((r) => `${r}/`).join(" か ")} の下: ${target}`);
  const base = path.basename(real);
  if (WINDOWS_RESERVED.test(base) || /[. ]$/.test(base)) throw new PathError(`使えないファイル名: ${base}`);
  return real;
}

/** 書き込み先のフォルダー（preview の --out-dir）: cwd の中の roots のどれか、またはその下 */
export function resolveWriteDir(target: string, roots: readonly string[], cwd: string): string {
  if (!target || typeof target !== "string") throw new PathError("フォルダーのパスが要る");
  const real = realResolve(target, cwd);
  const cwdReal = realResolve(".", cwd);
  if (!isInside(real, cwdReal)) throw new PathError(`出力フォルダーは作業フォルダーの中: ${target}`);
  if (!roots.some((r) => isInside(real, path.join(cwdReal, r)))) throw new PathError(`出力フォルダーは ${roots.map((r) => `${r}/`).join(" か ")}（またはその下）: ${target}`);
  return real;
}

/** ファイル名に使えない文字と Windows の予約名を避ける（preview の out/<ボタン名>.html） */
export function safeFileName(name: string, fallback: string): string {
  let s = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!s || WINDOWS_RESERVED.test(s)) s = fallback;
  return s.length > 120 ? s.slice(0, 120) : s;
}
