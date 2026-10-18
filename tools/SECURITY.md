# セキュリティ（@rex0220/formula-authoring-tools と formula-authoring テンプレート）

## 脆弱性の報告

- GitHub リポジトリ [rex0220/formula-authoring](https://github.com/rex0220/formula-authoring) の **Security → Report a vulnerability**（非公開の報告）で知らせてください。公開の Issue には書かないでください
- 報告には、tools の版（`npx @rex0220/formula-authoring-tools version`）、再現する設定 JSON（レコードの値と認証情報を除いたもの）、期待した動きを添えてください
- 対応するのは tools の最新の版です。修正は新しい版として npm と GitHub に出し、`tools/README.md` の履歴に書きます

## 範囲

| 対象 | 報告先 |
| :--- | :--- |
| tools（`formula-authoring` の version / fields / record / records / pull / summary / diff / users / normalize / calc / take / edit / files）、テンプレート（CLAUDE.md、`.claude/settings.json`、`.mcp.json`、docs） | このリポジトリ |
| 計算式プラグイン本体（zip の中の計算式エンジン、設定画面、authoring API） | 計算式プラグインの配布元（製品紹介: https://qiita.com/rex0220/items/ae83c6d5ce50ff7a9a73 ） |
| kintone 公式 MCP サーバー（`@kintone/mcp-server`） | [kintone/mcp-server](https://github.com/kintone/mcp-server) |

## 前提（信頼の境界）

- テンプレートでは AI（Claude Code）が `npx @rex0220/formula-authoring-tools …` を確認なしに実行でき、`settings/` `fields/` `records/` `temp/` `kintone/` に書けます。AI は `.env` と `policy/` を書けず、`records/` `users/` を読めません（`.claude/settings.json`）。tools はこの前提で、**AI が書けるファイルを認証情報・承認・実行コードとして読まない**ように作ってあります
- 利用者が置く計算式プラグインの zip の中のコード（計算式エンジン、設定画面のコード、authoring API）は、tools を動かした **OS ユーザーと同じ権限の Node のプロセスで実行**されます。happy-dom の window は DOM の代用で、セキュリティの境界（sandbox）ではありません。`calc` と `normalize` の評価は Worker スレッドで動かし時間の上限で止めますが、Worker も同じ権限です

## tools が守ること

- **kintone には GET しか送らない。** 呼べる API は `app`、`app/form/fields`、`app/form/layout`、`app/views`、`record`、`records`、`app/plugin/config` と、その preview 版に固定している（ゲストスペースの `/k/guest/<id>/v1/` も同じ一覧）。それ以外のパスやメソッドは送信前に止まる。`app/plugin/config`（`pull`）は kintone の API ラボ「アプリに追加されているプラグインの設定情報を取得する」で、計算式プラグインのプラグイン ID（zip の公開鍵から）の設定だけを読む。同じ API ラボの設定の変更（PUT）は呼ばない。**受け取る本文に API ごとの上限**（アプリの情報 64 KiB、項目定義・レイアウト・レコード 8 MiB、一覧・プラグインの設定 2 MiB）があり、超えたら読み切らずに止める
- **User API（cybozu.com 共通）も GET だけ。** `users --pull` が呼ぶのは `users`、`organizations`、`groups`、`organization/users`、`group/users`、`user/organizations`、`user/groups` だけ。認証は cybozu.com 共通管理の API トークン（`Authorization: Bearer`。`FORMULA_USER_API_TOKEN` か profile の `userApiToken`）かログインユーザーで、アプリの API トークンでは呼ばない。cybozu.com 共通の API トークンは kintone の API には使わない。呼び出しの回数に上限（既定 300。`--max`）がある。`--only-referenced` は設定の式が文字列で参照するコードとその所属だけを取る
- **kintone の接続のファイル（`FORMULA_KINTONE_CONFIG`）の場所は CLI から指定できない。** 場所は OS の環境変数（絶対パス）か `.env` だけで、`--profile` で選べるのは接続のファイルの profile の名前だけ。接続のファイルは作業フォルダーの外のときだけ使う（指定のパスも実際のパスも。作業フォルダーの中の symlink も断る）。開いたファイルが普通のファイルで 256 KiB 以下かを確かめてから読み、読み込みの途中で変わったら使わない。認証はその profile のそのアプリの `tokenMap` か、ログイン名とパスワードだけで、kSQL の環境変数の上書き（`KSQL_*`）と OS の `KINTONE_*` は読まない。評価の文脈の接続先には profile の `baseUrl` を使い、`kintone/<profile>/` のフォルダー名（AI が作れる）は使わない。**接続のファイルと、そこが名前を書いた環境変数は、Claude Code の AI が Read / Bash で読める（許可の確認は出る）。受け入れた危険で、閲覧だけの API トークンを勧める**
- **送信先は kintone のドメインだけ。** `KINTONE_BASE_URL` は `https://<サブドメイン>.cybozu.com` / `.kintone.com` / `.cybozu.cn`（`*.s.cybozu.com` を含む）だけを受け付け、ユーザー情報（`user@`）・ポート・パス・クエリが付いた URL は使わない。URL は `new URL(path, base)` で組み、送信直前にも origin が同じか確かめる
- **kintone 以外とは通信しない。** `normalize` / `calc` / `summary` / `diff` / `version` / `users --summary` と、`fields` / `record` の `--summary` はネットワークを使わない。利用状況の送信（テレメトリ）は無い。計算式の評価中に計算式エンジンが kintone の API（`kintone.api`）やユーザー情報の取得を呼ぼうとしても、ダミー層が受けて外には出さない
- **認証情報を出力しない。** `.env` または OS の環境変数か接続のファイルから読み、API トークン・パスワード・ユーザー名は画面・ファイル・エラーの文言に出さない。エラーの文言は HTTP の状態と kintone のエラーコードと固定のヒントだけ。出すのは接続先の URL と「API トークン / cybozu.com 共通の API トークン / ログインユーザー」の区別、接続のファイルの名前と profile の名前だけ
- **レコードの値と個人情報を標準出力に出さない（`calc` を除く）。** `record` は項目の数とテーブルの行数だけ表示し、値は `records/<app>-<id>.json`（POSIX の権限 0o600 = 本人だけが読める。Windows ではユーザーフォルダーの ACL に依る）に書く。`record --summary` も形だけ。`users --pull` も `users/<ホスト>.json`（0o600）に書き、`users --summary` は人数だけ。**例外は `calc`**: 確かめのために、変わる項目の前後の値（レコードの値を含む）を標準出力に出す。Claude Code の AI はこれを読む（テンプレートの手順は、AI が `calc` の結果を見て要件どおりかを確かめる前提）
- **計算式プラグインの zip でなければ実行しない（fail closed）。** 外側の zip の `PUBKEY`（kintone のプラグインの公開鍵）から出るプラグイン ID が計算式プラグインのもの（`src/meta.ts` の `FORMULA_PLUGIN_ID`）で、`manifest.json` の版が Ver.101 以上の整数で、authoring API があるときだけ zip のコードを実行する。違えば **コードを実行する前に止まる**。実行した後に、API の版（`SUPPORTED_API_VERSIONS`）、API のプラグイン名（`FORMULA_CONFIG_PLUGIN_ID`）、tools が使う API のキーと型を確かめる。**`SIGNATURE`（kintone の署名）は検証しない**ので、本物の zip の `PUBKEY` を写して中身を差し替えた zip は止められない。zip の読み取りでは、外側と中身の大きさ・entry の数・展開後の大きさの上限、central directory と local header の名前の一致、CRC-32、同名 entry の重複を確かめる（zip bomb と改変の対策）。公開ビルド（`dist/cli.mjs`、`dist/eval-worker.mjs`、`dist/core.mjs`。計算式プラグイン / kit のコードを含まないことをビルドで確かめる）が読むのは `FORMULA_PLUGIN_ZIP` の zip だけで、`node_modules` や隣のフォルダーのファイルは読まない
- **計算式を評価する前に字面を走査し、副作用の関数は承認が無ければ評価しない。** `normalize` は評価（`dq`）の前に全部の式を走査し、kintone への書き込み・クリップボード・画面の操作に当たる関数（`FUNCTION_TAGS` の sideEffect: FSET / FSET_TADD / BUTTON / DIALOG / CLIPBORD_WRITE）があれば、利用者が AI の書けない `policy/authoring-policy.json` の `allowFunctions` で承認していない限りエラーで止める（走査の間は `dq` を遮断して、評価が先に走らないことを保証する）。承認した上で `calc` を動かしても、エンジンのダミー層は書き込みに当たる呼び出し（`kintone.api` の PUT / POST、クリップボード、イベントの登録）を**記録するだけで実行せず**、呼ばれたレコードの結果は採らない（終了コード 1）。EV_SET（テスト用）が設定にあればエラー
- **評価は Worker で動かし、時間の上限で止める。** `normalize` / `calc` の評価は Worker スレッドで動かし、既定 60 秒（`--timeout`、上限 600）で terminate する（無限ループの式でも CLI が返る）。zip を読むのも Worker の中
- **文脈が足りなければ名指しで止める（fail-closed）。** 接続先の URL が無いのに `APP_URL`、ルックアップ先が決まらないのに `LOOKUP_GETID`、ログインユーザーが決まらないのに `LOGIN_*` / 引数なしの `UINFO()` などを使う式は、`calc` がダミーの値で計算せずに止まる。`--app` と設定の appId、fields と records のアプリ・レコード番号が食い違えば止まる
- **CLI が読む・書く場所を限る。** 読むのは作業フォルダーの中のファイルだけ（`.env` と `node_modules` と `.git` は読まない）、書くのは `fields/` `records/` `settings/` `temp/` `users/` `kintone/` の下だけ（realpath で判定。junction / symlink で外へは出られない。Windows の予約名は使わない）。一覧を作るフォルダー（`kintone/` と profile のフォルダー、アプリのフォルダーと `records/`、`inbox/`）も、実体が作業フォルダーの外を指していれば一覧しない。`.env`、`policy/authoring-policy.json`、zip の場所（`FORMULA_PLUGIN_ZIP`）、接続のファイルの場所は作業フォルダーのものに固定で、`--env` / `--policy` / `--plugin-zip` のようなオプションは無い。パスの検査から書き込みまでの間にリンクが差し替えられる競合（TOCTOU）は残るが、AI と同じ OS ユーザーの範囲の話であり、この tools では防がない
- **`kintone/` の下は接続のファイルの profile の形のときだけ変える。** 変えるのは、接続のファイルにある profile のフォルダーで、アプリのフォルダーの印（`.formula-app.json`。フォルダーを作るときだけ置く）が今の接続のこのアプリのものとき。印の無い・壊れた・別の接続のフォルダーは読みも書きもしない。ダウンロード / pull のファイルは書き換えない（`edit` で `-edit.json` に写す）。変える直前に接続のファイルを読み直し、選んだ profile の接続（接続先、ゲストスペース、認証と資格情報の指紋）が呼び出しの初めと違えば止める。ダウンロード / pull のファイル（`pull`、`take`）は同じフォルダーの一時ファイルからハードリンクで確定し、確かめた後に同じ名前ができても上書きしない。1 接続の形では `kintone/` の下を読みも書きもしない
- **作業フォルダーと環境変数は起動時に一度だけ決める。** 作業フォルダーは実際のパス（symlink / junction を解いたもの）にしてから使い、中核は `process.cwd()` / `process.env` を既定の値として読まない。OS の環境変数の `FORMULA_PLUGIN_ZIP` / `FORMULA_KINTONE_CONFIG` は絶対パスだけ。外側の引用符を外すのは場所と URL だけ（認証情報は外さない）
- **`normalize` は設定画面と同じ規則で検査する。** 生の JSON の未知のキー（入れ子も）はエラー（設定画面は黙って捨てる）、封筒（`pluginID`、`PluginVersion`、`appId`）、今のアプリに無い項目、型、ランクの範囲、計算式の評価の誤り、循環、保存値の大きさ（内部番号の分を上乗せ）。エラーがあれば書き出さない

## tools がしないこと（利用者が守ること）

- **zip は計算式プラグインの配布元から入手したものを使う。** 出所の分からない zip を `FORMULA_PLUGIN_ZIP` に書かない。tools はプラグイン ID だけを見るので、中身を差し替えた zip を見分けられない（その zip のコードがこの PC の権限で動く）
- `calc` は模擬で、実機の結果と同じとは限らない（イベント、ログインユーザー、ユーザー情報、ルックアップ先はダミーかテストデータ）。**アップロードする前に `diff` の差分を人が見て、反映した後は実機で確かめる**
- kintone への書き込みは、テンプレートの `.claude/settings.json` が kintone MCP の書き込みツールを拒否し、CLAUDE.md が禁じているが、最終的な担保はサーバー側の権限（**レコード閲覧だけの API トークン**か、閲覧権限だけのアカウント）。設定・権限・API トークンの管理は利用者の責任
- `.env`（認証情報）と接続のファイルはコミットしない。設定 JSON にはアプリ番号・項目コード・業務用語が入るので、設定を置くリポジトリは **private** にする。`records/` と `users/` は作業が終わったら消す
- 依存パッケージ（`happy-dom`、同梱の `moment`）の脆弱性は `npm audit` と新しい版への更新で対応する。第三者のソフトウェアの一覧は `THIRD_PARTY_NOTICES.md`
