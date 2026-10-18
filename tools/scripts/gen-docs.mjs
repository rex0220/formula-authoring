/**
 * テンプレートの機械生成（オーサリングツール_実装計画.md 8 章）。zip の authoring API とエンジンから作るので、プラグインの版が変わったら作り直す。
 *   docs/schema-manifest.json … CONFIG_SCHEMA を歩いたキーのパス・型・上限・列挙 + 元の値 / 派生値のキー + 既定値 + 対象の型 + 関数の分類 + スキーマの版
 *   docs/設定ファイル仕様.md     … AI が書く元の値（FormulaSource）の封筒と各キー（manifest から）
 *   docs/関数一覧.md             … エンジンの説明文（ja）を関数ごとに。FUNCTION_TAGS の印（副作用 / 文脈 / ユーザー情報 / イベント / 再計算で変わる）
 *   docs/functions.json          … 関数名 → type と印（tools の normalize と同じ元）
 *   docs/既定のテストデータ.md    … users の既定のテストデータ（架空）の一覧
 *   samples/users.json           … 既定のテストデータをそのまま（--users の形の例）
 *   docs/計算パターン_検証.md     … 計算パターン集の例を同梱のサンプルアプリで評価した結果と、関数一覧の使用例の評価（scripts/verify-patterns.mjs。工程 8-4）
 * 実行: tools/ で `npm run gen-docs`（.env の FORMULA_PLUGIN_ZIP か、開発中は FORMULA_ALLOW_DEV_PLUGIN=1）。test/docs-sync.test.mjs が生成物と一致するか確かめる。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateVerification } from "./verify-patterns.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tools = path.resolve(here, "..");
const repo = path.resolve(tools, "..");

function walk(schema, pathStr, out) {
  const base = { path: pathStr, type: schema.type, optional: !!schema.optional };
  switch (schema.type) {
    case "string":
    case "scalar-string":
      out.push({ ...base, ...(schema.maxLength !== undefined ? { maxLength: schema.maxLength } : {}), ...(schema.enum ? { enum: [...schema.enum] } : {}), ...(schema.pattern ? { pattern: String(schema.pattern) } : {}) });
      return;
    case "number":
      out.push({ ...base, ...(schema.min !== undefined ? { min: schema.min } : {}), ...(schema.max !== undefined ? { max: schema.max } : {}), ...(schema.integer ? { integer: true } : {}) });
      return;
    case "boolean":
      out.push({ ...base, ...(schema.loose ? { loose: true } : {}) });
      return;
    case "array":
      out.push({ ...base, ...(schema.maxItems !== undefined ? { maxItems: schema.maxItems } : {}) });
      walk(schema.items, `${pathStr}[]`, out);
      return;
    case "object":
      out.push({ ...base, ...(schema.unknown ? { unknown: schema.unknown } : {}) });
      for (const [k, v] of Object.entries(schema.props ?? {})) walk(v, `${pathStr}.${k}`, out);
      return;
    case "map":
      out.push({ ...base, ...(schema.maxKeys !== undefined ? { maxKeys: schema.maxKeys } : {}) });
      walk(schema.values, `${pathStr}.<key>`, out);
      return;
    default:
      out.push(base);
  }
}

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** 生成物（path → 本文）。engine は読み込み済みのもの */
export function generateDocs(engine, { DEFAULT_USERS, schemaRevisionOf }) {
  const api = engine.api;
  const files = new Map();
  const ver = engine.source.pluginVersion;
  const rev = schemaRevisionOf(api.CONFIG_SCHEMA);
  const entries = [];
  walk(api.CONFIG_SCHEMA, "$", entries);
  const docs = engine.functionDocs();
  const tagsOf = (name) => api.functionTagsOf(name);
  const functions = Object.fromEntries(Object.keys(docs).sort().map((n) => [n, { type: docs[n].type, tags: tagsOf(n) }]));
  const manifest = {
    generatedFrom: { pluginVersion: ver, apiVersion: api.apiVersion, schemaRevision: rev },
    sourceKeys: [...api.SOURCE_KEYS], derivedKeys: [...api.DERIVED_KEYS], screenRowKeys: [...api.INFO_SCREEN_KEYS],
    targetTypes: [...api.TARGET_TYPES], miscDefaults: api.MISC_DEFAULTS, btnDefaults: api.defaultBtnInfo("ja"), functionTags: api.FUNCTION_TAGS,
    entries
  };
  files.set("docs/schema-manifest.json", JSON.stringify(manifest, null, 2) + "\n");

  // 設定ファイル仕様
  const srcSet = new Set(api.SOURCE_KEYS);
  const topOf = (p) => p.split(/[.[]/)[1];
  const rows = entries.filter((e) => e.path !== "$" && srcSet.has(topOf(e.path)) && !/\.(id|row_type|type|fieldlabel|fieldno|tableno|tablepos|message|ptcode|usedFields|width|formula)$/.test(e.path));
  const limit = (e) => [e.maxLength !== undefined ? `${e.maxLength.toLocaleString()} 字まで` : "", e.enum ? `${e.enum.join(" / ")}` : "", e.integer ? "整数" : "", e.min !== undefined ? `${e.min} 以上` : "", e.max !== undefined ? `${e.max} 以下` : "", e.maxItems !== undefined ? `${e.maxItems} 件まで` : "", e.maxKeys !== undefined ? `${e.maxKeys} キーまで` : "", e.loose ? "\"true\" / \"false\" / 1 / 0 も可" : ""].filter(Boolean).join("、");
  const spec = [];
  spec.push("# 設定ファイル仕様（AI が書く元の値 FormulaSource の封筒）");
  spec.push("");
  spec.push(`計算式プラグイン Ver.${ver}（authoring API ${api.apiVersion}、設定スキーマの版 ${rev}）の \`CONFIG_SCHEMA\` から \`tools/scripts/gen-docs.mjs\` が作る。手で直さない。`);
  spec.push("");
  spec.push("## 封筒");
  spec.push("");
  spec.push("設定画面の「ダウンロード」と同じ形。`pull` と `normalize --out` もこの形で書く。`date` と `appName` は表示用。");
  spec.push("");
  spec.push("| キー | 値 |");
  spec.push("| --- | --- |");
  spec.push(`| \`pluginID\` | \`"${api.pluginId}"\`（固定） |`);
  spec.push(`| \`PluginVersion\` | \`"${ver}"\`（zip の版。古い版の設定も取り込める） |`);
  spec.push("| `appId` | アプリ番号（正の整数。fields のアプリと同じ） |");
  spec.push("| `appName` / `date` | 表示用 |");
  spec.push("");
  spec.push("## 元の値のキー（この順で書く）");
  spec.push("");
  spec.push("`normalize` が既定値を補うので、変えるキーだけ書けばよい（`pluginInfos` は必須）。知らないキーはエラー。派生値のキー（下）は書かない。");
  spec.push("");
  spec.push("| パス | 型 | 任意 | 上限・列挙 |");
  spec.push("| --- | --- | --- | --- |");
  for (const e of rows) spec.push(`| \`${esc(e.path)}\` | ${e.type} | ${e.optional ? "任意" : "必須"} | ${esc(limit(e))} |`);
  spec.push("");
  spec.push("## pluginInfos の 1 行（項目ごとの設定）");
  spec.push("");
  spec.push("| キー | 意味 |");
  spec.push("| --- | --- |");
  spec.push("| `fieldcode` | 項目のフィールドコード（ラベルではない。`fields --summary` の ○ の型だけ） |");
  spec.push("| `state` | 計算する（true）。false なら計算式があっても計算しない |");
  spec.push("| `formulaSet` | 計算式（`//` から行末まではコメント。改行は実行時に無視。文字列の中の `//` もコメントになる） |");
  spec.push("| `edit` | 画面で編集できる（既定 false。計算式が入れた値を利用者が直せる） |");
  spec.push("| `hide` | 画面で非表示（既定 false） |");
  spec.push("| `rank` | 計算の順（整数 -10000〜10000。**大きい順**に計算。`\"\"` は 0。同じならレイアウトの順 = テーブルの外の項目（1 回目）: 上から下、同じ行では左から右 → テーブルの中の項目: 左から右 → テーブルの外の項目（2 回目）: 上から下、同じ行では左から右。この順で合うならランクは付けない。参照される項目が後ろにあるときだけ、その項目に参照する項目より**大きい**ランクを付ける） |");
  spec.push("");
  spec.push(`計算式を設定できる型: ${api.TARGET_TYPES.join(", ")}`);
  spec.push("");
  spec.push("## 各種設定（pluginMiscInfo）の既定");
  spec.push("");
  spec.push("| キー | 既定 |");
  spec.push("| --- | --- |");
  for (const [k, v] of Object.entries(api.MISC_DEFAULTS)) spec.push(`| \`${k}\` | ${v} |`);
  spec.push("");
  spec.push("既定から変えると `normalize` が警告する（利用者が決めること。policy の `allowMiscChanges`）。`circular_refer` は循環参照を許す、`userInfo` は UINFO 系の関数を使う、`async` は値変更イベントの非同期計算。");
  spec.push("");
  spec.push("## ボタン（pluginBtnInfo）の既定");
  spec.push("");
  spec.push("```json");
  spec.push(JSON.stringify(api.defaultBtnInfo("ja"), null, 2));
  spec.push("```");
  spec.push("");
  spec.push("`detail_btn`（詳細画面の「計算」）、`list_btn`（一覧の「一括計算」）。`state` で出す。`ja` / `en` / `zh` が空なら `default`。");
  spec.push("");
  spec.push("## 書かないキー（派生値・外枠）");
  spec.push("");
  spec.push(`派生値（設定画面が保存時に作り直す。tools は捨てる）: ${api.DERIVED_KEYS.map((k) => `\`${k}\``).join(", ")}`);
  spec.push("");
  spec.push(`画面の行のキー（捨てる）: ${api.INFO_SCREEN_KEYS.map((k) => `\`${k}\``).join(", ")}`);
  spec.push("");
  files.set("docs/設定ファイル仕様.md", spec.join("\n") + "\n");

  // 関数一覧
  const tagLabel = { sideEffect: "副作用", kintoneContext: "kintone の文脈", userInfo: "ユーザー情報", event: "イベント", volatile: "再計算で変わる" };
  const fl = [];
  fl.push("# 関数一覧（計算式エンジンの説明文から）");
  fl.push("");
  fl.push(`計算式プラグイン Ver.${ver} の計算式エンジンが持つ ${Object.keys(docs).length} 個の関数。設定画面の「?」と計算式ツールと同じ説明（日本語）。\`tools/scripts/gen-docs.mjs\` が作る。手で直さない。`);
  fl.push("関数名で検索して読む（全部は読まない）。印: " + Object.entries(tagLabel).map(([k, v]) => `**${v}**（${k}）`).join("、") + "。副作用のある関数は tools が評価しない（policy で承認）。EV_SET は設定に入れない。");
  fl.push("使用例はエンジンの説明文に同梱のもの（`->` の結果は計算式プラグインの開発時に実際に評価して確かめている。項目や日時に依る例は環境で変わる。tools の gen-docs も評価し、合わない例は [計算パターン_検証.md](計算パターン_検証.md) の末尾に列挙）。");
  fl.push("");
  fl.push("| 関数 | 引数 | 説明 | 分類 | 印 |");
  fl.push("| --- | --- | --- | --- | --- |");
  for (const name of Object.keys(docs).sort()) {
    const d = docs[name];
    const lines = d.ja.split("\n");
    const args = lines[0] ?? "";
    const summary = (lines.slice(1).find((l) => l.trim() && !/^ ?ex:/.test(l)) ?? "").trim();
    fl.push(`| \`${name}\` | ${esc(args)} | ${esc(summary)} | ${d.type.join(", ")} | ${tagsOf(name).map((t) => tagLabel[t]).join("、")} |`);
  }
  fl.push("");
  fl.push("## 使用例（説明文の ex:）");
  fl.push("");
  for (const name of Object.keys(docs).sort()) {
    const d = docs[name];
    const i = d.ja.indexOf("ex:");
    if (i < 0) continue;
    const ex = d.ja.slice(i + 3).split("\n").map((l) => l.replace(/^ /, "")).filter((l) => l.trim());
    if (!ex.length) continue;
    fl.push(`### ${name}`);
    fl.push("");
    fl.push("```");
    for (const l of ex) fl.push(l);
    fl.push("```");
    fl.push("");
  }
  files.set("docs/関数一覧.md", fl.join("\n"));
  files.set("docs/functions.json", JSON.stringify({ pluginVersion: ver, functions }, null, 2) + "\n");

  // 既定のテストデータ
  const ud = [];
  ud.push("# 既定のテストデータ（ユーザー・組織・グループ。架空）");
  ud.push("");
  ud.push("`calc` が UINFO 系（UINFO / OINFO / GINFO / OUSERS / GUSERS）と LOGIN_* に使う既定のデータ。実在しない人・組織・メール（example.com）。`--users <file>` で差し替えられる（同じ形は `samples/users.json`）。");
  ud.push("kintone の最低契約ユーザー数と同じ 10 人。`boss` はカスタマイズ項目（上司のログイン名。`UINFO(LOGIN_CODE(), \"#boss\")`）。`calc` の既定のログインユーザーは `authoring`。");
  ud.push("");
  ud.push("| ログイン名 | 表示名 | 所属組織 | グループ | boss | locale |");
  ud.push("| --- | --- | --- | --- | --- | --- |");
  const orgsOf = {};
  for (const o of DEFAULT_USERS.organizations) for (const c of o.users) (orgsOf[c] ??= []).push(o.code);
  const groupsOf = {};
  for (const g of DEFAULT_USERS.groups) for (const c of g.users) (groupsOf[c] ??= []).push(g.code);
  for (const u of DEFAULT_USERS.users) ud.push(`| \`${u.code}\` | ${u.name} | ${(orgsOf[u.code] ?? []).join(", ")} | ${(groupsOf[u.code] ?? []).join(", ")} | ${u.customItemValues?.find((c) => c.code === "boss")?.value || "（なし）"} | ${u.locale} |`);
  ud.push("");
  ud.push("| 組織 | 名前 | 親 | 所属 |");
  ud.push("| --- | --- | --- | --- |");
  for (const o of DEFAULT_USERS.organizations) ud.push(`| \`${o.code}\` | ${o.name} | ${o.parentCode ?? "（なし）"} | ${o.users.join(", ")} |`);
  ud.push("");
  ud.push("| グループ | 名前 | 所属 |");
  ud.push("| --- | --- | --- |");
  for (const g of DEFAULT_USERS.groups) ud.push(`| \`${g.code}\` | ${g.name} | ${g.users.join(", ")} |`);
  ud.push("");
  files.set("docs/既定のテストデータ.md", ud.join("\n"));
  files.set("samples/users.json", JSON.stringify(DEFAULT_USERS, null, 2) + "\n");
  return files;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === path.resolve(fileURLToPath(import.meta.url))) {
  const { loadEngine } = await import(pathToFileURL(path.join(tools, "src", "engine.ts")).href);
  const { DEFAULT_USERS } = await import(pathToFileURL(path.join(tools, "src", "users", "index.ts")).href);
  const { schemaRevisionOf } = await import(pathToFileURL(path.join(tools, "src", "meta.ts")).href);
  const { devPluginZip, formulaProdDir } = await import(pathToFileURL(path.join(tools, "src", "dev-paths.ts")).href);
  const zip = process.env.FORMULA_PLUGIN_ZIP || devPluginZip();
  const engine = await loadEngine({ pluginZip: zip ?? undefined, devPluginDir: zip ? undefined : formulaProdDir(process.env), mode: "dev" });
  const files = generateDocs(engine, { DEFAULT_USERS, schemaRevisionOf });
  const { trySettings } = await import(pathToFileURL(path.join(tools, "src", "commands", "try.ts")).href);
  const { defaultUsersInfo } = await import(pathToFileURL(path.join(tools, "src", "users", "index.ts")).href);
  const { quiet } = await import(pathToFileURL(path.join(tools, "src", "input.ts")).href);
  const v = await generateVerification({ engine, trySettings, defaultUsersInfo, quiet });
  for (const [rel, text] of v.files) files.set(rel, text);
  console.log(`検証: ケース ${v.summary.cases}、式 ${v.summary.formulas}、一致 ${v.summary.ok}、不一致 ${v.summary.ng}。使用例 ${v.summary.examples.total}（一致 ${v.summary.examples.ok}、合わない ${v.summary.examples.ng}、評価できない ${v.summary.examples.err}）`);
  for (const [rel, text] of files) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    console.log(`wrote ${rel} (${Buffer.byteLength(text).toLocaleString()} bytes)`);
  }
}
