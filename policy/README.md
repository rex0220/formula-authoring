# policy/ — 利用者の承認（外部参照の「許可」、外部 URL）

`pcraft-authoring normalize` が利用者の判断を求めるものを、**利用者が**この `authoring-policy.json` に書きます。AI はこのフォルダーを編集しません（`.claude/settings.json` で拒否してあります。AI が自分でエラーや警告を消せないようにするためです）。

```json
{
  "allowExternal": [
    { "origin": "https://cdn.example.com", "files": ["settings/見積書.json"], "note": "社印の画像" },
    { "url": "https://example.com/logo.png" }
  ],
  "allowExternalRefs": ["settings/見積書.json"]
}
```

## allowExternalRefs — 外部参照を「許可」にしてよい設定ファイル

印刷屋プラグイン Ver.6 は、帳票の HTML / CSS から kintone 以外への読み込み（画像・CSS・iframe・リンク）とスクリプトを描画の前に除きます（共通の設定「外部参照」= 設定 JSON の `externalRefs: "block"`。新しい設定の既定）。`"allow"` にすると Ver.5 と同じく何も除きません（自己責任）。Ver.5 で保存した設定（`externalRefs` が無い）も印刷屋は「許可」として動かします。

`normalize` は `"allow"` の設定ファイル（キーが無いものを含む）を、ここに相対パスが書いてなければ**エラー**にします。既存の設定を「許可」のまま使う、または外部の画像をどうしても使うと決めたときだけ書いてください。

## allowExternal — 外部 URL の承認

- 効くのは Web フォント（`fontInfo.cssUrl`。印刷屋は除きません）と、`allowExternalRefs` に書いた「許可」の設定の HTML / CSS の URL です。`"block"` の設定の外部 URL は承認しても帳票に出ないので、`normalize` はエラーにします（添付ファイルの `#{&f(…)}` か `data:image/` に直す）
- `origin` はそのオリジン（`https://host`）の全部、`url` はその URL だけを許す
- `files` を書くと、その設定ファイル（リポジトリからの相対パス）に限る。無ければ全部の設定
- Google Fonts（`fonts.googleapis.com` / `fonts.gstatic.com`）は書かなくても承認済み
- 承認した URL は `normalize` が情報として出し、無ければ警告（警告は書き戻しを止めません）
- 外部の URL は kintone の画面と PDF の作成時に読み込まれます。接続先が信頼できるか、利用者の環境から届くか（China 版など）を確かめてください
