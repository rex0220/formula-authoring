# formula authoring tools（開発メモ）

計算式プラグイン（rex0220 formula）の設定 JSON を AI で作る・確かめるための tools。npm パッケージ `@rex0220/formula-authoring-tools`（MIT。版は計算式プラグインの版と独立。扱う計算式プラグインはプラグイン ID と版の下限（Ver.101 以降）で決まり、`version` コマンドが出す）のソース。リポジトリのルートがテンプレート（利用者が "Use this template" で使う側）。計画と決定は formula（非公開）の `doc/internal/オーサリングツール_実装計画.md`。

**tools は計算式プラグインのコードを含まない。** 計算式エンジン（`desktop_js/KintoneFormula.min.js`）と計算式プラグインの設定画面のコード + plugin-config-kit（`config_js/formula-authoring-api.js`。Ver.101 から zip に同梱。formula の `src/authoring/api.ts`）は、利用者の zip（`.env` の `FORMULA_PLUGIN_ZIP`）から実行のたびにメモリに読む（`src/plugin-zip.ts`、`src/engine.ts`）。zip の `PUBKEY` から出るプラグイン ID が計算式プラグインのもの（`src/meta.ts` の `FORMULA_PLUGIN_ID`）でなければ実行せずに止まる（fail closed。`SIGNATURE` は検証しない。`SECURITY.md`）。開発中にソースから動かすとき（`node src/cli.ts …`）だけ、環境変数 `FORMULA_ALLOW_DEV_PLUGIN=1` を置けば隣の formula の `prod/` からも読める（この場合はプラグイン ID を確かめず、警告を出して続く。ビルドした `dist/cli.mjs` では読まない）。ビルド（`scripts/build.mjs`）は bundle に計算式プラグイン / kit のコードが入っていないことを確かめて止まる。

**ビルドとテストには、隣に計算式プラグインのリポジトリ（非公開）と plugin-config-kit / rexgrid が要る**（`package.json` の devDependencies が `file:` で参照する。型の import と、テストの fixture の zip `formula/dist/formula-plugin101.zip` のため。公開レジストリの tools を使うだけなら要らない）。

```
Projects/
  plugin-config-kit/
  rexgrid/
  kintone-plugin/
    formula/                  ← 型を import。テストは dist/formula-plugin101.zip を利用者の zip の代わりに読む
    formula-authoring/        ← このリポジトリ（ルート = テンプレート、tools/ = パッケージ）
```

## 構成

- `src/cli.ts` … `formula-authoring <command>`（version / fields / record / records / pull / summary / diff / users / normalize / calc、接続のファイルがあるときの take / edit / files）。読むのは cwd の中、書くのは fields/ records/ settings/ temp/ users/ kintone/ の下だけ（`src/safe-path.ts`。kintone/ の下は `src/permission.ts` の許可も）。`.env` / policy / zip / 接続のファイルの場所は固定
- `src/plugin-zip.ts` … 計算式プラグインの zip（contents.zip の 2 層）を Node の zlib だけで読む。大きさ・entry 数・展開後の上限、CRC-32、名前の一致、重複を検査
- `src/engine.ts` … zip のエンジン（`KintoneFormula.min.js` → `bignumber` → `rex0220_decimal` → `moment-timezone` → `formula-authoring-api.js` の順）と authoring API を happy-dom + ダミー層（ログインユーザー、アプリ番号、ルックアップ先、ユーザー情報、sink の記録）で動かす。照合（プラグイン ID、版、API の版、API のキーと型）。走査の間は `dq`（評価）を遮断する（`blockDq`）
- `src/scan.ts` … 計算式の字面の走査（関数、識別子、文字列と、それを引数に持つ関数）。評価しない
- `src/commands/normalize.ts` … 設定画面と同じ手順の検査（生の JSON の未知のキー → normalizeSource → 走査（副作用 / 文脈 / イベント / ユーザー情報）→ checkFormula / deriveSemantic → 循環 → 大きさ）と既定値を補った封筒。`src/normalize/` … 規則（findings）、policy、型、差分
- `src/commands/calc.ts` … 取得したレコードに設定を当てる模擬（authoring API の `calcRecord`。イベント、ログインユーザー、ユーザー情報、文脈の fail-closed、sink の拒否）。`src/worker/` … 評価を Worker で動かし時間上限で止める
- `src/users/` … ユーザー情報のテストデータ（既定の架空の 10 人）と `users/*.json` の形。`src/commands/users.ts` … User API からの取得（全部 / `--only-referenced` = 式が参照するコードとその所属だけ）
- `src/connections.ts` / `src/workspace.ts` / `src/permission.ts` / `src/commit-file.ts` … kintone の接続のファイル（kSQL の `ksql.config.json` と同じ形。profile、`tokenMap`、`userApiToken`）、`kintone/<profile>/<番号>-<アプリ名>/` のフォルダーと印 `.formula-app.json`、kintone/ の下を変える許可、ファイルの確定とロック（print-craft-authoring tools 2.0.0 の写し）
- `src/env.ts` / `src/kintone-rest.ts` / `src/kintone-url.ts` … `.env`（kintone 公式 MCP と同じ `KINTONE_*` + `FORMULA_PLUGIN_ZIP` / `FORMULA_KINTONE_CONFIG` / `FORMULA_USER_API_TOKEN`）、GET 専用・許可 API 固定・送信先固定の REST（kintone REST API と User API）
- `src/meta.ts` … tools の版、扱う計算式プラグイン（プラグイン ID `FORMULA_PLUGIN_ID`、封筒の `FORMULA_CONFIG_PLUGIN_ID`、版の下限 `MIN_PLUGIN_VERSION`）、API の版（`SUPPORTED_API_VERSIONS`）、API の契約（`REQUIRED_API`）
- `src/core.ts` … 共通の中核の入口（npm の `@rex0220/formula-authoring-tools/core`。MCP が使う予定）。`scripts/build.mjs` が `dist/core.mjs` と `dist/types/` を作る
- `scripts/vendor.mjs` … moment 2.24.0 を CDN から `vendor/` に取る（`vendor/moment.json` の SHA-256 と照合）。`scripts/build.mjs` … esbuild で `dist/cli.mjs` / `dist/eval-worker.mjs` / `dist/core.mjs`。`scripts/gen-docs.mjs` … `docs/`（設定ファイル仕様、関数一覧、functions.json、schema-manifest、既定のテストデータ）と `samples/users.json` を zip から機械生成
- `pending/` … print-craft から写してまだ計算式用にしていないもの（`save.ts` = MCP の保存の約束）。npm には入らない
- `test/` … `node --test`（src の .ts を直接読む。`test/helpers.mjs` が fixture の zip を読む。`test/fixtures/formula/` はテスト用アプリ 2305 の項目定義と設定）

## 使い方（開発）

公開パッケージの実行は Node 20 以上。**ビルドとテストは Node 22.6 以上**（型の除去で `.ts` を直接読む）。

```
cd tools
npm install         # happy-dom、esbuild、typescript と、隣の formula / plugin-config-kit / rexgrid への参照
npm run vendor      # 初回。moment を vendor/ に
npm test
npm run check       # tsc
npm run build       # dist/cli.mjs、dist/eval-worker.mjs、dist/core.mjs（prepack でも走る）
FORMULA_PLUGIN_ZIP=../../formula/dist/formula-plugin101.zip node dist/cli.mjs version
npm run gen-docs    # zip から docs/ を作り直す（test/docs-sync.test.mjs が一致を確かめる）
npm pack --dry-run  # 公開前に中身を確かめる（dist、vendor、LICENSE、THIRD_PARTY_NOTICES、SECURITY、README だけ）
```

## 決まり

- 計算式プラグインの関数は `engine.api`（zip の authoring API）経由で使う。`src/` から formula を import するのは **型だけ**（`import type`）。実行コードを import すると build が止まる
- 計算式プラグインの `AUTHORING_API_VERSION` が上がったら、tools の `SUPPORTED_API_VERSIONS` に足し（古い版は利用者が残っている間は外さない）、`REQUIRED_API` を合わせて tools の新しい版として公開する。zip の中身が変わっただけ・版を上げただけなら tools の公開は要らない（プラグイン ID で読む）。tools の版は計算式プラグインの版と独立（semver）
- kintone への書き込みは行わない。HTTP 層は GET 専用で、送れるパスと送信先を固定する
- CLI に `.env` / policy / zip / 接続のファイルの場所を変えるオプションを足さない（AI が書けるファイルを読ませない）。書き込み先を増やすなら `src/safe-path.ts` の `WRITE_ROOTS`
- `vendor/*.js`、`dist/`、`node_modules/` はコミットしない

## 履歴

- 0.1.0（2026-10）: 最初の公開。version / fields / record / records / pull / summary / diff / users / normalize / calc / take / edit / files。扱う計算式プラグイン Ver.101 以降、authoring API 1
