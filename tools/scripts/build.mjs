/**
 * tools をビルドする（docs/authoring-plan.md 12.1、12.9 の 9）。
 *   - src/cli.ts を esbuild で 1 本（dist/cli.mjs。platform node、ESM、Node 20）。happy-dom は依存のまま外に置く
 *   - 計算式プラグインと kit のコードは bundle に入れない（型だけ import している。実行時は利用者の計算式プラグイン zip の authoring API と計算式エンジンを読む）
 *   - tools の版と commit を __FORMULA_TOOLS_META__ に埋める（version コマンドが出す）
 */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// 前のビルドの残り（以前は dist/lib/ にエンジンを複写していた）を消す。npm pack は dist/** を全部入れるので、古いファイルが残っていると配布物に入る
rmSync(path.join(root, "dist"), { recursive: true, force: true });
const { devMeta } = await import(pathToFileURL(path.join(root, "src", "meta.ts")).href);
const { kitRoot, rexgridRoot, FORMULA_ROOT } = await import(pathToFileURL(path.join(root, "src", "dev-paths.ts")).href);

const meta = { ...devMeta(), builtAt: new Date().toISOString(), mode: "build" };
const banner = `#!/usr/bin/env node\n/*! @rex0220/formula-authoring-tools ${meta.toolsVersion} (c) rex0220. MIT License. 計算式エンジンと計算式プラグインのコードは利用者の計算式プラグインプラグインの zip から読む（このファイルには含まれない）。commit ${meta.commit}. */`;
const result = await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile: path.join(root, "dist", "cli.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  charset: "utf8",
  legalComments: "none",
  external: ["happy-dom"],
  banner: { js: banner },
  define: { __FORMULA_TOOLS_META__: JSON.stringify(JSON.stringify(meta)) },
  // 型だけの import が残っていればここで解決される（実行コードには入らない）。入っていないことを下で確かめる
  alias: { formula: FORMULA_ROOT, "plugin-config-kit": kitRoot(), rexgrid: rexgridRoot() },
  absWorkingDir: root,
  metafile: true,
  logLevel: "warning"
});
const inputs = Object.keys(result.metafile.inputs);
const leaked = inputs.filter((p) => /formula[\\/](src|lib|prod)[\\/]|plugin-config-kit[\\/]src|rexgrid[\\/]src/.test(p));
if (leaked.length) {
  console.error(`計算式プラグイン / kit / rexgrid のコードが bundle に入っている（型だけの import にする）:\n  ${leaked.join("\n  ")}`);
  process.exit(1);
}
// 作った bundle が起動するか（1-10 の後に、ソースの shebang と banner の shebang が重なって構文エラーになったことがある）
const smoke = spawnSync(process.execPath, [path.join(root, "dist", "cli.mjs"), "help"], { encoding: "utf8" });
if (smoke.status !== 0 || !/使い方: npx @rex0220\/formula-authoring-tools/.test(smoke.stdout)) {
  console.error(`dist/cli.mjs が起動しない（exit ${smoke.status}）:\n${smoke.stderr}`);
  process.exit(1);
}
const size = readFileSync(path.join(root, "dist", "cli.mjs")).length;
console.log(`wrote dist/cli.mjs (${size.toLocaleString()} bytes; tools ${meta.toolsVersion}, commit ${meta.commit}; ${inputs.length} inputs, 計算式プラグイン / kit のコードは含まない, help が起動する)`);

// 評価の Worker の入口（dist/eval-worker.mjs。cli.mjs の隣。normalize / calc の評価を Worker で動かして時間上限で止める）
const wk = await build({
  entryPoints: [path.join(root, "src", "worker", "eval-worker.ts")],
  outfile: path.join(root, "dist", "eval-worker.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  charset: "utf8",
  legalComments: "none",
  external: ["happy-dom"],
  define: { __FORMULA_TOOLS_META__: JSON.stringify(JSON.stringify(meta)) },
  alias: { formula: FORMULA_ROOT, "plugin-config-kit": kitRoot(), rexgrid: rexgridRoot() },
  absWorkingDir: root,
  metafile: true,
  logLevel: "warning"
});
const wkLeaked = Object.keys(wk.metafile.inputs).filter((p) => /formula[\\/](src|lib|prod)[\\/]|plugin-config-kit[\\/]src|rexgrid[\\/]src/.test(p));
if (wkLeaked.length) {
  console.error(`Worker の入口に計算式プラグイン / kit / rexgrid のコードが入っている:\n  ${wkLeaked.join("\n  ")}`);
  process.exit(1);
}
console.log(`wrote dist/eval-worker.mjs (${readFileSync(path.join(root, "dist", "eval-worker.mjs")).length.toLocaleString()} bytes)`);

// 共通の中核の入口（@rex0220/formula-authoring-tools/core。後の formula MCP が使う）:
// dist/core.mjs（ESM。happy-dom は依存のまま外に置く。vendor/ の moment はパッケージの vendor/ を読む）と dist/types/（型。tsc の宣言だけ）
const coreBanner = `/*! @rex0220/formula-authoring-tools/core ${meta.toolsVersion} (c) rex0220. MIT License. 計算式エンジンと計算式プラグインのコードは利用者の計算式プラグインプラグインの zip から読む（このファイルには含まれない）。commit ${meta.commit}. */`;
const core = await build({
  entryPoints: [path.join(root, "src", "core.ts")],
  outfile: path.join(root, "dist", "core.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  charset: "utf8",
  legalComments: "none",
  external: ["happy-dom"],
  banner: { js: coreBanner },
  define: { __FORMULA_TOOLS_META__: JSON.stringify(JSON.stringify(meta)) },
  alias: { formula: FORMULA_ROOT, "plugin-config-kit": kitRoot(), rexgrid: rexgridRoot() },
  absWorkingDir: root,
  metafile: true,
  logLevel: "warning"
});
const coreInputs = Object.keys(core.metafile.inputs);
const coreLeaked = coreInputs.filter((p) => /formula[\\/](src|lib|prod)[\\/]|plugin-config-kit[\\/]src|rexgrid[\\/]src|[\\/]src[\\/](cli|dev-paths)\.ts$/.test(p));
if (coreLeaked.length) {
  console.error(`中核の入口に入れてはいけないもの（計算式プラグイン / kit / rexgrid のコード、cli.ts、dev-paths.ts）が入っている:\n  ${coreLeaked.join("\n  ")}`);
  process.exit(1);
}
// 型: ① 本物の型（計算式プラグインの型を含む）で検査する（誤りがあれば止める）→ ② 計算式プラグインの型を代わりの型（scripts/types-stub/。any）にして宣言だけを作る
// （計算式プラグインの型は計算式プラグインのリポジトリにあり npm に出さない。② の検査の誤りは代わりの型によるものなので見ない。正しさは ① で確かめる）
// → ③ 宣言の中の計算式プラグインの参照を、同梱した代わりの型（dist/types/_formula/）に向け直す → ④ 読み込む側の設定で、宣言の検査も省かずに通るか
const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
const check = spawnSync(process.execPath, [tscBin, "--noEmit", "-p", path.join(root, "tsconfig.json")], { encoding: "utf8", cwd: root });
if (check.status !== 0) {
  console.error(`型の検査で誤りがある（exit ${check.status}）:\n${check.stdout}${check.stderr}`);
  process.exit(1);
}
const typesDir = path.join(root, "dist", "types");
rmSync(typesDir, { recursive: true, force: true });
spawnSync(process.execPath, [tscBin, "-p", path.join(root, "tsconfig.types.json")], { encoding: "utf8", cwd: root });
if (!existsSync(path.join(typesDir, "core.d.ts"))) {
  console.error("中核の型（dist/types/core.d.ts）を作れなかった");
  process.exit(1);
}
const stubRoot = path.join(root, "scripts", "types-stub", "formula");
const stubOut = path.join(typesDir, "_formula");
cpSync(stubRoot, stubOut, { recursive: true });
const dtsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? dtsFiles(path.join(dir, d.name)) : d.name.endsWith(".d.ts") ? [path.join(dir, d.name)] : []));
for (const f of dtsFiles(typesDir)) {
  if (f.startsWith(stubOut)) continue;
  const text = readFileSync(f, "utf8");
  const next = text.replace(/from "formula\/(src\/[^"]+\.ts)"/g, (_m, rel) => {
    let r = path.relative(path.dirname(f), path.join(stubOut, rel)).replace(/\\/g, "/");
    if (!r.startsWith(".")) r = `./${r}`;
    return `from "${r}"`;
  });
  if (/from "(formula|plugin-config-kit|rexgrid)\//.test(next)) {
    console.error(`中核の型に計算式プラグイン / kit / rexgrid への参照が残っている: ${path.relative(root, f)}`);
    process.exit(1);
  }
  if (next !== text) writeFileSync(f, next);
}
const consumerDir = mkdtempSync(path.join(os.tmpdir(), "formula-core-types-"));
try {
  writeFileSync(
    path.join(consumerDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [path.join(root, "node_modules", "@types")],
        paths: { "@rex0220/formula-authoring-tools/core": [path.join(typesDir, "core.d.ts")] }
      },
      include: ["main.ts"]
    })
  );
  writeFileSync(
    path.join(consumerDir, "main.ts"),
    `import { CORE_API_VERSION, createContext, loadEngine, defaultUsersInfo, type Engine, type EngineContext } from "@rex0220/formula-authoring-tools/core";
export async function f(zip: string): Promise<Engine> {
  const ctx = createContext({ cwd: "/", env: {} });
  const engine = await loadEngine({ pluginZip: zip, mode: "build" });
  const c: EngineContext = engine.context();
  engine.setContext({ appId: c.appId + 1, usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" } });
  return ctx.root ? engine : engine;
}
export const v: 1 = CORE_API_VERSION;
`
  );
  const consumer = spawnSync(process.execPath, [tscBin, "-p", path.join(consumerDir, "tsconfig.json")], { encoding: "utf8" });
  if (consumer.status !== 0) {
    console.error(`中核の型を読み込む側で使えない（exit ${consumer.status}）:\n${consumer.stdout}${consumer.stderr}`);
    process.exit(1);
  }
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
}
// 入口が読み込めて、版が build で、公開の関数があるか（中核は読み込んだだけでは何も読み書きしない）
const coreSmoke = spawnSync(process.execPath, ["--input-type=module", "-e", `const c = await import(${JSON.stringify(pathToFileURL(path.join(root, "dist", "core.mjs")).href)}); const m = c.toolsMeta(); if (c.CORE_API_VERSION !== 1 || m.mode !== "build" || typeof c.loadEngine !== "function" || typeof c.defaultUsersInfo !== "function") process.exit(2); console.log(m.toolsVersion);`], { encoding: "utf8" });
if (coreSmoke.status !== 0 || coreSmoke.stdout.trim() !== meta.toolsVersion) {
  console.error(`dist/core.mjs が読み込めない（exit ${coreSmoke.status}）:\n${coreSmoke.stderr}`);
  process.exit(1);
}
const coreSize = readFileSync(path.join(root, "dist", "core.mjs")).length;
console.log(`wrote dist/core.mjs (${coreSize.toLocaleString()} bytes; ${coreInputs.length} inputs) と dist/types/（型）`);
