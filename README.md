# formula-authoring

rex0220 計算式プラグイン（kintone）Ver.101 以降の設定 JSON を、AI（Claude Code）で作る・確かめるためのテンプレートと tools。
print-craft-authoring と同じ作りで、計算式のコード（計算式エンジン、authoring API）は利用者の計算式プラグインの zip から読む。**tools は kintone に書かない**。
`calc` は「この設定ならこのレコードはこう計算される」を見せる模擬で、レコードは更新しない。保存しても既存のレコードは変わらない（反映の 4 段は `docs/AI作業手順.md`）。

**状態（2026-10-17）**: 工程 3（`formula/doc/internal/オーサリングツール_実装計画.md` 9 章）まで。tools は未公開（npm に出していない）。試用（工程 4）→ Codex レビュー（工程 5）→ 公開（工程 6）の前。

## 使い方（利用者）

1. このリポジトリを clone する（公開後はテンプレートから作る）
2. `tools/` で `npm ci && npm run build`（公開後はルートで `npm ci` だけ）
3. `.env.example` を `.env` に写し、`KINTONE_BASE_URL`、認証（`KINTONE_API_TOKEN` か `KINTONE_USERNAME` + `KINTONE_PASSWORD`）、`FORMULA_PLUGIN_ZIP`（計算式プラグインの zip。アプリに入れたものと同じ版）を書く
4. `node tools/dist/cli.mjs version`（公開後は `npx @rex0220/formula-authoring-tools version`）で zip が読めることを確かめる
5. Claude Code を開き、要件（アプリ番号、どの項目をどう計算するか）を伝える。AI は `CLAUDE.md` → `docs/AI作業手順.md` の順で作業する
6. できた `settings/APP<番号>-<アプリ名>.json` を、プラグインの設定画面で **設定をアップロード → 取り込み方を選ぶ → 保存する → 運用環境に反映**。既存のレコードに反映するなら「既存レコードを変更」か一覧の「一括計算」

## tools のコマンド

| コマンド | 内容 |
| --- | --- |
| `version` | tools の版と、zip から読んだプラグインの版・API の版・エンジンの SHA-256 |
| `fields --app N [--preview]` / `--summary` | 項目定義・レイアウト・一覧 / 1 項目 1 行（○ = 計算式を設定できる型） |
| `record --app N --id R [--fields-from <設定>]` / `--summary` | 1 レコード / 形だけ |
| `records --app N [--query …]` | 数件の形だけ |
| `pull --app N [--preview]` | アプリに入っている設定を設定画面のダウンロードと同じ形で |
| `summary <設定> [--field <code>]` | 設定の要約 / 1 項目の計算式の全文 |
| `diff <before> <after>` | 項目単位の差（★ = 既存レコードの値に影響） |
| `normalize <設定> [--fields f] [--users f] [--out f] [--check]` | 設定画面と同じ手順で検査し、既定値を補った設定を書き出す |
| `calc <設定> --app N --id R [--event …] [--user …] [--users f] [--mobile]` | 取得済みのレコードに設定を当てた模擬（更新しない） |
| `users --summary` / `users --pull [--only-referenced <設定>]` | ユーザー情報のテストデータの要約 / User API から取る（個人情報。cybozu.com 共通管理の API トークンかパスワード認証）。`--only-referenced` は設定の式が文字列で参照するコードとその所属だけ |
| `take [--profile <名前>]` | `inbox/` の設定のダウンロードを、アプリのフォルダーへ名前のまま移す（接続のファイルがあるとき） |
| `edit --app N` | 今の設定（一番新しいダウンロード / pull）を `…-edit.json` に写す。直すのはこちら（接続のファイルがあるとき） |
| `files --app N` | アプリのフォルダーのファイル（今の設定、直したもの、その他の設定、records）（接続のファイルがあるとき） |

## 複数のドメイン・アプリ（任意。接続のファイル）

開発用の環境（ドメイン）や開発用のアプリ、いくつかのアプリを使うときは、kintone の**接続のファイル**（kSQL の `ksql.config.json` と同じ形）を使います。無ければ `.env` の 1 接続の形（`settings/` `fields/` `records/`）のままです。

1. `kintone-connections.example.json` を写して、**作業フォルダーの外**に接続のファイルを作ります（例 `~/kintone-connections.json`）。kSQL を使っていれば、その `ksql.config.json` をそのまま使えます
   - `profiles` に接続先を名前（英数字と `-` `_`）で並べ、`baseUrl`（`https://<サブドメイン>.cybozu.com`）と認証を書きます。認証は、アプリごとの API トークン（`tokenMap` の `APP<番号>`。値は `env:<環境変数の名前>` か、トークンそのもの）か、ログイン名とパスワード（`username` と、`passwordEnv` か `password`）。ゲストスペースは `guestSpaceId`（1 つの profile は 1 つのスペース）
   - `users --pull`（User API）は、profile の `userApiToken`（cybozu.com 共通管理の API トークン。`env:<環境変数の名前>` か値。計算式の tools だけが読むキーで、kSQL は無視します）か、ログイン名とパスワードを使います。アプリの API トークンでは呼べません
   - `defaultProfile` に、ふだん使う profile を書きます（無ければ `dev`。kSQL と同じ）
   - **レコード閲覧だけの API トークン**を勧めます。トークンをファイルに直接書くときは、ほかの利用者に読めないようにします（`chmod 600`）
2. 作業フォルダーの `.env` に `FORMULA_KINTONE_CONFIG=<接続のファイルのパス>` を書きます（絶対パスか、`.env` のフォルダーからの相対パス）。OS の環境変数に置くときは絶対パスにします
3. 設定画面でダウンロードしたファイル（`rex0220-formula-app<番号>-<日時>.json`）は**名前を変えずに** `inbox/` に置きます。`npx @rex0220/formula-authoring-tools take` がアプリのフォルダーへ移します

```
kintone/
  dev/101-見積書/        fields.json、records/、ダウンロード / pull（名前のまま）、…-edit.json（直したもの）、.formula-app.json（印）
  prod/3740-見積書/
```

4. 作るのも直すのも開発のアプリ。開発のアプリにアップロードして確かめたら、**同じファイルを本番のアプリの設定画面でアップロード**します（取り込み方は「項目の置換」で変えた項目だけ。「別のアプリの設定です」の注意が出ますが取り込めます。項目が合わなければ保存のときに止まります）。**一覧 ID はアプリごとに違う**ので、一覧別設定は本番の設定画面で選び直します

コマンドは `--profile <名前>` で接続先を選びます（省略は `defaultProfile`）。`--app` は番号です。`--guest` と `--out` は使いません（ゲストスペースは profile、保存先はアプリのフォルダー）。`normalize` / `calc` にアプリのフォルダーの中のファイルを渡すと `--fields` は同じフォルダーの `fields.json`、`calc --id 3` は `records/3.json` です。ダウンロード / pull のファイルは書き換えません（`edit` で `-edit.json` に写して直す）。

## 構成

- `CLAUDE.md`、`docs/AI作業手順.md`: AI の手順と規則
- `docs/設定ファイル仕様.md`、`docs/関数一覧.md`、`docs/functions.json`、`docs/schema-manifest.json`、`docs/既定のテストデータ.md`、`samples/users.json`: zip から機械生成（`tools/` で `npm run gen-docs`。`test/docs-sync.test.mjs` が一致を確かめる）
- `samples/`: 雛形（`settings-source.json`、`fields-2305.json`）
- `policy/`: 利用者が書く承認（副作用のある関数、各種設定の変更）
- `tools/`: CLI（`src/`。print-craft-authoring/tools の写しから。`pending/` は未対応の部分）
- `kintone-connections.example.json`: 接続のファイルの見本（複数のドメイン・アプリ）
- `.claude/settings.json`: kintone MCP の書き込みツールと `.env` / `policy/` / `users/` / `records/` / `kintone/` の書き込みを拒否

## 開発

```
cd tools && npm install && npm run build && npm test
FORMULA_PLUGIN_ZIP=/path/to/formula-plugin101.zip node dist/cli.mjs version
```

計画と記録: `formula/doc/internal/オーサリングツール_実装計画.md`。

## ライセンス

MIT（`LICENSE`）。tools は計算式プラグインのコードを含まない。
