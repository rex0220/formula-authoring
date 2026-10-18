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

- `src/cli.ts` … `formula-authoring <command>`（version / fields / record / records / pull / summary / diff / users / normalize / calc / try、接続のファイルがあるときの take / edit / files）。読むのは cwd の中、書くのは fields/ records/ settings/ temp/ users/ kintone/ の下だけ（`src/safe-path.ts`。kintone/ の下は `src/permission.ts` の許可も）。`.env` / policy / zip / 接続のファイルの場所は固定
- `src/plugin-zip.ts` … 計算式プラグインの zip（contents.zip の 2 層）を Node の zlib だけで読む。大きさ・entry 数・展開後の上限、CRC-32、名前の一致、重複を検査
- `src/engine.ts` … zip のエンジン（`KintoneFormula.min.js` → `bignumber` → `rex0220_decimal` → `moment-timezone` → `formula-authoring-api.js` の順）と authoring API を happy-dom + ダミー層（ログインユーザー、アプリ番号、ルックアップ先、ユーザー情報、sink の記録）で動かす。照合（プラグイン ID、版、API の版、API のキーと型）。走査の間は `dq`（評価）を遮断する（`blockDq`）
- `src/scan.ts` … 計算式の字面の走査（関数、識別子、文字列と、それを引数に持つ関数）。評価しない
- `src/commands/normalize.ts` … 設定画面と同じ手順の検査（生の JSON の未知のキー → normalizeSource → 走査（副作用 / 文脈 / イベント / ユーザー情報）→ checkFormula / deriveSemantic → 循環 → 大きさ）と既定値を補った封筒。`src/normalize/` … 規則（findings）、policy、型、差分
- `src/commands/calc.ts` … 取得したレコードに設定を当てる模擬（authoring API の `calcRecord`。イベント、ログインユーザー、ユーザー情報、文脈の fail-closed、sink の拒否）。`src/worker/` … 評価を Worker で動かし時間上限で止める
- `src/commands/try.ts` / `src/commands/try-data.ts` / `src/sample-app.ts` … 式の試し計算（`try`。formula MCP の `fml_try`）。`try-data.ts` は架空の項目（標本に足す）と簡略形の値（kintone の形に変換・検査）。同梱のサンプルアプリ（`src/sample-app/`。全項目タイプ × 2、テーブル 2 つ、レコード 3 件 = 典型 / 端 / 空。実在の値は無い。`scripts/gen-sample-app.mjs` で取り直す）に式ごとに 1 行だけの設定を組み、normalize → calc で値（型に入れた後の値と、エンジンの生の値）を返す。利用者のアプリ・レコード・接続は使わない
- `src/users/` … ユーザー情報のテストデータ（既定の架空の 10 人）と `users/*.json` の形。`src/commands/users.ts` … User API からの取得（全部 / `--only-referenced` = 式が参照するコードとその所属だけ）
- `src/connections.ts` / `src/workspace.ts` / `src/permission.ts` / `src/commit-file.ts` … kintone の接続のファイル（kSQL の `ksql.config.json` と同じ形。profile、`tokenMap`、`userApiToken`）、`kintone/<profile>/<番号>-<アプリ名>/` のフォルダーと印 `.formula-app.json`、kintone/ の下を変える許可、ファイルの確定とロック（print-craft-authoring tools 2.0.0 の写し）
- `src/env.ts` / `src/kintone-rest.ts` / `src/kintone-url.ts` … `.env`（kintone 公式 MCP と同じ `KINTONE_*` + `FORMULA_PLUGIN_ZIP` / `FORMULA_KINTONE_CONFIG` / `FORMULA_USER_API_TOKEN`）、GET 専用・許可 API 固定・送信先固定の REST（kintone REST API と User API）
- `src/meta.ts` … tools の版、扱う計算式プラグイン（プラグイン ID `FORMULA_PLUGIN_ID`、封筒の `FORMULA_CONFIG_PLUGIN_ID`、版の下限 `MIN_PLUGIN_VERSION`）、API の版（`SUPPORTED_API_VERSIONS`）、API の契約（`REQUIRED_API`）
- `src/commands/save.ts` … 保存の約束（formula MCP の `fml_save_settings` / `fml_update_fields` の本体。CLI は使わない）。新しい設定は同じ名前があれば保存しない、既存の設定は `fml_summary` の digest を照合して項目の行（`fieldcode`）を複数まとめて差し替える。normalize は Worker で行い、エラーがあれば確定しない。確定はロック付き（`commit-file.ts`）
- `src/core.ts` … 共通の中核の入口（npm の `@rex0220/formula-authoring-tools/core`。formula MCP が使う。`CORE_API_VERSION` 2）。`scripts/build.mjs` が `dist/core.mjs` と `dist/types/` を作る。MCP が使う名前は `test/core-exports.test.mjs` で固定する
- `scripts/vendor.mjs` … moment 2.24.0 を CDN から `vendor/` に取る（`vendor/moment.json` の SHA-256 と照合）。`scripts/build.mjs` … esbuild で `dist/cli.mjs` / `dist/eval-worker.mjs` / `dist/core.mjs`。`scripts/gen-docs.mjs` … `docs/`（設定ファイル仕様、関数一覧、functions.json、schema-manifest、既定のテストデータ）と `samples/users.json` を zip から機械生成。`scripts/verify-patterns.mjs` + `scripts/pattern-cases.mjs` … 計算パターン集の例を同梱のサンプルアプリと架空の値で `try` に評価させ、関数一覧の使用例も評価して `docs/計算パターン_検証.md` を作る（`test/docs-sync.test.mjs` が最新と全部一致を確かめる = エンジンの版が変わったときの回帰検査）
- `pending/` … print-craft から写してまだ計算式用にしていないもの（`diff.ts` / `normalize.ts` は計算式用の `src/commands/` が別にあるので使っていない）。npm には入らない
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

- 0.3.1（2026-10）: normalize がスペース項目（要素 ID のある SPACER）とヘッダーの行の計算式を `field.type` で誤って止めていたのを直した（設定画面は許す）。`try` でスペース項目を対象にできる（`--as sp1` / `SPACER`。標本に `sp1` を足した。レコードに値が無いので式の返り値をそのまま返す）
- 0.3.0（2026-10）: 計算パターン集の例の検証（`docs/計算パターン_検証.md`。gen-docs）。式の試し計算 `try`（計画 25 章。formula MCP 0.2.0 の `fml_try`）。同梱のサンプルアプリ（`src/sample-app/`）に 1 行だけの設定を組んで normalize → calc。架空の項目と値（`src/commands/try-data.ts`: `--fields` で標本に項目を足す、`--data` で簡略形の値のレコード、`--app` で利用者のアプリの項目定義に架空の値）。`core` に `trySettings` / `SAMPLE_APP` / `describeSampleApp`、評価の仕事の kind `try`（`EvalJob` の `settingsText` / `settingsFile` / `fields` は try では省略できる）、`calcSettings` の `allowDefaultBaseUrl`。`CORE_API_VERSION` は 2 のまま（足しただけ）
- 0.2.1（2026-10）: formula MCP の Codex レビューへの対応。`updateFields` の `common` を共通の設定のキー（`COMMON_KEYS`）だけに。Worker の中の誤りの種類（`EvalError.kind`）と名前を中核が instanceof で決める（zip のコードの例外の name / constructor.name / 文を応答や標準エラーに出さない。`classifyEvalError` / `builtinErrorName`）。保存の結果の想定外の誤りも種類だけ（`zipCode`）。CLI の想定外の誤りは種類だけ（`FORMULA_DEBUG=1` で文とスタック）。接続の誤りの文の print-craft の名残を直した
- 0.2.0（2026-10）: formula MCP のための中核の入口（`CORE_API_VERSION` 2。CLI の動きは変えない）。`core` に workspace / connections / permission / commit-file / take / users の参照コード / JSON の誤りの文 / 行のキーを追加。`src/commands/save.ts`（`saveNewSettings` / `updateFields`）。`runEval` の `workerFile`（Worker の入口の絶対パス）と `captureOutput`（Worker の標準出力・標準エラーを親に流さず受け取る）、`loadEngine` の `vendorDir`（moment の置き場所）。評価の結果に `findings` と calc のレコードごとの行
- 0.1.0（2026-10）: 最初の公開。version / fields / record / records / pull / summary / diff / users / normalize / calc / take / edit / files。扱う計算式プラグイン Ver.101 以降、authoring API 1
