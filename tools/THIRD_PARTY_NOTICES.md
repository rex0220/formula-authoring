# Third-party notices

`@rex0220/formula-authoring-tools` が同梱または依存する第三者のソフトウェアと、そのライセンス。

## 同梱（`vendor/`）

### moment 2.24.0（`vendor/moment-with-locales.min.js`）

計算式プラグインが manifest で読み込む CDN（https://js.cybozu.com/momentjs/2.24.0/moment-with-locales.min.js）と同じファイルを、tools のビルド時に取得して同梱しています（`vendor/moment.json` の SHA-256 で照合）。

```
Copyright (c) JS Foundation and other contributors

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

## 依存（npm が入れる）

### happy-dom（MIT）

Copyright (c) 2019 David Ortner (capricorn86). https://github.com/capricorn86/happy-dom/blob/master/LICENSE

## 利用者の計算式プラグインの zip から実行時に読むもの（tools には含まれない）

- `KintoneFormula.min.js`（計算式エンジン）、`formula-authoring-api.js`（計算式プラグインの設定画面のコードと plugin-config-kit） … rex0220。計算式プラグインの利用規約に従う
- `bignumber.min.js`（bignumber.js、MIT。Copyright (c) 2019 Michael Mclaughlin）、`rex0220_decimal.min.js`（decimal.js、MIT。Copyright (c) 2022 Michael Mclaughlin）、`moment-timezone-with-data.min.js`（moment-timezone、MIT。Copyright (c) JS Foundation and other contributors） … 計算式プラグインに同梱されているものをそのまま実行する
