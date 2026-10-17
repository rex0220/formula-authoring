/**
 * formula-authoring <command> …（formula/doc/internal/オーサリングツール_実装計画.md 4 章）。shebang は scripts/build.mjs の banner が付ける。
 * 計算式エンジンと計算式プラグインのコードは利用者の zip（.env の FORMULA_PLUGIN_ZIP）から読む（engine.ts）。kintone には GET しか送らない。
 * 工程 0（2026-10-17）: version / help / users --summary。fields / record / pull / normalize / calc / diff / summary は工程 1〜2 で足す。
 * 終了コード: 0 成功、1 検査のエラー・認証・kintone・zip・入力の誤り、2 使い方の誤り。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createContext, type WorkContext } from "./context.ts";
import { formulaProdDir } from "./dev-paths.ts";
import { AuthError, baseUrlFromEnv, pluginZipPath } from "./env.ts";
import { loadEngine, type Engine } from "./engine.ts";
import { PluginZipError } from "./plugin-zip.ts";
import { schemaRevisionOf, toolsMeta } from "./meta.ts";
import { PathError, resolveRead } from "./safe-path.ts";
import { DEFAULT_USERS, UsersDataError, summarizeUsers, validateUsersSource, type UsersOrigin, type UsersSource } from "./users/index.ts";

const USAGE = `使い方: npx @rex0220/formula-authoring-tools <command> [options]
  version                  tools の版と、zip から読んだ計算式プラグインの版・authoring API の版・計算式エンジンの SHA-256
  users --summary [--users <file>] [--user <code>]
                           ユーザー情報のテストデータの要約（人数・組織数・グループ数と --user の有無。コードや名前は出さない）
  help                     この使い方
（工程 1〜2 で足す: fields / record / records / users --pull / pull / normalize / calc / diff / summary / take / edit / files）

読むのは作業フォルダー（起動したフォルダー）の中のファイルだけ。.env の FORMULA_PLUGIN_ZIP に計算式プラグインの zip（Ver.101 以降）のパスを書く。`;

class UsageError extends Error {}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

const str = (flags: Record<string, string | true>, k: string): string | undefined => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);

async function engineOf(W: WorkContext): Promise<Engine> {
  const zip = pluginZipPath({ cwd: W.root, env: W.env });
  const dev = W.env.FORMULA_ALLOW_DEV_PLUGIN === "1" ? formulaProdDir(W.env) : undefined;
  const engine = await loadEngine({ pluginZip: zip, devPluginDir: dev });
  const baseUrl = baseUrlFromEnv({ cwd: W.root, env: W.env });
  if (baseUrl) engine.setContext({ baseUrl });
  return engine;
}

function usersSourceOf(W: WorkContext, file: string | undefined): { src: UsersSource; origin: UsersOrigin } {
  if (!file) return { src: DEFAULT_USERS, origin: { kind: "default" } };
  const abs = resolveRead(file, W.root);
  if (!existsSync(abs)) throw new UsersDataError(`ユーザー情報のテストデータが無い: ${file}`);
  const raw = readFileSync(abs, "utf8");
  if (raw.length > 20 * 1024 * 1024) throw new UsersDataError(`ユーザー情報のテストデータが大きすぎる: ${file}`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (e) { throw new UsersDataError(`ユーザー情報のテストデータ（${file}）が JSON として読めない: ${e instanceof Error ? e.message : String(e)}`); }
  return { src: validateUsersSource(parsed, file), origin: { kind: "file", file: path.relative(W.root, abs) || file } };
}

async function cmdVersion(W: WorkContext): Promise<number> {
  const meta = toolsMeta();
  console.log(`tools: ${meta.toolsVersion} (commit ${meta.commit}, ${meta.mode})`);
  console.log(`扱う計算式プラグイン: Ver.${meta.minPluginVersion} 以降（プラグイン ID ${meta.pluginId}）、authoring API の版 ${meta.supportedApiVersions.join(", ")}`);
  let engine: Engine;
  try {
    engine = await engineOf(W);
  } catch (e) {
    if (e instanceof PluginZipError || e instanceof AuthError) {
      console.log(`計算式プラグインの zip: 読めない（${e.message}）`);
      return 1;
    }
    throw e;
  }
  const s = engine.source;
  console.log(`計算式プラグインの zip: ${s.from}（${s.kind === "zip" ? "zip" : "開発中のフォルダー"}）`);
  console.log(`  プラグイン: Ver.${s.pluginVersion}${s.pluginId ? `、ID ${s.pluginId}` : ""}、authoring API の版 ${engine.api.apiVersion}`);
  console.log(`  計算式エンジン: sha256 ${s.engineSha256}`);
  if (s.decimalSha256) console.log(`  rex0220_decimal: sha256 ${s.decimalSha256}`);
  if (s.apiSha256) console.log(`  authoring API: sha256 ${s.apiSha256}`);
  console.log(`  設定スキーマの版: ${schemaRevisionOf(engine.api.CONFIG_SCHEMA)}、関数 ${engine.functionNames().length}`);
  for (const w of engine.warnings) console.log(`  注意: ${w}`);
  return 0;
}

function cmdUsers(W: WorkContext, flags: Record<string, string | true>): number {
  if (!flags.summary) throw new UsageError("users は --summary だけ（--pull は工程 1 で足す）");
  const { src, origin } = usersSourceOf(W, str(flags, "users"));
  console.log(summarizeUsers(src, origin, str(flags, "user")));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const W = createContext({ cwd: process.cwd(), env: process.env });
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? "help";
  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      case "version":
        return await cmdVersion(W);
      case "users":
        return cmdUsers(W, flags);
      default:
        console.error(`不明なコマンド: ${command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof PathError) {
      console.error(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof PluginZipError || e instanceof AuthError || e instanceof UsersDataError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked && (invoked === path.resolve(new URL(import.meta.url).pathname) || /[\\/]dist[\\/]cli\.mjs$/.test(invoked))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
