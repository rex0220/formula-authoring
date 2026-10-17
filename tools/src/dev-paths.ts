/**
 * 開発とビルドのときだけ使う場所の探し方（環境変数を読む。中核の境界の外。cli.ts と scripts/・試験だけが import する）。
 *   - formula（型だけ import する。開発中は prod/ からも読める）: 開発依存 "formula": "file:../../formula" のリンク、環境変数 FORMULA_FORMULA_ROOT、隣のフォルダー
 *   - plugin-config-kit、rexgrid（型だけ）: 同じ探し方（FORMULA_KIT_ROOT、FORMULA_REXGRID_ROOT）
 * 中核（engine.ts など）は環境変数を読まない。開発中の読み込み元は CLI が formulaProdDir(W.env) で決めて loadEngine に渡す。
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { AUTHORING_ROOT, REPO_ROOT } from "./paths.ts";

type Env = Readonly<Record<string, string | undefined>>;

function linkedRoot(env: Env, name: string, envVar: string, fallback: string): string {
  const v = env[envVar];
  if (v) return v;
  const linked = path.join(AUTHORING_ROOT, "node_modules", name);
  if (existsSync(path.join(linked, "package.json"))) {
    try {
      return realpathSync(linked);
    } catch {
      return linked;
    }
  }
  return fallback;
}

/** formula/（計算式プラグインのリポジトリ） */
export function formulaRootOf(env: Env): string {
  return linkedRoot(env, "formula", "FORMULA_FORMULA_ROOT", path.resolve(REPO_ROOT, "..", "formula"));
}

/** 開発中の読み込み元（formula の prod/。zip の中と同じ配置）。在るかは engine.ts が確かめる */
export function formulaProdDir(env: Env): string {
  return path.join(formulaRootOf(env), "prod");
}

/** scripts/ と試験用（このプロセスの環境変数で決める） */
export const FORMULA_ROOT = formulaRootOf(process.env);

/** 開発中の読み込み元が在れば、そのフォルダー（試験用） */
export function devPluginDir(): string | null {
  const dir = formulaProdDir(process.env);
  return existsSync(path.join(dir, "desktop_js", "KintoneFormula.min.js")) ? dir : null;
}

/** 試験用: formula の dist にある Ver.101 以降の zip（名前順の最後） */
export function devPluginZip(): string | null {
  const dist = path.join(formulaRootOf(process.env), "dist");
  if (!existsSync(dist)) return null;
  const zips = readdirSync(dist).filter((f) => /^formula-plugin(\d+)\.zip$/.test(f) && Number(f.match(/\d+/)![0]) >= 101).sort();
  return zips.length ? path.join(dist, zips[zips.length - 1]) : null;
}

export function kitRoot(): string {
  return linkedRoot(process.env, "plugin-config-kit", "FORMULA_KIT_ROOT", path.resolve(REPO_ROOT, "..", "..", "plugin-config-kit"));
}

export function rexgridRoot(): string {
  return linkedRoot(process.env, "rexgrid", "FORMULA_REXGRID_ROOT", path.resolve(REPO_ROOT, "..", "..", "rexgrid"));
}
