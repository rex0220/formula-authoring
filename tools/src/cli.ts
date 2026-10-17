/**
 * formula-authoring <command> …（formula/doc/internal/オーサリングツール_実装計画.md 4 章）。shebang は scripts/build.mjs の banner が付ける。
 * 計算式エンジンと計算式プラグインのコードは利用者の zip（.env の FORMULA_PLUGIN_ZIP）から読む（engine.ts）。kintone には GET しか送らない。
 *   - 読むのは作業フォルダー（cwd）の中のファイルだけ、書くのは fields/ records/ settings/ temp/ users/ の下だけ（safe-path.ts）
 *   - .env と zip の場所は固定。オプションで別の場所を指定できない（AI が書けるファイルを読ませない）
 * 工程 1（2026-10-17）: version / fields / record / records / pull / summary / diff / users。normalize / calc は工程 2。
 * 接続のファイル（複数の profile）と kintone/ のフォルダー（take / edit / files）は工程 1 の後半。
 * 終了コード: 0 成功、1 検査のエラー・認証・kintone・zip・入力の誤り、2 使い方の誤り（パスの制限を含む）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createContext, type WorkContext } from "./context.ts";
import { formulaProdDir } from "./dev-paths.ts";
import { AuthError, baseUrlFromEnv, describeAuth, loadAuth, pluginZipPath } from "./env.ts";
import { loadEngine, type Engine } from "./engine.ts";
import { InputError, readJsonLimited } from "./input.ts";
import { NotAllowedError, RestError, createRestClient, type RestClient } from "./kintone-rest.ts";
import { KintoneUrlError } from "./kintone-url.ts";
import { PluginZipError } from "./plugin-zip.ts";
import { schemaRevisionOf, toolsMeta } from "./meta.ts";
import { PathError, WRITE_ROOTS, resolveRead, resolveWrite } from "./safe-path.ts";
import { DEFAULT_USERS, UsersDataError, summarizeUsers, validateUsersSource, type UsersOrigin, type UsersSource } from "./users/index.ts";
import { contextTargetsOf, fetchFields, listFields, summarizeFields } from "./commands/fields.ts";
import { describeRecord, fetchRecord, summarizeRecord, usedFieldCodes, type RecordFile } from "./commands/record.ts";
import { QueryError, listRecordShapes } from "./commands/records.ts";
import { defaultPullName, pullSettings } from "./commands/pull.ts";
import { summarizeSettings } from "./commands/summary.ts";
import { diffSettings } from "./commands/diff.ts";
import { UsersPullError, pullUsers, usersFileNameOf } from "./commands/users.ts";
import { readFieldsFile } from "./input.ts";

const USAGE = `使い方: npx @rex0220/formula-authoring-tools <command> [options]
  version                                   tools の版と、zip から読んだ計算式プラグインの版・API の版・エンジンの SHA-256
  fields --app N [--preview] [--guest S] [--lang ja] [--out fields/N.json] [--force]
                                            項目定義・レイアウト・一覧を fields/N.json に
  fields --app N --summary                  取得済みの fields/N.json を 1 項目 1 行で（○ = 計算式を設定できる型。通信しない）
  record --app N --id R [--fields-from settings/<f>.json] [--out records/N-R.json] [--force]
                                            1 レコードを records/N-R.json に（--fields-from で設定の計算式が使う項目に絞る）
  record --app N --id R --summary           取得済みのレコードの形（値は出さない）
  records --app N [--query "<条件>"] [--guest S]
                                            レコードを数件、形だけ（保存しない。代表の 1 件を選ぶため）
  pull --app N [--preview] [--guest S] [--out settings/<f>.json] [--force]
                                            アプリに入っている今の設定を、設定画面のダウンロードと同じ形で settings/ に
  summary <settings.json> [--field <code>]  設定ファイルの要約（設定ファイルを Read で開かないため）
  diff <before.json> <after.json>           2 つの設定ファイルの差（★ = 既存レコードの値に影響する項目）
  users --summary [--users <f>] [--user <code>]
                                            ユーザー情報のテストデータの要約（既定は tools 同梱の架空の 10 人）
  users --pull [--out users/<host>.json] [--force] [--max N]
                                            ユーザー・組織・グループと所属を User API から users/ に（個人情報。パスワード認証だけ）
  help

読むのは作業フォルダー（起動したフォルダー）の中のファイルだけ。書くのは fields/ records/ settings/ temp/ users/ の下だけ。
.env: KINTONE_BASE_URL、KINTONE_API_TOKEN か KINTONE_USERNAME + KINTONE_PASSWORD、FORMULA_PLUGIN_ZIP（計算式プラグインの zip、Ver.101 以降）。`;

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

type Flags = Record<string, string | true>;
const str = (flags: Flags, k: string): string | undefined => (typeof flags[k] === "string" ? (flags[k] as string) : undefined);
const has = (flags: Flags, k: string): boolean => flags[k] !== undefined;
function intFlag(flags: Flags, k: string, required: boolean): number | undefined {
  const v = str(flags, k);
  if (v === undefined) {
    if (required) throw new UsageError(`--${k} <番号> が要る`);
    return undefined;
  }
  if (!/^[1-9]\d{0,9}$/.test(v)) throw new UsageError(`--${k} は正の整数: ${v}`);
  return Number(v);
}

let W: WorkContext;
const shown = (file: string): string => path.relative(W.root, file).replace(/\\/g, "/") || file;

/** 書き出し（書ける場所の中だけ。あれば --force が要る） */
function writeOut(file: string, text: string, roots: readonly string[], force: boolean): string {
  const abs = resolveWrite(file, roots, W.root);
  if (existsSync(abs) && !force) throw new InputError(`${shown(abs)} は既にある（上書きするなら --force）`);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const writeJson = (file: string, data: unknown, roots: readonly string[], force: boolean): string => writeOut(file, JSON.stringify(data, null, 2) + "\n", roots, force);

function existingFile(rel: string, howToFetch: string): string {
  const abs = resolveRead(rel, W.root);
  if (!existsSync(abs)) throw new InputError(`${rel} が無い（先に ${howToFetch}）`);
  return abs;
}

async function engineOf(): Promise<Engine> {
  const zip = pluginZipPath({ cwd: W.root, env: W.env });
  const dev = W.env.FORMULA_ALLOW_DEV_PLUGIN === "1" ? formulaProdDir(W.env) : undefined;
  const engine = await loadEngine({ pluginZip: zip, devPluginDir: dev });
  const baseUrl = baseUrlFromEnv({ cwd: W.root, env: W.env });
  if (baseUrl) engine.setContext({ baseUrl });
  return engine;
}

function clientOf(flags: Flags): { client: RestClient; authLabel: string; guestSpaceId: number | undefined } {
  const auth = loadAuth({ cwd: W.root, env: W.env });
  return { client: createRestClient(auth), authLabel: describeAuth(auth), guestSpaceId: intFlag(flags, "guest", false) };
}

function usersSourceOf(file: string | undefined): { src: UsersSource; origin: UsersOrigin } {
  if (!file) return { src: DEFAULT_USERS, origin: { kind: "default" } };
  const abs = existingFile(file, "users --pull か、手で users/<名前>.json を書く");
  return { src: validateUsersSource(readJsonLimited(abs), file), origin: { kind: "file", file: shown(abs) } };
}

async function cmdVersion(): Promise<number> {
  const meta = toolsMeta();
  console.log(`tools: ${meta.toolsVersion} (commit ${meta.commit}, ${meta.mode})`);
  console.log(`扱う計算式プラグイン: Ver.${meta.minPluginVersion} 以降（プラグイン ID ${meta.pluginId}）、authoring API の版 ${meta.supportedApiVersions.join(", ")}`);
  let engine: Engine;
  try {
    engine = await engineOf();
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

async function cmdFields(flags: Flags): Promise<number> {
  const app = intFlag(flags, "app", true) as number;
  const rel = path.join("fields", `${app}.json`);
  if (has(flags, "summary")) {
    const file = readFieldsFile(existingFile(rel, `fields --app ${app}`));
    let targetTypes: ReadonlySet<string> | undefined;
    try {
      targetTypes = new Set((await engineOf()).api.TARGET_TYPES as readonly string[]);
    } catch {
      targetTypes = undefined; // zip が無くても要約は出す（○ / － の印なし）
    }
    console.log(listFields(file, { targetTypes }));
    return 0;
  }
  const { client, authLabel, guestSpaceId } = clientOf(flags);
  const file = await fetchFields(client, { app, lang: str(flags, "lang"), preview: has(flags, "preview"), guestSpaceId });
  const out = writeJson(str(flags, "out") ?? rel, file, WRITE_ROOTS.fields, has(flags, "force"));
  const targets = contextTargetsOf(file.properties);
  console.log(`${summarizeFields(file)}\nルックアップ先 ${Object.keys(targets.lookupTargets).length}、関連レコード一覧の先 ${Object.keys(targets.relatedTargets).length}\n${authLabel}で ${client.baseUrl} から取得 → ${shown(out)}`);
  return 0;
}

async function cmdRecord(flags: Flags): Promise<number> {
  const app = intFlag(flags, "app", true) as number;
  const id = intFlag(flags, "id", true) as number;
  const rel = path.join("records", `${app}-${id}.json`);
  if (has(flags, "summary")) {
    const data = readJsonLimited(existingFile(rel, `record --app ${app} --id ${id}`)) as unknown as RecordFile;
    if (!data.record || typeof data.record !== "object") throw new InputError(`${rel} は record コマンドの出力ではない（record が無い）`);
    console.log(describeRecord(data));
    return 0;
  }
  let keep: Set<string> | undefined;
  const from = str(flags, "fields-from");
  if (from) {
    const settings = readJsonLimited(existingFile(from, "設定ファイルを置く"));
    const codes = usedFieldCodes(settings);
    if (!codes) console.log(`${from} に計算式の設定（pluginInfos）が無いので絞らない`);
    else keep = codes;
  }
  const { client, authLabel, guestSpaceId } = clientOf(flags);
  const file = await fetchRecord(client, { app, id, guestSpaceId, keep });
  const out = writeJson(str(flags, "out") ?? rel, file, WRITE_ROOTS.records, has(flags, "force"));
  console.log(`${summarizeRecord(file)}${file.keptFields ? `（--fields-from で ${file.keptFields.length} 項目に絞った）` : ""}\n${authLabel}で ${client.baseUrl} から取得 → ${shown(out)}（レコードの値を含む。コミットしない）`);
  return 0;
}

async function cmdRecords(flags: Flags): Promise<number> {
  const app = intFlag(flags, "app", true) as number;
  const { client, guestSpaceId } = clientOf(flags);
  const shapes = await listRecordShapes(client, { app, query: str(flags, "query"), guestSpaceId });
  console.log(`アプリ ${app}: query「${shapes.query}」 ${shapes.records.length} 件${shapes.truncated ? "（表示の上限で打ち切り）" : ""}`);
  for (const r of shapes.records) {
    console.log(`レコード ${r.id}`);
    for (const l of r.lines) console.log(`  ${l}`);
  }
  return 0;
}

async function cmdPull(flags: Flags): Promise<number> {
  const app = intFlag(flags, "app", true) as number;
  const engine = await engineOf();
  const { client, authLabel, guestSpaceId } = clientOf(flags);
  const pluginId = engine.source.pluginId;
  if (!pluginId) throw new InputError("プラグイン ID が分からない（zip から読んだときだけ pull できる）");
  const r = await pullSettings(client, engine, { app, preview: has(flags, "preview"), guestSpaceId, pluginId });
  const out = writeJson(str(flags, "out") ?? path.join("settings", defaultPullName(r.appName, app)), r.envelope, WRITE_ROOTS.settings, has(flags, "force"));
  console.log(`アプリ ${app} ${r.appName} の設定（${has(flags, "preview") ? "動作テスト環境" : "運用中"}、保存形式 ${r.format}）→ ${shown(out)}\n${authLabel}で ${client.baseUrl} から取得`);
  console.log(summarizeSettings(r.envelope, shown(out), { defaults: { misc: engine.api.MISC_DEFAULTS as Record<string, unknown> } }));
  return 0;
}

async function cmdSummary(positional: string[], flags: Flags): Promise<number> {
  const file = positional[1];
  if (!file) throw new UsageError("summary <settings.json>");
  const abs = existingFile(file, "pull か、設定ファイルを置く");
  let defaults: { misc?: Record<string, unknown> } | undefined;
  try {
    defaults = { misc: (await engineOf()).api.MISC_DEFAULTS as Record<string, unknown> };
  } catch {
    defaults = undefined;
  }
  console.log(summarizeSettings(readJsonLimited(abs), shown(abs), { field: str(flags, "field"), defaults }));
  return 0;
}

function cmdDiff(positional: string[]): number {
  const [, a, b] = positional;
  if (!a || !b) throw new UsageError("diff <before.json> <after.json>");
  const fa = existingFile(a, "設定ファイルを置く");
  const fb = existingFile(b, "設定ファイルを置く");
  const r = diffSettings(readJsonLimited(fa), readJsonLimited(fb), { before: shown(fa), after: shown(fb) });
  console.log(r.lines.join("\n"));
  return 0;
}

async function cmdUsers(flags: Flags): Promise<number> {
  if (has(flags, "summary")) {
    const { src, origin } = usersSourceOf(str(flags, "users"));
    console.log(summarizeUsers(src, origin, str(flags, "user")));
    return 0;
  }
  if (has(flags, "pull")) {
    const { client, authLabel } = clientOf(flags);
    const max = intFlag(flags, "max", false);
    const r = await pullUsers(client, { maxCalls: max, log: (l) => console.log(l) });
    const out = writeJson(str(flags, "out") ?? path.join("users", usersFileNameOf(client.baseUrl)), r.source, WRITE_ROOTS.users, has(flags, "force"));
    console.log(`${summarizeUsers(r.source, { kind: "file", file: shown(out) })}\n${authLabel}で ${client.baseUrl} から取得（${r.calls} 回）→ ${shown(out)}（個人情報を含む。コミットしない。終わったら消す）`);
    return 0;
  }
  throw new UsageError("users は --summary か --pull");
}

export async function main(argv: string[]): Promise<number> {
  W = createContext({ cwd: process.cwd(), env: process.env });
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? "help";
  try {
    switch (command) {
      case "help": case "--help": case "-h":
        console.log(USAGE);
        return 0;
      case "version": return await cmdVersion();
      case "fields": return await cmdFields(flags);
      case "record": return await cmdRecord(flags);
      case "records": return await cmdRecords(flags);
      case "pull": return await cmdPull(flags);
      case "summary": return await cmdSummary(positional, flags);
      case "diff": return cmdDiff(positional);
      case "users": return await cmdUsers(flags);
      default:
        console.error(`不明なコマンド: ${command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof PathError) {
      console.error(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof PluginZipError || e instanceof AuthError || e instanceof UsersDataError || e instanceof InputError || e instanceof RestError || e instanceof NotAllowedError || e instanceof KintoneUrlError || e instanceof QueryError || e instanceof UsersPullError) {
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
