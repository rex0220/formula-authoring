/**
 * 作業の文脈: 作業フォルダー（実際のパス）と環境変数（段階 0-2。print-craft-authoring-mcp の実装案 6.4・12.3）。
 * 中核（このフォルダーの cli.ts 以外）は process.cwd() と process.env を既定の値として使わず、この文脈の値を引数で受け取る。
 *   - CLI は起動時に一度だけ作る（作業フォルダー = 起動したフォルダー、環境変数 = process.env）
 *   - print-craft MCP は、Desktop では設定の作業フォルダー、Claude Code では workspaceId（フックが登録済みの作業フォルダーに書き換えたもの）から作る
 * 作業フォルダーは最初に実際のパス（symlink / junction を解いたもの）に直す。途中で直すと、相対パスの表示や比較がずれる
 * （macOS の一時フォルダー /var → /private/var で take の相対パスがずれた）
 */
import { realResolve } from "./safe-path.ts";

export interface WorkContext {
  /** 作業フォルダーの実際のパス（絶対パス） */
  readonly root: string;
  /** 環境変数（OS のもの、または MCP の設定項目から作ったもの）。中核は process.env を直接読まない */
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function createContext(opt: { cwd: string; env: Readonly<Record<string, string | undefined>> }): WorkContext {
  return Object.freeze({ root: realResolve(".", opt.cwd), env: Object.freeze({ ...opt.env }) });
}
