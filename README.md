# formula-authoring

rex0220 計算式プラグイン（kintone）の設定を AI（Claude Code）で作る・確かめるためのテンプレートと tools。
print-craft-authoring と同じ作りで、計算式のコード（計算式エンジン、authoring API）は利用者の計算式プラグインの zip（Ver.101 以降）から読む。tools は kintone に書かない。

**状態（2026-10-17）**: 工程 0（`formula/doc/internal/オーサリングツール_実装計画.md` 9 章）。`version` と `users --summary` だけ動く。
fields / record / users --pull / pull / normalize / calc / diff / summary と、テンプレートの文書は工程 1〜3 で足す。

## tools（`tools/`）

```
cd tools && npm install && npm run build && npm test
FORMULA_PLUGIN_ZIP=/path/to/formula-plugin101.zip node dist/cli.mjs version
node dist/cli.mjs users --summary --user authoring
```

- `src/engine.ts`: zip から計算式エンジンと authoring API を読んで Node で動かす（v101 固定のアダプター）。ダミー層（ログインユーザー / アプリ番号 / mobile / ルックアップ先 / URL / ユーザー情報）を 1 か所で持つ
- `src/users/`: ユーザー情報の既定のテストデータ（架空の 10 人、組織 4、グループ 2、カスタマイズ項目 `boss`）と `--users <file>` の読み込み
- `src/meta.ts`: 扱うプラグイン ID（PUBKEY から）、版の下限 101、API の版 1、tools が使う API の契約
- `pending/`: print-craft-authoring から写して、まだ計算式用に直していないもの（ビルドに入らない）

## 文書

- 計画: `formula/doc/internal/オーサリングツール_実装計画.md`（13 章 + Codex レビューへの対応）
- print-craft の同じもの: `print-craft-authoring`（README、CLAUDE.md、docs/）

## ライセンス

MIT（`LICENSE`）。tools は計算式プラグインのコードを含まない。
