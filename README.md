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
| `users --summary` / `users --pull` | ユーザー情報のテストデータの要約 / User API から取る（個人情報。パスワード認証だけ） |

## 構成

- `CLAUDE.md`、`docs/AI作業手順.md`: AI の手順と規則
- `docs/設定ファイル仕様.md`、`docs/関数一覧.md`、`docs/functions.json`、`docs/schema-manifest.json`、`docs/既定のテストデータ.md`、`samples/users.json`: zip から機械生成（`tools/` で `npm run gen-docs`。`test/docs-sync.test.mjs` が一致を確かめる）
- `samples/`: 雛形（`settings-source.json`、`fields-2305.json`）
- `policy/`: 利用者が書く承認（副作用のある関数、各種設定の変更）
- `tools/`: CLI（`src/`。print-craft-authoring/tools の写しから。`pending/` は未対応の部分）
- `.claude/settings.json`: kintone MCP の書き込みツールと `.env` / `policy/` / `users/` を拒否

## 開発

```
cd tools && npm install && npm run build && npm test
FORMULA_PLUGIN_ZIP=/path/to/formula-plugin101.zip node dist/cli.mjs version
```

計画と記録: `formula/doc/internal/オーサリングツール_実装計画.md`。

## ライセンス

MIT（`LICENSE`）。tools は計算式プラグインのコードを含まない。
