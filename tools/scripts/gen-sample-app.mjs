// サンプルアプリ（計画 25 章 工程 8-2）: 実機のサンプルアプリ「計算式サンプル」から項目定義とレコード 3 件を取り、
// 実在のもの（接続先、ユーザー・組織・グループ、作成者・更新者、日時）を既定のテストデータ（架空の 10 人）と固定の値に置き換えて src/sample-app/ に書く。
//   - 接続は接続のファイル（FORMULA_KINTONE_CONFIG = kSQL の ksql.config.json の形。環境変数で絶対パス）の profile（--profile。既定 dev）
//   - 出力: src/sample-app/fields.json、record-1.json … record-N.json（records/ という名前は使わない = forbidden-files の決まり）
//   - 置き換え: baseUrl → https://example.cybozu.com、fetchedAt / 作成日時 / 更新日時 → 固定、ユーザー選択・作成者・更新者・作業者 → demo_user、組織 → demo_*、グループ → demo_*。
//     レコード 1（典型）は空のユーザー・組織・グループに架空の値を入れる。2（端）と 3（空）は空のまま
// 使い方: FORMULA_KINTONE_CONFIG=/abs/ksql.config.json node scripts/gen-sample-app.mjs --app 4329 [--profile dev] [--ids 1,2,3]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const core = await import(pathToFileURL(path.join(root, "src", "core.ts")).href);

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const app = Number(arg("app"));
if (!Number.isInteger(app) || app <= 0) throw new Error("--app <番号> が要る");
const profile = arg("profile", "dev");
const ids = String(arg("ids", "1,2,3")).split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 0);
const configFile = process.env.FORMULA_KINTONE_CONFIG;
if (!configFile || !path.isAbsolute(configFile)) throw new Error("FORMULA_KINTONE_CONFIG に接続のファイルの絶対パスが要る");

const set = core.loadConnections(configFile, { workspaceRoots: [root], env: process.env });
const def = core.pickProfile(set, profile);
const client = core.createRestClient(core.authFor(set, def, app));
const guestSpaceId = def.guestSpaceId ?? undefined;

const FIXED_TIME = "2026-01-15T00:00:00.000Z";
const EXAMPLE = "https://example.cybozu.com";
const users = new Map(core.DEFAULT_USERS.users.map((u) => [u.code, u]));
const orgs = core.DEFAULT_USERS.organizations;
const groups = core.DEFAULT_USERS.groups;
const userRef = (code) => ({ code, name: users.get(code).name });
const orgRef = (o) => ({ code: o.code, name: o.name });
/** 典型のレコードに入れる架空の値（項目コードの末尾の番号で変える） */
const pick = (list, code, n) => list[(Number(/(\d+)$/.exec(code)?.[1] ?? 1) - 1 + n) % list.length];
const USER_CODES = [...users.keys()].filter((c) => c !== "authoring");

const fields = await core.fetchFields(client, { app, guestSpaceId });
const typeOf = new Map();
for (const [code, p] of Object.entries(fields.properties)) {
  typeOf.set(code, p.type);
  if (p.type === "SUBTABLE") for (const [c, q] of Object.entries(p.fields)) typeOf.set(c, q.type);
}
fields.fetchedAt = FIXED_TIME;
fields.baseUrl = EXAMPLE;
fields.revision = "1";

function replaceValue(code, type, v, typical) {
  switch (type) {
    case "USER_SELECT":
    case "STATUS_ASSIGNEE": {
      if (Array.isArray(v) && v.length) return v.map((_, i) => userRef(pick(USER_CODES, code, i)));
      return typical && type === "USER_SELECT" ? (/2$/.test(code) ? [userRef("demo_user01"), userRef("demo_user02")] : [userRef(pick(USER_CODES, code, 0))]) : [];
    }
    case "CREATOR":
    case "MODIFIER":
      return userRef(type === "CREATOR" ? "demo_user01" : "demo_user02");
    case "ORGANIZATION_SELECT":
      if (Array.isArray(v) && v.length) return v.map((_, i) => orgRef(pick(orgs, code, i)));
      return typical ? [orgRef(pick(orgs, code, 0))] : [];
    case "GROUP_SELECT":
      if (Array.isArray(v) && v.length) return v.map((_, i) => orgRef(pick(groups, code, i)));
      return typical ? [orgRef(pick(groups, code, 0))] : [];
    case "CREATED_TIME":
    case "UPDATED_TIME":
      return FIXED_TIME.replace(/\.000Z$/, "Z");
    case "FILE":
      return [];
    default:
      return v;
  }
}

function replaceRecord(record, typical) {
  const out = {};
  for (const [code, f] of Object.entries(record)) {
    const type = f.type;
    if (type === "SUBTABLE") {
      out[code] = { type, value: (f.value ?? []).map((row) => ({ id: row.id, value: replaceRecord(row.value, typical) })) };
    } else out[code] = { type, value: replaceValue(code, type, f.value, typical) };
  }
  return out;
}

const outDir = path.join(root, "src", "sample-app");
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "fields.json"), `${JSON.stringify(fields, null, 2)}\n`);
for (const [i, id] of ids.entries()) {
  const file = await core.fetchRecord(client, { app, id, guestSpaceId });
  file.fetchedAt = FIXED_TIME;
  file.baseUrl = EXAMPLE;
  file.record = replaceRecord(file.record, i === 0);
  writeFileSync(path.join(outDir, `record-${id}.json`), `${JSON.stringify(file, null, 2)}\n`);
}
// 書いたものに実在の接続先が残っていないか
const host = new URL(def.baseUrl).host;
for (const f of ["fields.json", ...ids.map((id) => `record-${id}.json`)]) {
  const text = (await import("node:fs")).readFileSync(path.join(outDir, f), "utf8");
  if (text.includes(host)) throw new Error(`${f} に接続先のホスト名が残っている`);
}
console.log(`[gen-sample-app] アプリ ${app} ${fields.appName}（項目 ${Object.keys(fields.properties).length}）とレコード ${ids.join(", ")} を ${path.relative(root, outDir)} に書いた（接続先・ユーザー・組織・グループ・日時は架空の値に置き換え）`);
