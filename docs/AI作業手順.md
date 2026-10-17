# AI の作業手順（tools の CLI で作業するとき）

このテンプレートで、**要件から kintone プラグイン「計算式プラグイン（rex0220 formula）Ver.101 以降」の設定 JSON を AI が生成・変更する**ときの手順です。[CLAUDE.md](../CLAUDE.md) の指示で AI がこの文書を読みます。
コマンドは `npx @rex0220/formula-authoring-tools <command>`（tools。kintone には GET しか送らない。1 回に 1 つ実行する）。

## 読むもの（要るところだけ。全部を順に読まない）

| 知りたいこと | 読むもの |
| --- | --- |
| 設定ファイルの形（封筒、キー、既定値、書かないキー） | [docs/設定ファイル仕様.md](設定ファイル仕様.md)（機械生成。短い） |
| 雛形 | [samples/settings-source.json](../samples/settings-source.json)（テーブル内集計の例。封筒 + 元の値だけ）。項目は [samples/fields-2305.json](../samples/fields-2305.json) |
| 関数の引数と説明、使用例 | [docs/関数一覧.md](関数一覧.md) を関数名で検索（250 関数。表の後に使用例）。印（副作用 / 文脈 / ユーザー情報 / イベント / 再計算で変わる）を見る |
| ユーザー情報の既定のテストデータ | [docs/既定のテストデータ.md](既定のテストデータ.md) |
| 項目定義・レコード・既存の設定 | 下の要約コマンド（`fields/` `records/` `settings/` の JSON を丸ごと読まない） |

## 要約コマンド（通信しない）

| コマンド | 出すもの |
| --- | --- |
| `npx @rex0220/formula-authoring-tools fields --app N --summary` | `fields/N.json` を 1 項目 1 行で（レイアウトの順。○ = 計算式を設定できる型、選択肢、ルックアップ、テーブルの子、一覧の数） |
| `npx @rex0220/formula-authoring-tools record --app N --id R --summary` | `records/N-R.json` の形（文字数・桁・テーブルの行数。値は出さない） |
| `npx @rex0220/formula-authoring-tools summary settings/<ファイル>.json` | 設定の要約（項目数、各種設定の既定との差、ボタン、一覧、権限、ランク順の計算式。80 字で切る） |
| `npx @rex0220/formula-authoring-tools summary settings/<ファイル>.json --field <code>` | 1 項目の計算式の全文 |
| `npx @rex0220/formula-authoring-tools diff <before>.json <after>.json` | 項目単位の差（★ = 既存レコードの値に影響する項目） |
| `npx @rex0220/formula-authoring-tools users --summary [--users users/<f>.json]` | ユーザー情報のテストデータの要約（人数だけ。コードや名前は出さない） |

## 新しい設定を作る

要件は `requirements/` のファイル、またはチャットで受け取る。

1. **アプリ番号** — 要件に番号があればそれを使う。名前だけなら kintone MCP の `kintone-get-apps` に `name` と `limit` を付けて探す。**候補が複数あれば推測せず利用者に聞く**
2. **項目** — `fields --app N` → `fields --app N --summary`。計算式には**ラベルでなくフィールドコード**を書く。要件のラベルをどのコードに対応させたかを利用者に示す。似たラベルは**推測しない**。○ の無い型（CALC、ルックアップのコピー先など）には計算式を置けない
3. **レコード** — `records --app N` で数件の形を見て、代表の 1 件（テーブルが複数行、空の項目がある）を `record --app N --id R` で取る。設定を書いた後は `record --app N --id R --fields-from settings/<ファイル>.json --force` で使う項目だけに絞ってよい
4. **設定 JSON** — 雛形を写して**封筒**で `settings/APP<アプリ番号>-<アプリ名>.json` に書く（1 アプリ 1 ファイル）。`pluginID` は `"rex0220 formula plugin"`、`PluginVersion` は zip の版（`version` が出す）。`pluginInfos` に計算式を置く項目だけ書く（他は normalize が補う）。ランクは「参照する項目より後」になるように付ける（同じランクはレイアウトの順）
5. **normalize** — `normalize settings/<ファイル>.json`（`fields/N.json` は封筒の appId から決まる）。エラーを 0 にする（下の表）。**警告は消さずに利用者に伝える**。`--out settings/<ファイル>.json --force` で既定値を補った形に書き戻してよい
6. **calc** — `calc settings/<ファイル>.json --app N --id R`。項目ごとの前後を見て、要件どおりか確かめる。結果は模擬（レコードは更新しない）。ユーザー情報を使う式は既定のテストデータ（架空）の値、イベントで分岐する式は `--event` の文脈（既定は既存レコードを変更と同じ `allUpdate`）で計算される
7. **反映方法を伝える（4 段）** — アプリの設定 → プラグイン → 計算式プラグインの設定 → **設定をアップロード** → 取り込み方を選ぶ（設定がまだ無いアプリは「全置換」、既存の設定に項目を足すなら「項目の置換」で対象の項目をチェック）→ **保存する**（「運用環境に反映」をチェックするとアプリの更新まで行う）→ 以後に追加・編集するレコードは新しい設定で計算 → **既存のレコードは変わらない**ので、必要なら設定画面の「既存レコードを変更」か一覧の「一括計算」を利用者が実行する（★ の項目があるときは勧める）

## 既存の設定を変える

1. `pull --app N` で今の設定を `settings/APP<番号>-<アプリ名>.json` に取る（API ラボの機能が有効なとき。無理なら利用者に設定画面の「ダウンロード」を頼み `settings/` に置いてもらう）
2. `summary` で全体、`summary --field <code>` で直す項目の計算式を見る
3. pull / ダウンロードのファイルは書き換えず、写し `settings/APP<番号>-<アプリ名>-edit.json` を作って直す
4. `diff settings/<元>.json settings/<写し>.json` で差を確かめ、`normalize` と `calc`
5. 反映方法は上と同じ。取り込み方は「項目の置換」で、変えた項目だけチェックしてもらう（共通の設定を変えていなければ群のチェックは外す）

## normalize の結果

`[エラー]` が 1 つでもあると書き戻さず終了コード 1（calc もしない）。規則名は各行の末尾の（…）。

| エラー | 意味と直し方 |
| --- | --- |
| `schema.json` / `schema.rows` / `schema.unknown-key` | JSON として読めない、`pluginInfos` の形が違う、知らないキー（設定画面は黙って捨てるので書き間違いを見逃さないためにエラー）。設定ファイル仕様で確かめる |
| `envelope.plugin` / `envelope.version` / `envelope.app` | 封筒の誤り。`pluginID` は `"rex0220 formula plugin"`。`PluginVersion` が zip より新しい。`appId` が正の整数でない |
| `field.missing` | 今のアプリに無い項目（ラベルで書いた、綴りの違い、別アプリの項目、削除された項目） |
| `field.type` / `field.flag` | その型には計算式を置けない / HEADER・SPACER・GROUP に編集、HEADER・SPACER に非表示 |
| `rank.range` | ランクが整数か `""` でない |
| `formula.syntax` / `formula.unknown-function` / `formula.ref` | 評価できない（エンジンの文言を読む）/ 無い関数（関数一覧で名前を確かめる）/ 今のアプリに無い項目を参照 |
| `formula.circular` | 自己参照か 2 項目の相互参照（各種設定 `circular_refer` が OFF のとき） |
| `formula.side-effect` | 副作用のある関数（FSET / FSET_TADD / BUTTON / DIALOG / CLIPBORD_WRITE）。tools は評価しない。要るなら利用者に policy の `allowFunctions` を頼む（AI は書かない） |
| `event.set` | EV_SET（テスト用）が設定に残っている |
| `userinfo.off` | 各種設定「ユーザー情報」が OFF なのに UINFO 系を使う |
| `views.missing` | 一覧別設定に今のアプリに無い一覧 ID |
| `schema.saved` / `size.limit` | 保存値がスキーマに合わない / 大きすぎる（256 KB） |

| 警告（消さずに利用者に伝える） | 意味 |
| --- | --- |
| `misc.changed` / `authority.limited` / `plugin.disabled` | 各種設定が既定と違う（利用者が決めること）/ 権限が全員でない / プラグイン無効 |
| `field.lookup` / `field.subtable` / `field.disabled` | ルックアップ項目に計算式（値を上書きする）/ テーブル自身の計算式は行数の制御 / 計算式があるが無効 |
| `formula.context` | kintone の文脈が要る関数（LOGIN_* / LOOKUP_GETID / APP_URL …）。calc はダミー層の値 |
| `formula.volatile` | RAND / NOW / TODAY / UUID など再計算のたびに値が変わる。既存レコードを変更で毎回変わる。固定するなら `NVL(項目, UUID())` |
| `formula.aggregate` | テーブル内の項目でテーブルの集計関数（行ごとに全体を集計する。小計の行などで意図したものか） |
| `event.fcode` | `EV_INFO("fcode")` は値変更イベントでしか入らない |
| `userinfo.unknown` | 使うテストデータに無いユーザー・組織・グループのコードらしき文字列（実データで確かめるなら利用者に `users --pull` を頼む） |
| `envelope.app` | appId が fields のアプリと違う |

`[情報]`（Ver.100 の設定、捨てるキー、内部番号は設定画面が補う、保存値の大きさ、イベントで結果が変わる項目、ユーザー情報を使う項目、項目でない識別子、3 項目以上の循環）は要るときだけ伝える。

## 計算式の制約（守らないと動かない・壊れる）

- **封筒なし（素の設定だけ）の JSON は誤り。** `pluginID` / `PluginVersion` が違うと取り込めない
- 計算式には**フィールドコード**を書く（ラベルではない）。テーブルの子の項目はテーブルの中の式ではそのまま、テーブルの外の式では集計関数（SUM(テーブルの子) など）で参照する
- `//` から行末まではコメント。**文字列の中の `//` も行末までコメントになる**（`"https://…"` を書かない）。改行は実行時に無視される（見やすさのために入れてよい）
- 文字列は `"…"`。`\n` は改行にならない（`\` を解釈しない）
- 計算の順は**ランク**（小さい順。同じなら上から）。参照する項目より後のランクにする。設定画面は自己参照と 2 項目の相互参照を止める（`circular_refer` が OFF）
- テーブル自身に計算式を置くと**行数の制御**（行数 | 初期データ）になる。テーブルの子に置くと行ごとに計算する
- 副作用のある関数は BUTTON / DIALOG の中で使う。tools は policy の承認が無ければ評価しない
- イベントで結果が変わる式（`EV_INFO("type")` など）は、どのイベントでどの値になるかを表にして利用者に示す。「既存レコードを変更」は `allUpdate`、一覧の「一括計算」は `batch` のイベントで動く（画面の入力時と同じにならない）
- 一覧 ID、権限のコード、ルックアップ先のアプリ番号は推測しない
- 内部番号（fieldno / tableno）は設定画面が保存時に補う。tools の出力には無い（正しい）

## 使えるもの（積極的に使ってよい）

- `LET(x, 式, …, 式)` で変数。`FSET(x, 値)` で LET の変数の値を変えられる（ループで積み上げる: `LET(s, "", t, ARRAY_FOR(3, i, FSET(s, s & i)), s)`）
- `REPLACEALL(項目, ARRAY(p1, r1, p2, r2, …))` / `REPLACERE(項目, ARRAY(…), "g")` で置換の組を配列で（入れ子を平らに）
- 条件付き集計 `SUMIF` / `COUNTIF` / `LASTIF` / `FIRSTIF`、テーブルの行番号 `ROWNO(テーブル)`、空の既定 `NVL`
- ユーザー情報 `UINFO(LOGIN_CODE(), "#boss")`（カスタマイズ項目は `#コード`）、`OUSERS(組織)`、`GUSERS(グループ)`（各種設定「ユーザー情報」が ON のとき）
- 関数の説明と使用例は関数一覧で名前を検索する

## このリポジトリのルール

- 封筒で出力する。`settings/` は固定名で上書きし、履歴は git で追う
- **kintone への書き込みは行わない。** tools は GET だけ、`calc` は模擬
- `records/` と `users/`（実データ）はコミットしない。作業が終わったら消してよい
- 認証情報（`.env`）をファイルやチャットに書かない。`policy/` と `.env` を AI が編集しない
- tools は `.env` の `FORMULA_PLUGIN_ZIP`（計算式プラグインの zip。Ver.101 以降）から計算式エンジンと authoring API を読む。「zip の場所が分からない」「版 … には対応していない」「計算式プラグインの zip ではない」と出たら、利用者に zip の場所と版（アプリに入れたものと同じ。配布元から入手したもの）を確かめてもらう
- tools が読むファイルは作業フォルダーの中、書く先は `fields/` `records/` `settings/` `temp/` `users/` の下だけ
