# policy（利用者が書く。AI は書かない）

`authoring-policy.json`:

- `allowFunctions`: 副作用のある関数（FSET / FSET_TADD / BUTTON / DIALOG / CLIPBORD_WRITE）のうち、tools の normalize / calc で評価してよいもの（関数単位）。既定は空 = 評価せずにエラー。
- `allowMiscChanges`: 各種設定（pluginMiscInfo）を既定から変えた設定を警告でなく情報にする。既定 false。

`EV_SET`（テスト用）は許可できない。設定に残っていれば常にエラー。
