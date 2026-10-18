/**
 * formula-authoring <command> …（formula/doc/internal/オーサリングツール_実装計画.md 4 章）。shebang は scripts/build.mjs の banner が付ける。
 * 計算式エンジンと計算式プラグインのコードは利用者の zip（.env の FORMULA_PLUGIN_ZIP）から読む（engine.ts）。kintone には GET しか送らない。
 *   - 読むのは作業フォルダー（cwd）の中のファイルだけ、書くのは fields/ records/ settings/ temp/ users/ kintone/ の下だけ（safe-path.ts。kintone/ は接続のファイルがあるときだけ）
 *   - .env と zip と接続のファイルの場所は固定。オプションで別の場所を指定できない（AI が書けるファイルを読ませない）
 * 工程 1（2026-10-17）: version / fields / record / records / pull / summary / diff / users。工程 2: normalize / calc。
 * 工程 1 の後半（2026-10-17）: 接続のファイル（複数の profile。FORMULA_KINTONE_CONFIG。workspace.ts / connections.ts）、kintone/ のフォルダー（take / edit / files）、
 * users --pull --only-referenced、User API の cybozu.com 共通の API トークン。print-craft-authoring tools 2.0.0 の CLI と同じ形。
 * tools 0.3.0（計画 25 章）: try（同梱のサンプルアプリで式の試し計算。利用者のアプリ・レコードは使わない）。
 * 終了コード: 0 成功、1 検査のエラー・認証・kintone・zip・入力・接続の誤り、2 使い方の誤り（パスの制限を含む）。
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createContext, type WorkContext } from "./context.ts";
import { formulaProdDir } from "./dev-paths.ts";
import { AuthError, baseUrlFromEnv, describeAuth, kintoneConfigPath, loadAuth, loadUserApiAuth, pluginZipPath } from "./env.ts";
import { loadEngine, type Engine } from "./engine.ts";
import { InputError, readFieldsFile, readJsonLimited, readTextLimited } from "./input.ts";
import { NotAllowedError, RestError, createRestClient, type RestClient } from "./kintone-rest.ts";
import { KintoneUrlError } from "./kintone-url.ts";
import { PluginZipError } from "./plugin-zip.ts";
import { schemaRevisionOf, toolsMeta } from "./meta.ts";
import { PathError, WRITE_ROOTS, isInside, resolveRead, resolveWrite } from "./safe-path.ts";
import { ConnectionError, PROFILE_NAME_RE, authFor, pickProfile, userApiAuthFor, type ProfileDef } from "./connections.ts";
import { INBOX, KINTONE_ROOT, SNAPSHOT_RE, WorkspaceError, appDirFor, appFolderOfFile, assertAppMark, assertUsableInKintone, editNameOf, ensureAppFolder, findAppDir, legacyBlockedError, listAppFolder, modeOf, snapshotNameOf, type WorkspaceMode } from "./workspace.ts";
import { PermissionError, assertChangeAllowed, type ChangeOp } from "./permission.ts";
import { FileExistsError, writeNewFile } from "./commit-file.ts";
import { DEFAULT_USERS, UsersDataError, summarizeUsers, validateUsersSource, type UsersOrigin, type UsersSource } from "./users/index.ts";
import { contextTargetsOf, fetchFields, listFields, summarizeFields } from "./commands/fields.ts";
import { describeRecord, fetchRecord, summarizeRecord, usedFieldCodes, type RecordFile } from "./commands/record.ts";
import { QueryError, listRecordShapes } from "./commands/records.ts";
import { defaultPullName, pullSettings } from "./commands/pull.ts";
import { summarizeSettings } from "./commands/summary.ts";
import { diffSettings } from "./commands/diff.ts";
import { UsersPullError, pullReferencedUsers, pullUsers, referencedCodesOf, usersFileNameOf } from "./commands/users.ts";
import { takeInbox } from "./commands/take.ts";
import { describeSampleApp } from "./sample-app.ts";
import { PolicyError, loadPolicy } from "./normalize/policy.ts";
import { DEFAULT_TIMEOUT_SEC, EvalError, EvalTimeoutError, MAX_TIMEOUT_SEC, runEval } from "./worker/run.ts";
import { builtinErrorName } from "./worker/eval-run.ts";
import type { EvalJob } from "./worker/eval-job.ts";

const USAGE = `使い方: npx @rex0220/formula-authoring-tools <command> [options]
  version                                   tools の版と、zip から読んだ計算式プラグインの版・API の版・エンジンの SHA-256、kintone の接続の形
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
  users --pull [--only-referenced <settings.json>] [--out users/<host>.json] [--force] [--max N]
                                            ユーザー・組織・グループと所属を User API から users/ に（個人情報）。--only-referenced は
                                            設定の式が文字列で参照するコードとその所属だけ（引数なしの UINFO などがあれば全部取る）
  normalize <settings.json> [--fields fields/N.json] [--users <f>] [--out <f>] [--force] [--check] [--timeout 秒]
                                            設定画面と同じ手順で検査し、既定値を補った設定を書き出す（--check は入力との差）
  calc <settings.json> --app N (--id R | --records R1,R2,…) [--fields fields/N.json] [--users <f>] [--user <code>]
       [--event <種別>] [--action A --status S --next-status T] [--mobile] [--timeout 秒]
                                            取得済みのレコード（records/）に設定を当てた模擬（更新しない）。評価は Worker で動かし、既定 60 秒で止める
  try "<式>" [--as <型 | 項目コード>] [--table <テーブル>] [--records 1,2,3] [--users <f>] [--user <code>]
      [--event <種別>] [--action A --status S --next-status T] [--mobile] [--timeout 秒]
      [--fields '<JSON>'] [--data '<JSON>'] [--base 3] [--app N]
                                            同梱のサンプルアプリ（全項目タイプ × 2、テーブル 2 つ、レコード 3 件 = 典型 / 端 / 空）に 1 行だけの設定を組んで
                                            検査と模擬の計算（関数の使い方や式の断片を確かめる。利用者のアプリは使わない）。--as は型（NUMBER / TEXT / DATE …。
                                            既定 TEXT = 文字列 1 行）か項目コード、テーブルの中で計算するなら --table テーブル1。
                                            --fields '[{"code":"単価","type":"NUMBER"},{"code":"分類","type":"DROP_DOWN","options":["明細","小計"]}]' で項目を足す、
                                            --data '[{"単価":100,"テーブル1":[{"T1_数値":1}]}]' で架空の値のレコード（土台は --base の標本。既定 3 = 空）、
                                            --app N で利用者のアプリの項目定義（fields/N.json かアプリのフォルダー）に --data の架空の値を当てる
  try --describe                            サンプルアプリの項目（1 項目 1 行。○ = 計算式を設定できる型）とレコード 3 件の形
  help

kintone の接続のファイル（FORMULA_KINTONE_CONFIG があるとき。kSQL の ksql.config.json と同じ形。複数のドメイン・アプリ）:
  FORMULA_KINTONE_CONFIG は OS の環境変数（絶対パス）か .env（.env のフォルダーからの相対パスでもよい）。接続のファイルは作業フォルダーの外に置く。
  kintone を使うコマンドに --profile <名前>（省略は接続のファイルの defaultProfile、無ければ dev）。--app は番号。--guest は使わない（profile の guestSpaceId）。
  保存先は kintone/<profile>/<番号>-<アプリ名>/（fields.json、records/<番号>.json、設定のダウンロードと pull は rex0220-formula-app<番号>-<日時>.json の
  名前のまま。フォルダーの印 .formula-app.json）。認証は profile のそのアプリの tokenMap か、ログイン名とパスワード。users --pull は userApiToken か ログイン名とパスワード。
  normalize / calc にアプリのフォルダーの中のファイルを渡すと --fields は同じフォルダーの fields.json、calc --id 3 は records/3.json。
  ダウンロード / pull のファイルは書き換えない（edit で -edit.json に写して直す。normalize の --out もそこへ）。
  take [--profile <名前>]                   inbox/ に置いた設定のダウンロードを、封筒の appId で profile のアプリのフォルダーへ名前のまま移す
  edit --app N | edit <ダウンロードのファイル>
                                            一番新しい（または指定した）ダウンロード / pull を <名前>-edit.json に写す（既にあればそのまま）。直すのはこちら
  files --app N                             アプリのフォルダーのファイル（今の設定 = 一番新しいダウンロード / pull、-edit.json、その他の設定、records）

読むのは作業フォルダー（起動したフォルダー）の中のファイルだけ。書くのは fields/ records/ settings/ temp/ users/ kintone/ の下だけ（kintone/ は接続のファイルがあるときだけ）。
.env: KINTONE_BASE_URL、KINTONE_API_TOKEN か KINTONE_USERNAME + KINTONE_PASSWORD、FORMULA_PLUGIN_ZIP（計算式プラグインの zip、Ver.101 以降）、
  FORMULA_KINTONE_CONFIG（任意。接続のファイル）、FORMULA_USER_API_TOKEN（任意。users --pull の cybozu.com 共通管理の API トークン）。`;

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
const authOpt = () => ({ cwd: W.root, env: W.env });
const shown = (file: string): string => {
  const rel = path.relative(W.root, file).replace(/\\/g, "/");
  return rel && !rel.startsWith("..") ? rel : file;
};

// ---- 動く形（接続のファイルの有無。workspace.ts の modeOf）。kintone を使うコマンドと kintone/ の下のファイルを扱うときだけ読む ----
let MODE: WorkspaceMode | undefined;
function mode(): WorkspaceMode {
  MODE ??= modeOf(W.root, { configFile: kintoneConfigPath(authOpt()), workspaceRoots: [W.root], env: W.env, surface: "cli" });
  return MODE;
}
const inKintone = (file: string): boolean => isInside(path.resolve(W.root, file), path.join(W.root, KINTONE_ROOT));
/** kintone/ の下をこの操作で変えてよいか（profile の形、印、操作 × 場所、接続のファイルを読み直して接続が同じか。permission.ts）。通信や評価の前の早めの判定と、書く直前の両方で呼ぶ */
const allow = (file: string, op: ChangeOp): void => {
  if (inKintone(file)) assertChangeAllowed(W.root, file, op, mode());
};
/** kintone/ の下のファイルを読む前に（profile の形、接続のファイルにある profile、印） */
const usable = (file: string): void => {
  if (inKintone(file)) assertUsableInKintone(W.root, file, mode());
};

/** kintone を使うコマンドの文脈: 接続のファイルがあれば profile の形（--profile か defaultProfile、無ければ dev）、無ければ 1 接続の形（.env） */
interface Ctx {
  mode: WorkspaceMode;
  def?: ProfileDef;
  /** --profile を付けたか（案内の文言に添える） */
  explicit?: string;
}
function context(flags: Flags): Ctx {
  const m = mode();
  if (m.kind === "legacy-blocked") throw legacyBlockedError();
  if (m.kind === "profiles") {
    if (has(flags, "guest")) throw new UsageError("接続のファイルの形では --guest を使わない（ゲストスペースは profile の guestSpaceId で決める）");
    const explicit = str(flags, "profile");
    return { mode: m, def: pickProfile(m.connections.set, explicit), ...(explicit ? { explicit } : {}) };
  }
  if (has(flags, "profile")) throw new UsageError("--profile は kintone の接続のファイル（FORMULA_KINTONE_CONFIG）があるときだけ使える");
  return { mode: m };
}
const profileFlag = (ctx: Ctx): string => (ctx.explicit ? ` --profile ${ctx.explicit}` : "");
function profileContext(flags: Flags, what: string): Ctx & { def: ProfileDef } {
  const ctx = context(flags);
  if (!ctx.def) throw new UsageError(`${what} は kintone の接続のファイル（FORMULA_KINTONE_CONFIG）があるときだけ使える`);
  return ctx as Ctx & { def: ProfileDef };
}
/** kintone の接続（profile の形はそのアプリの認証と profile のゲストスペース、1 接続の形は .env と --guest） */
function clientFor(ctx: Ctx, flags: Flags, appId: number): { client: RestClient; authLabel: string; guestSpaceId: number | undefined } {
  if (ctx.def && ctx.mode.kind === "profiles") {
    const auth = authFor(ctx.mode.connections.set, ctx.def, appId);
    return { client: createRestClient(auth), authLabel: `${describeAuth(auth)}（profile ${ctx.def.profile}）`, guestSpaceId: ctx.def.guestSpaceId ?? undefined };
  }
  const auth = loadAuth(authOpt());
  return { client: createRestClient(auth), authLabel: describeAuth(auth), guestSpaceId: intFlag(flags, "guest", false) };
}
/** profile の形のとき: 今あるアプリのフォルダー（無ければ fields で作るよう案内して止める。印が合わなければ止める） */
function existingAppDir(ctx: Ctx & { def: ProfileDef }, appId: number): string {
  const dir = findAppDir(W.root, ctx.def.profile, appId);
  if (!dir) throw new InputError(`アプリ ${appId} のフォルダー（kintone/${ctx.def.profile}/${appId}-…）が無い。先に npx @rex0220/formula-authoring-tools fields --app ${appId}${profileFlag(ctx)}`);
  assertAppMark(dir, ctx.def, appId);
  return dir;
}
function noOutInWorkspace(flags: Flags, ctx: Ctx): void {
  if (ctx.def && has(flags, "out")) throw new UsageError("接続のファイルがあるときは --out を使わない（保存先はアプリのフォルダー kintone/<profile>/<番号>-<アプリ名>/）");
}
/** 設定のファイルの置き場所がアプリのフォルダーなら、同じフォルダーの fields.json / records/<番号>.json を既定にする。--profile がフォルダーの profile と違えば止める */
function folderDefaults(settingsAbs: string, flags: Flags): { dir: string; profile: string; appId: number } | null {
  if (!inKintone(settingsAbs)) return null;
  usable(settingsAbs);
  const folder = appFolderOfFile(W.root, settingsAbs);
  const explicit = str(flags, "profile");
  if (folder && explicit && explicit !== folder.profile) throw new UsageError(`--profile ${explicit} とファイルのフォルダーの profile（${folder.profile}）が違う`);
  return folder;
}
/** 評価の文脈の接続先（フォルダー名は AI が作れるので信用しない。接続のファイルの profile の baseUrl か、.env の KINTONE_BASE_URL） */
function trustedBaseUrl(folder: { profile: string } | null, flags: Flags): string | undefined {
  const m = mode();
  if (m.kind === "single") {
    try {
      return baseUrlFromEnv(authOpt());
    } catch (e) {
      if (e instanceof AuthError) return undefined;
      throw e;
    }
  }
  if (m.kind !== "profiles") return undefined;
  if (folder) return m.connections.set.profiles.get(folder.profile)?.baseUrl;
  try {
    return pickProfile(m.connections.set, str(flags, "profile")).baseUrl;
  } catch (e) {
    if (e instanceof ConnectionError && !has(flags, "profile")) return undefined;
    throw e;
  }
}

/**
 * 書き出し（書ける場所の中だけ。kintone/ の下はこの操作で変えてよいかを早めと書く直前に確かめる）。
 * exclusive（ダウンロード / pull のファイル）は新しいファイルとしてだけ置く（確かめた後に同じ名前ができても上書きしない）。
 * それ以外は、あれば --force が要る。レコードの値・個人情報を含むもの（records/ users/）は本人だけが読める 0o600（Codex #12）
 */
function writeText(file: string, text: string, roots: readonly string[], op: ChangeOp, opt: { force?: boolean; mode?: number; exclusive?: boolean } = {}): string {
  const abs = resolveWrite(file, roots, W.root);
  allow(abs, op);
  mkdirSync(path.dirname(abs), { recursive: true });
  if (opt.exclusive) {
    try {
      const { cleanup } = writeNewFile(abs, text, () => {
        if (resolveWrite(file, roots, W.root) !== abs) throw new InputError(`書く先のフォルダーが途中で変わった（symlink など）: ${shown(abs)}`);
        allow(abs, op);
      });
      for (const c of cleanup) console.error(`注意: 書いたが一時ファイルを消せなかった（${c}）`);
    } catch (e) {
      if (e instanceof FileExistsError) throw new InputError(`${shown(abs)} は既にある（確かめた後に作られた）。上書きしない`);
      throw e;
    }
  } else {
    if (existsSync(abs) && !opt.force) throw new InputError(`${shown(abs)} は既にある（上書きするなら --force）`);
    writeFileSync(abs, text, opt.mode !== undefined ? { mode: opt.mode } : undefined);
  }
  if (opt.mode !== undefined) chmodSync(abs, opt.mode);
  return abs;
}
const writeJson = (file: string, data: unknown, roots: readonly string[], op: ChangeOp, opt: { force?: boolean; mode?: number; exclusive?: boolean } = {}): string => writeText(file, JSON.stringify(data, null, 2) + "\n", roots, op, opt);
const PRIVATE = 0o600;

/** 読む入力（作業フォルダーの中。kintone/ の下は profile の形で印が合うフォルダーだけ）。無ければ取り方を添えて止める */
function existingFile(rel: string, howToFetch: string): string {
  const abs = resolveRead(rel, W.root);
  usable(abs);
  if (!existsSync(abs)) throw new InputError(`${shown(abs)} が無い（先に ${howToFetch}）`);
  return abs;
}

async function engineOf(): Promise<Engine> {
  const zip = pluginZipPath(authOpt());
  const dev = W.env.FORMULA_ALLOW_DEV_PLUGIN === "1" ? formulaProdDir(W.env) : undefined;
  const engine = await loadEngine({ pluginZip: zip, devPluginDir: dev });
  // 接続先は APP_URL などの元にするだけ。無い・不正でも zip は読める（version が zip を確かめられるように。接続の誤りは通信するコマンドで止まる）
  try {
    const baseUrl = baseUrlFromEnv(authOpt());
    if (baseUrl) engine.setContext({ baseUrl });
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    engine.warnings.push(e.message);
  }
  return engine;
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
  // kintone の接続の形（接続のファイルの名前と profile。値は出さない）
  try {
    const m = mode();
    if (m.kind === "profiles") {
      const s = m.connections.set;
      console.log(`kintone の接続: 接続のファイル ${s.fileName}（profile: ${[...s.profiles.keys()].join(", ") || "なし"}${s.defaultProfile ? `。既定 ${s.defaultProfile}` : ""}）`);
      for (const i of s.invalid) console.log(`  使えない profile ${i.name}: ${i.reason}`);
      for (const w of s.warnings) console.log(`  注意: ${w}`);
    } else if (m.kind === "single") console.log("kintone の接続: .env の 1 接続（接続のファイル FORMULA_KINTONE_CONFIG は無い）");
    else console.log(`kintone の接続: ${legacyBlockedError().message}`);
  } catch (e) {
    if (!(e instanceof ConnectionError)) throw e;
    console.log(`kintone の接続: ${e.message}`);
  }
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
  const ctx = context(flags);
  const app = intFlag(flags, "app", true) as number;
  noOutInWorkspace(flags, ctx);
  if (has(flags, "summary")) {
    const rel = ctx.def ? path.join(existingAppDir(ctx as Ctx & { def: ProfileDef }, app), "fields.json") : path.join("fields", `${app}.json`);
    const file = readFieldsFile(existingFile(rel, `fields --app ${app}${profileFlag(ctx)}`));
    let targetTypes: ReadonlySet<string> | undefined;
    try {
      targetTypes = new Set((await engineOf()).api.TARGET_TYPES as readonly string[]);
    } catch {
      targetTypes = undefined; // zip が無くても要約は出す（○ / － の印なし）
    }
    console.log(listFields(file, { targetTypes }));
    return 0;
  }
  const { client, authLabel, guestSpaceId } = clientFor(ctx, flags, app);
  const file = await fetchFields(client, { app, lang: str(flags, "lang"), preview: has(flags, "preview"), guestSpaceId });
  let out: string;
  if (ctx.def) {
    // フォルダーが無ければ作る（中身より先に印を置く。15.5）。fields.json は 1 アプリ 1 つなので取り直せば置き換える
    const dir = appDirFor(W.root, ctx.def.profile, app, file.appName);
    const target = resolveWrite(path.join(dir, "fields.json"), WRITE_ROOTS.kintone, W.root);
    allow(target, "fields");
    ensureAppFolder(dir, ctx.def, app);
    out = writeJson(target, file, WRITE_ROOTS.kintone, "fields", { force: true });
  } else {
    out = writeJson(str(flags, "out") ?? path.join("fields", `${app}.json`), file, WRITE_ROOTS.fields, "fields", { force: has(flags, "force") });
  }
  const targets = contextTargetsOf(file.properties);
  console.log(`${summarizeFields(file)}\nルックアップ先 ${Object.keys(targets.lookupTargets).length}、関連レコード一覧の先 ${Object.keys(targets.relatedTargets).length}\n${authLabel}で ${client.baseUrl} から取得 → ${shown(out)}`);
  return 0;
}
async function cmdRecord(flags: Flags): Promise<number> {
  const ctx = context(flags);
  const app = intFlag(flags, "app", true) as number;
  const id = intFlag(flags, "id", true) as number;
  noOutInWorkspace(flags, ctx);
  const rel = ctx.def ? path.join(existingAppDir(ctx as Ctx & { def: ProfileDef }, app), "records", `${id}.json`) : path.join("records", `${app}-${id}.json`);
  if (has(flags, "summary")) {
    const data = readJsonLimited(existingFile(rel, `record --app ${app} --id ${id}${profileFlag(ctx)}`)) as unknown as RecordFile;
    if (!data.record || typeof data.record !== "object") throw new InputError(`${shown(path.resolve(W.root, rel))} は record コマンドの出力ではない（record が無い）`);
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
  const { client, authLabel, guestSpaceId } = clientFor(ctx, flags, app);
  const target = str(flags, "out") ?? rel;
  allow(resolveWrite(target, WRITE_ROOTS.records, W.root), "record");
  const file = await fetchRecord(client, { app, id, guestSpaceId, keep });
  const out = writeJson(target, file, WRITE_ROOTS.records, "record", { force: has(flags, "force"), mode: PRIVATE });
  console.log(`${summarizeRecord(file)}${file.keptFields ? `（--fields-from で ${file.keptFields.length} 項目に絞った）` : ""}\n${authLabel}で ${client.baseUrl} から取得 → ${shown(out)}（レコードの値を含む。コミットしない）`);
  return 0;
}

async function cmdRecords(flags: Flags): Promise<number> {
  const ctx = context(flags);
  const app = intFlag(flags, "app", true) as number;
  const { client, guestSpaceId } = clientFor(ctx, flags, app);
  const shapes = await listRecordShapes(client, { app, query: str(flags, "query"), guestSpaceId });
  console.log(`アプリ ${app}: query「${shapes.query}」 ${shapes.records.length} 件${shapes.truncated ? "（表示の上限で打ち切り）" : ""}`);
  for (const r of shapes.records) {
    console.log(`レコード ${r.id}`);
    for (const l of r.lines) console.log(`  ${l}`);
  }
  return 0;
}

async function cmdPull(flags: Flags): Promise<number> {
  const ctx = context(flags);
  const app = intFlag(flags, "app", true) as number;
  noOutInWorkspace(flags, ctx);
  if (ctx.def && has(flags, "force")) throw new UsageError("接続のファイルがあるときの pull は、ダウンロードと同じ日時の名前で新しく置く（ダウンロード / pull のファイルは上書きしない）ので --force は使えない");
  const engine = await engineOf();
  const { client, authLabel, guestSpaceId } = clientFor(ctx, flags, app);
  const pluginId = engine.source.pluginId;
  if (!pluginId) throw new InputError("プラグイン ID が分からない（zip から読んだときだけ pull できる）");
  const r = await pullSettings(client, engine, { app, preview: has(flags, "preview"), guestSpaceId, pluginId });
  let out: string;
  if (ctx.def) {
    // アプリのフォルダーにダウンロードと同じ名前で置く（フォルダーが無ければ印を置いて作る。新しいファイルとしてだけ）
    const dir = appDirFor(W.root, ctx.def.profile, app, r.appName);
    const target = resolveWrite(path.join(dir, snapshotNameOf(app)), WRITE_ROOTS.kintone, W.root);
    if (existsSync(target)) throw new InputError(`${shown(target)} は既にある（同じ日時の名前）。少し待ってからやり直す（ダウンロード / pull のファイルは上書きしない）`);
    allow(target, "snapshot");
    ensureAppFolder(dir, ctx.def, app);
    out = writeJson(target, r.envelope, WRITE_ROOTS.kintone, "snapshot", { exclusive: true });
  } else {
    out = writeJson(str(flags, "out") ?? path.join("settings", defaultPullName(r.appName, app)), r.envelope, WRITE_ROOTS.settings, "settings", { force: has(flags, "force") });
  }
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

function timeoutOf(flags: Flags): number {
  const v = intFlag(flags, "timeout", false);
  if (v !== undefined && v > MAX_TIMEOUT_SEC) throw new UsageError(`--timeout は ${MAX_TIMEOUT_SEC} 秒まで`);
  return v ?? DEFAULT_TIMEOUT_SEC;
}

/**
 * normalize / calc の共通: 設定ファイル、fields、ユーザー情報、policy、zip の場所を揃えて Worker に渡す仕事を作る（評価は Worker で）。
 * アプリのフォルダーの中のファイルは、いつも同じフォルダーの fields.json（--fields はそれと同じときだけ。別のアプリ・profile・fields/ の項目定義で検査しない）
 */
function jobOf(positional: string[], flags: Flags, usage: string, kind: "normalize" | "calc"): { job: EvalJob; raw: Record<string, unknown>; folder: { dir: string; profile: string; appId: number } | null } {
  const file = positional[1];
  if (!file) throw new UsageError(usage);
  const settingsAbs = existingFile(file, "pull か、設定ファイルを置く");
  const folder = folderDefaults(settingsAbs, flags);
  const raw = readJsonLimited(settingsAbs);
  const appFromEnv = typeof raw.appId === "number" ? raw.appId : intFlag(flags, "app", false);
  let fieldsAbs: string;
  if (folder) {
    const own = path.join(folder.dir, "fields.json");
    const arg = str(flags, "fields");
    if (arg && resolveRead(arg, W.root) !== resolveRead(own, W.root)) throw new PermissionError(`アプリのフォルダーの中のファイルは、同じフォルダーの fields.json で検査する（--fields は付けないか、${shown(own)} にする）`);
    fieldsAbs = existingFile(own, `fields --app ${folder.appId}${has(flags, "profile") ? ` --profile ${str(flags, "profile")}` : ""}`);
  } else {
    const fieldsRel = str(flags, "fields") ?? (appFromEnv ? path.join("fields", `${appFromEnv}.json`) : undefined);
    if (!fieldsRel) throw new UsageError("--fields fields/N.json（設定の appId が無いときは必須）");
    fieldsAbs = existingFile(fieldsRel, `fields --app ${appFromEnv ?? "N"}`);
  }
  const fields = readFieldsFile(fieldsAbs);
  const { src, origin } = usersSourceOf(str(flags, "users"));
  const policy = loadPolicy(W.root);
  const job: EvalJob = {
    kind, pluginZip: pluginZipPath(authOpt()), devPluginDir: W.env.FORMULA_ALLOW_DEV_PLUGIN === "1" ? formulaProdDir(W.env) : undefined, baseUrl: trustedBaseUrl(folder, flags),
    settingsText: readTextLimited(settingsAbs), settingsFile: shown(settingsAbs), fields, usersSource: src, usersOrigin: origin, policy, check: has(flags, "check"),
    lang: str(flags, "lang") as "ja" | "en" | "zh" | undefined
  };
  return { job, raw, folder };
}

const inline = (): boolean => W.env.FORMULA_NO_WORKER === "1";

async function cmdNormalize(positional: string[], flags: Flags): Promise<number> {
  const { job } = jobOf(positional, flags, "normalize <settings.json> [--fields fields/N.json]", "normalize");
  const out = str(flags, "out");
  // 書き出し先は評価の前に確かめる（kintone/ の下はこの操作で書ける場所か。ダウンロード / pull のファイルには書けない）
  if (out) allow(resolveWrite(out, WRITE_ROOTS.settings, W.root), "settings");
  const outcome = await runEval(job, { timeoutSec: timeoutOf(flags), inline: inline() });
  for (const w of outcome.engineWarnings) console.log(`注意: ${w}`);
  console.log(outcome.normalize.summary);
  if (outcome.normalize.checkDiffs) {
    console.log(outcome.normalize.checkDiffs.length ? `--check: 入力と出力の差 ${outcome.normalize.checkDiffs.length}\n  ${outcome.normalize.checkDiffs.join("\n  ")}` : "--check: 入力と出力の差 0");
  }
  if (outcome.normalize.hasErrors || !outcome.normalize.output) return 1;
  if (out) {
    const abs = writeJson(out, outcome.normalize.output, WRITE_ROOTS.settings, "settings", { force: has(flags, "force") });
    console.log(`→ ${shown(abs)}（既定値を補った設定。設定画面で取り込み → 保存 → 運用環境に反映。既存のレコードは「既存レコードを変更」か「一括計算」で）`);
  }
  return 0;
}

async function cmdCalc(positional: string[], flags: Flags): Promise<number> {
  const app = intFlag(flags, "app", true) as number;
  const ids = str(flags, "records") ? (str(flags, "records") as string).split(",").map((x) => x.trim()).filter(Boolean) : str(flags, "id") ? [str(flags, "id") as string] : [];
  if (!ids.length) throw new UsageError("calc <settings.json> --app N --id R（または --records R1,R2,…）");
  for (const id of ids) if (!/^[1-9]\d{0,9}$/.test(id)) throw new UsageError(`レコード番号が正の整数でない: ${id}`);
  const { job, folder } = jobOf(positional, flags, "calc <settings.json> --app N --id R", "calc");
  if (folder && folder.appId !== app) throw new UsageError(`--app ${app} とファイルのフォルダーのアプリ（${folder.appId}）が違う`);
  const records = ids.map((id) => {
    // アプリのフォルダーの中の設定なら同じフォルダーの records/<番号>.json
    const rel = folder ? path.join(folder.dir, "records", `${id}.json`) : path.join("records", `${app}-${id}.json`);
    const data = readJsonLimited(existingFile(rel, `record --app ${app} --id ${id}${has(flags, "profile") ? ` --profile ${str(flags, "profile")}` : ""}`)) as { record?: Record<string, { type: string; value: unknown }>; appId?: number; id?: number };
    if (!data.record || typeof data.record !== "object") throw new InputError(`${shown(path.resolve(W.root, rel))} は record コマンドの出力ではない`);
    return { id, record: data.record, fileAppId: typeof data.appId === "number" ? data.appId : undefined, fileId: typeof data.id === "number" ? data.id : undefined };
  });
  job.calc = {
    appId: app, records, evType: str(flags, "event"),
    event: has(flags, "action") || has(flags, "status") || has(flags, "next-status") ? { action: { value: str(flags, "action") ?? "" }, status: { value: str(flags, "status") ?? "" }, nextStatus: { value: str(flags, "next-status") ?? "" } } : undefined,
    mobile: has(flags, "mobile"), user: str(flags, "user")
  };
  const outcome = await runEval(job, { timeoutSec: timeoutOf(flags), inline: inline() });
  for (const w of outcome.engineWarnings) console.log(`注意: ${w}`);
  if (outcome.normalize.hasErrors || !outcome.calc) {
    console.log(outcome.normalize.summary);
    console.log("normalize のエラーがあるので calc しない");
    return 1;
  }
  if (outcome.normalize.warnings) console.log(`normalize の警告 ${outcome.normalize.warnings}（normalize で確かめる）`);
  console.log(outcome.calc.text);
  return outcome.calc.failed ? 1 : 0;
}

async function cmdTry(positional: string[], flags: Flags): Promise<number> {
  if (has(flags, "describe")) {
    let targetTypes: ReadonlySet<string> | undefined;
    try {
      targetTypes = new Set((await engineOf()).api.TARGET_TYPES as readonly string[]);
    } catch {
      targetTypes = undefined; // zip が無くても項目は出す（○ / － の印なし）
    }
    console.log(describeSampleApp(targetTypes));
    return 0;
  }
  const formula = positional[1];
  if (!formula) throw new UsageError('try "<式>" [--as <型 | 項目コード>] [--table <テーブル>]（または try --describe）');
  let records: number[] | undefined;
  const recordsFlag = str(flags, "records");
  if (recordsFlag) {
    records = recordsFlag.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
      if (!/^[1-9]$/.test(x)) throw new UsageError(`--records はサンプルレコードの番号（1〜3。カンマ区切り）: ${x}`);
      return Number(x);
    });
  }
  const { src, origin } = usersSourceOf(str(flags, "users"));
  const jsonFlag = (k: string): unknown => {
    const v = str(flags, k);
    if (v === undefined) return undefined;
    if (Buffer.byteLength(v, "utf8") > 64 * 1024) throw new UsageError(`--${k} は 64 KiB まで`);
    try {
      return JSON.parse(v);
    } catch (e) {
      throw new UsageError(`--${k} が JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const fieldsDef = jsonFlag("fields") as TryFieldDef[] | undefined;
  const data = jsonFlag("data") as TryData[] | undefined;
  const base = intFlag(flags, "base", false);
  // --app: 利用者のアプリの項目定義（fields --summary と同じ場所）に架空の値（--data）を当てる。接続先はその profile（無ければ .env）
  let appFields: FieldsFile | undefined;
  let baseUrl: string | undefined;
  const app = intFlag(flags, "app", false);
  if (app !== undefined) {
    const ctx = context(flags);
    const rel = ctx.def ? path.join(existingAppDir(ctx as Ctx & { def: ProfileDef }, app), "fields.json") : path.join("fields", `${app}.json`);
    appFields = readFieldsFile(existingFile(rel, `fields --app ${app}${profileFlag(ctx)}`));
    baseUrl = trustedBaseUrl(ctx.def ? { profile: ctx.def.profile } : null, flags);
  } else if (has(flags, "profile")) throw new UsageError("--profile は --app（利用者のアプリの項目定義）と一緒に使う");
  const job: EvalJob = {
    kind: "try", pluginZip: pluginZipPath(authOpt()), devPluginDir: W.env.FORMULA_ALLOW_DEV_PLUGIN === "1" ? formulaProdDir(W.env) : undefined, baseUrl,
    usersSource: src, usersOrigin: origin, policy: loadPolicy(W.root), lang: str(flags, "lang") as "ja" | "en" | "zh" | undefined,
    try: {
      formulas: [{ formula, as: str(flags, "as"), table: str(flags, "table") }], records, fields: fieldsDef, data, base, appFields, evType: str(flags, "event"),
      event: has(flags, "action") || has(flags, "status") || has(flags, "next-status") ? { action: { value: str(flags, "action") ?? "" }, status: { value: str(flags, "status") ?? "" }, nextStatus: { value: str(flags, "next-status") ?? "" } } : undefined,
      mobile: has(flags, "mobile"), user: str(flags, "user")
    }
  };
  const outcome = await runEval(job, { timeoutSec: timeoutOf(flags), inline: inline() });
  for (const w of outcome.engineWarnings) console.log(`注意: ${w}`);
  if (!outcome.try) throw new Error("try の結果が無い（tools の誤り）");
  console.log(outcome.try.text);
  return outcome.try.results.every((r) => r.status === "ok") ? 0 : 1;
}
type TryFieldDef = import("./commands/try-data.ts").TryFieldDef;
type TryData = import("./commands/try-data.ts").TryData;
type FieldsFile = import("./commands/fields.ts").FieldsFile;

async function cmdUsers(flags: Flags): Promise<number> {
  if (has(flags, "summary")) {
    const { src, origin } = usersSourceOf(str(flags, "users"));
    console.log(summarizeUsers(src, origin, str(flags, "user")));
    return 0;
  }
  if (!has(flags, "pull")) throw new UsageError("users は --summary か --pull");
  const ctx = context(flags);
  // User API の認証: profile の userApiToken か username / password、1 接続の形は FORMULA_USER_API_TOKEN か KINTONE_USERNAME / KINTONE_PASSWORD
  const auth = ctx.def && ctx.mode.kind === "profiles" ? userApiAuthFor(ctx.mode.connections.set, ctx.def) : loadUserApiAuth(authOpt());
  const client = createRestClient(auth);
  const authLabel = `${describeAuth(auth)}${ctx.def ? `（profile ${ctx.def.profile}）` : ""}`;
  const max = intFlag(flags, "max", false);
  const log = (l: string): void => console.log(l);
  const only = str(flags, "only-referenced");
  if (has(flags, "only-referenced") && !only) throw new UsageError("--only-referenced には設定ファイル（settings/<f>.json）を続ける");
  let r: { source: UsersSource; calls: number };
  let note = "";
  if (only) {
    const settingsAbs = existingFile(only, "pull か、設定ファイルを置く");
    const engine = await engineOf();
    const ref = referencedCodesOf(readJsonLimited(settingsAbs), (f) => engine.api.stripFormula(f) as string);
    if (ref.dynamic.length) {
      console.log(`--only-referenced は使えないので全部取る: ログインユーザーや項目の値で決まる呼び出しがある（${ref.dynamic.slice(0, 3).join("、")}${ref.dynamic.length > 3 ? ` ほか ${ref.dynamic.length - 3}` : ""}）`);
      r = await pullUsers(client, { maxCalls: max, log });
    } else if (!ref.users.length && !ref.orgs.length && !ref.groups.length) {
      console.log(`${shown(settingsAbs)} の式にユーザー情報の関数（UINFO / OINFO / GINFO / OUSERS / GUSERS）が無い。取るものが無いので何も書かない（全部取るなら --only-referenced を外す）`);
      return 0;
    } else {
      console.log(`${shown(settingsAbs)} の ${ref.fields} 項目の式が参照するコード: ユーザー ${ref.users.length}、組織 ${ref.orgs.length}、グループ ${ref.groups.length}`);
      r = await pullReferencedUsers(client, ref, { maxCalls: max, log });
      note = "（式が参照するコードとその所属だけ）";
    }
  } else {
    r = await pullUsers(client, { maxCalls: max, log });
  }
  const out = writeJson(str(flags, "out") ?? path.join("users", usersFileNameOf(client.baseUrl)), r.source, WRITE_ROOTS.users, "record", { force: has(flags, "force"), mode: PRIVATE });
  console.log(`${summarizeUsers(r.source, { kind: "file", file: shown(out) })}\n${authLabel}で ${client.baseUrl} から取得（${r.calls} 回）${note}→ ${shown(out)}（個人情報を含む。コミットしない。終わったら消す）`);
  return 0;
}

async function cmdTake(flags: Flags): Promise<number> {
  const ctx = profileContext(flags, "take（inbox/ のダウンロードをアプリのフォルダーへ移す）");
  const r = takeInbox(W.root, ctx.mode, ctx.explicit);
  for (const m of r.moved) console.log(`${m.file} → ${m.to}${m.leftInInbox ? "（置いたが inbox に残った）" : m.same ? "（同じものが既にあったので inbox から消した）" : ""}`);
  for (const s of r.skipped) console.error(`移さない: ${s.file}（${s.reason}）`);
  for (const w of r.warnings) console.error(`注意: ${w}`);
  if (!r.moved.length && !r.skipped.length) console.log(`${INBOX}/ に設定のファイルが無い`);
  return r.skipped.length ? 1 : 0;
}

async function cmdEdit(positional: string[], flags: Flags): Promise<number> {
  const ctx = profileContext(flags, "edit（1 接続の形では settings/ のファイルを写して直す）");
  let src = positional[1];
  if (!src) {
    const app = intFlag(flags, "app", true) as number;
    const list = listAppFolder(existingAppDir(ctx, app), W.root);
    if (!list.snapshots.length) throw new InputError(`${shown(list.dir)} にダウンロード / pull のファイルが無い（設定画面でダウンロードして inbox/ に置き take、または pull --app ${app}${profileFlag(ctx)}）`);
    src = path.join(list.dir, list.snapshots[0]);
  }
  const file = resolveRead(src, W.root);
  if (!SNAPSHOT_RE.test(path.basename(file)) || !appFolderOfFile(W.root, file)) throw new UsageError(`edit に渡すのはアプリのフォルダーのダウンロード / pull のファイル（rex0220-formula-app<番号>-<日時>.json）: ${src}`);
  usable(file);
  if (!existsSync(file)) throw new InputError(`${shown(file)} が無い`);
  const dest = resolveWrite(editNameOf(file), WRITE_ROOTS.kintone, W.root);
  if (existsSync(dest)) {
    console.log(`既にある（続けて直す）: ${shown(dest)}`);
  } else {
    allow(dest, "settings");
    writeText(dest, readTextLimited(file), WRITE_ROOTS.kintone, "settings");
    console.log(`${shown(file)} → ${shown(dest)}（ここを直す。ダウンロードのファイルは書き換えない）`);
  }
  console.log(`次: 直したら npx @rex0220/formula-authoring-tools normalize ${shown(dest)} → diff ${shown(file)} ${shown(dest)} → calc ${shown(dest)} --app ${appFolderOfFile(W.root, file)?.appId} --id R`);
  return 0;
}

async function cmdFiles(flags: Flags): Promise<number> {
  const ctx = profileContext(flags, "files");
  const app = intFlag(flags, "app", true) as number;
  const l = listAppFolder(existingAppDir(ctx, app), W.root);
  const lines = [
    `${shown(l.dir)}（profile ${ctx.def.profile}、${ctx.def.baseUrl}${ctx.def.guestSpaceId ? `、ゲストスペース ${ctx.def.guestSpaceId}` : ""}）`,
    `fields.json: ${l.hasFields ? "あり" : `無い（npx @rex0220/formula-authoring-tools fields --app ${app}${profileFlag(ctx)}）`}`,
    `ダウンロード / pull（新しい順。先頭が今の設定）: ${l.snapshots.length ? "" : "無い"}`,
    ...l.snapshots.map((n, i) => `  ${n}${i === 0 ? "  ← 今の設定" : ""}`),
    `直したもの（-edit.json）: ${l.edits.length ? "" : "無い"}`,
    ...l.edits.map((n) => `  ${n}`),
    `その他の設定（AI が作ったもの）: ${l.others.length ? "" : "無い"}`,
    ...l.others.map((n) => `  ${n}`),
    `records/: ${l.records.length ? l.records.join(", ") : "無い"}`
  ];
  console.log(lines.join("\n"));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  W = createContext({ cwd: process.cwd(), env: process.env });
  MODE = undefined;
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? "help";
  try {
    if (has(flags, "profile")) {
      const name = str(flags, "profile");
      if (!name || !PROFILE_NAME_RE.test(name)) throw new UsageError("--profile には接続のファイルの profile の名前（英数字と - _）を続ける");
      if (mode().kind !== "profiles") throw new UsageError("--profile は kintone の接続のファイル（FORMULA_KINTONE_CONFIG）があるときだけ使える");
    }
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
      case "normalize": return await cmdNormalize(positional, flags);
      case "calc": return await cmdCalc(positional, flags);
      case "try": return await cmdTry(positional, flags);
      case "take": return await cmdTake(flags);
      case "edit": return await cmdEdit(positional, flags);
      case "files": return await cmdFiles(flags);
      default:
        console.error(`不明なコマンド: ${command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof PathError) {
      console.error(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (
      e instanceof PluginZipError || e instanceof AuthError || e instanceof UsersDataError || e instanceof InputError || e instanceof RestError || e instanceof NotAllowedError ||
      e instanceof KintoneUrlError || e instanceof QueryError || e instanceof UsersPullError || e instanceof PolicyError || e instanceof EvalTimeoutError ||
      e instanceof ConnectionError || e instanceof PermissionError || e instanceof WorkspaceError || e instanceof FileExistsError
    ) {
      console.error(e.message);
      return 1;
    }
    if (e instanceof EvalError) {
      // Worker の中の誤り: 中核の誤り（zip、入力、ユーザー情報、policy。kind は中核が instanceof で決める）は文言だけ出して 1。
      // それ以外（zip のコードが投げた例外など。kind other）は種類だけ（文はレコードの値を含みうるので出さない。Codex の r4 レビュー B1）
      if (e.kind !== "other") {
        console.error(e.message);
        return 1;
      }
      console.error(`評価の途中で想定外の誤り（${e.innerName}）。誤りの文は値を含みうるので表示しない（FORMULA_DEBUG=1 で表示）。normalize で設定を、version で zip を確かめる`);
      if (W.env.FORMULA_DEBUG === "1") console.error(e.message);
      return 1;
    }
    // tools 自身の想定外の誤り（主スレッド。pull や summary では zip のコードも動く）: 種類だけ（instanceof で決めた組み込みの名前。constructor.name は使わない。FORMULA_DEBUG=1 で文とスタック）
    const name = builtinErrorName(e);
    console.error(`想定外の誤り（${name}）。誤りの文は値を含みうるので表示しない（FORMULA_DEBUG=1 で表示）`);
    if (W.env.FORMULA_DEBUG === "1") console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    return 1;
  }
}

// 起動の判定: npx の bin（node_modules/.bin/formula-authoring）は dist/cli.mjs への symlink なので実体のパスで比べる
const invokedRaw = process.argv[1] ? path.resolve(process.argv[1]) : "";
let invoked = invokedRaw;
try {
  invoked = invokedRaw ? realpathSync(invokedRaw) : "";
} catch {
  invoked = invokedRaw;
}
let self = "";
try {
  self = realpathSync(fileURLToPath(import.meta.url));
} catch {
  self = fileURLToPath(import.meta.url);
}
if (invoked && (invoked === self || /[\\/]dist[\\/]cli\.mjs$/.test(invoked))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
    // main の外の失敗（起動の前）: 種類だけ（組み込みの名前）
    console.error(`想定外の誤り（${builtinErrorName(e)}）`);
    process.exitCode = 1;
  });
}
