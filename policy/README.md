# policy（利用者が書く。AI は書かない）

`authoring-policy.json`:

- `allowFunctions`: 副作用のある関数（FSET / FSET_TADD / BUTTON / DIALOG / CLIPBORD_WRITE）のうち、tools の normalize / calc / try で評価してよいもの（関数単位）。テンプレートの既定は `BUTTON` / `DIALOG` / `FSET` / `FSET_TADD`（2026-10-18 Takashi。ボタンの中で使う関数。評価は写しのレコードの上で、kintone には何も書かない。`calc --click` / `try --click` でクリックの模擬ができる）。`CLIPBORD_WRITE`（クリップボード）は要るときだけ足す。厳しくするなら配列から外す（外した関数を使う式は `formula.side-effect` のエラーで評価しない）。
- `allowMiscChanges`: 各種設定（pluginMiscInfo）を既定から変えた設定を警告でなく情報にする。既定 false。

`EV_SET`（テスト用）は許可できない。設定に残っていれば常にエラー。
