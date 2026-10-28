# samples

- `settings-source.json`: 設定ファイルの雛形（封筒 + 元の値だけ。テーブル内集計のアプリ 2305 の例。小計の行で LASTIF / SUMIF を使う）。`normalize samples/settings-source.json --fields samples/fields-2305.json --check` が通る
- `fields-2305.json`: その項目定義（`fields --app 2305` の出力と同じ形）
- `users.json`: ユーザー情報のテストデータ（`--users` の形。既定のテストデータと同じ内容。`tools/scripts/gen-docs.mjs` が作る）
- `項目検証/fields-sample.json`: 項目検証の資料の例に使うサンプルアプリ（経費申請（架空）。`fields` の出力と同じ形。手で書いたもの）
- `項目検証/settings-source.json`: 項目検証の設定の雛形（封筒 + 元の値。docs/項目検証/検証パターン.md の重ならないパターンを合わせたもの。`tools/scripts/gen-fv-docs.mjs` が作る）。`fv normalize samples/項目検証/settings-source.json --fields samples/項目検証/fields-sample.json --check` が通る
