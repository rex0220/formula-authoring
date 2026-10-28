/**
 * 項目検証の検証パターン（docs/項目検証/検証パターン.md の元）。サンプルアプリ（samples/項目検証/fields-sample.json。経費申請（架空））で、
 * パターンごとに 設定（元の値の行）→ fv normalize → fv check を流し、ケースの期待と合うかを ✔ / ✘ で書く（gen-fv-docs.mjs）。
 * expect: 項目（テーブルの子は "明細[1].内容T"、行のボタンは "明細[1] 行の追加"）→ 期待（書いたキーだけ比べる）。null は「印なし」
 * values: レコードの値（書かない項目は空。テーブルは rows）。event の既定は app.record.edit.change.<なし> = 一覧編集と同じ app.record.index.edit.change
 */

export const FV_PATTERNS = [
  {
    id: "P1", title: "選択肢で必須にする", want: "区分が「接待費」のとき、理由を必須にする",
    infos: [{ fieldcode: "理由", state: true, formulaSet: '区分 = "接待費"' }],
    cases: [
      { label: "接待費で理由が空", values: { 区分: "接待費" }, event: "app.record.create.submit", expect: { 理由: { required: true, errors: ["必須項目"] } } },
      { label: "交通費", values: { 区分: "交通費" }, event: "app.record.create.submit", expect: { 理由: null } }
    ]
  },
  {
    id: "P2", title: "金額で必須にする", want: "金額が 5 万円以上のとき、承認者（ユーザー選択）を必須にする",
    infos: [{ fieldcode: "承認者", state: true, formulaSet: "金額 >= 50000" }],
    cases: [
      { label: "60,000 円で承認者が空", values: { 金額: "60000" }, event: "app.record.create.submit", expect: { 承認者: { required: true, errors: ["必須項目"] } } },
      { label: "60,000 円で承認者あり", values: { 金額: "60000", 承認者: [{ code: "demo_user02", name: "架空ユーザー02" }] }, event: "app.record.create.submit", expect: { 承認者: { required: true, errors: [] } } },
      { label: "1,000 円", values: { 金額: "1000" }, event: "app.record.create.submit", expect: { 承認者: null } }
    ]
  },
  {
    id: "P3", title: "選択肢で入力不可にする", want: "支払方法が「現金」のとき、口座（グループ「振込先」の中）を入力不可にする",
    infos: [{ fieldcode: "口座", state: true, disabledSet: '支払方法 = "現金"' }],
    cases: [
      { label: "現金", values: { 支払方法: "現金" }, expect: { 口座: { disabled: true, required: false } } },
      { label: "振込", values: { 支払方法: "振込", 口座: "1234567" }, expect: { 口座: null } }
    ]
  },
  {
    id: "P4", title: "隠して、保存のときに初期値に戻す", want: "区分が「交通費」のとき備考を隠し、隠れたまま保存したら初期値（なし）に戻す",
    infos: [{ fieldcode: "備考", state: true, hideSet: '区分 = "交通費"', init: true }],
    cases: [
      { label: "交通費・値の変更のとき", values: { 区分: "交通費", 備考: "メモ" }, event: "app.record.edit.change.区分", expect: { 備考: { hidden: true, reset: undefined } } },
      { label: "交通費・保存の前", values: { 区分: "交通費", 備考: "メモ" }, event: "app.record.edit.submit", expect: { 備考: { hidden: true, reset: { value: "なし" } } } },
      { label: "その他", values: { 区分: "その他", 備考: "メモ" }, event: "app.record.edit.submit", expect: { 備考: null } }
    ]
  },
  {
    id: "P5", title: "ステータスで必須・入力不可にする", want: "ステータスが「承認待ち」「完了」のとき承認者を必須に、「完了」のとき金額を入力不可にする（プロセス管理のステータスは項目コード ステータス）",
    infos: [
      { fieldcode: "承認者", state: true, formulaSet: 'IN(ステータス, "承認待ち", "完了")' },
      { fieldcode: "金額", state: true, disabledSet: 'ステータス = "完了"' }
    ],
    cases: [
      { label: "承認待ち", values: { ステータス: "承認待ち", 金額: "1000" }, event: "app.record.edit.submit", expect: { 承認者: { required: true, errors: ["必須項目"] }, 金額: null } },
      { label: "完了", values: { ステータス: "完了", 金額: "1000", 承認者: [{ code: "demo_user02", name: "架空ユーザー02" }] }, event: "app.record.edit.submit", expect: { 承認者: { required: true, errors: [] }, 金額: { disabled: true } } },
      { label: "未処理", values: { ステータス: "未処理", 金額: "1000" }, event: "app.record.edit.submit", expect: { 承認者: null, 金額: null } }
    ]
  },
  {
    id: "P6", title: "検証条件（メッセージに値を入れる）", want: "金額が 10 万円を超えたら、入力した金額を添えてエラーにする",
    infos: [{ fieldcode: "金額", state: true, condInfos: [{ state: true, condSet: "金額 > 100000", jaSet: '"10 万円を超えています（" & 金額 & " 円）"', enSet: '"Over 100,000 yen"', zhSet: "" }] }],
    cases: [
      { label: "150,000 円", values: { 金額: "150000" }, expect: { 金額: { errors: ["10 万円を超えています（150000 円）"] } } },
      { label: "150,000 円（英語）", values: { 金額: "150000" }, lang: "en", expect: { 金額: { errors: ["Over 100,000 yen"] } } },
      { label: "150,000 円（中国語。空なら日本語）", values: { 金額: "150000" }, lang: "zh", expect: { 金額: { errors: ["10 万円を超えています（150000 円）"] } } },
      { label: "80,000 円", values: { 金額: "80000" }, expect: { 金額: null } }
    ]
  },
  {
    id: "P7", title: "日付の検証条件", want: "申請日が今日より後ならエラーにする。日付の項目は式の中では数（秒）になり、TODAY() は文字列（\"YYYY-MM-DD\"）を返すので、\`申請日 > TODAY()\` は比べられない（偽になる）。DATE_DIFF で日数を比べ、空の日付は AND で除く（DATE_DIFF は空を 1970-01-01 として数える）",
    infos: [{ fieldcode: "申請日", state: true, condInfos: [{ state: true, condSet: 'AND(申請日, DATE_DIFF("TODAY", 申請日, "days") > 0)', jaSet: '"未来の日付は申請できません"', enSet: "", zhSet: "" }] }],
    cases: [
      { label: "2099-12-31", values: { 申請日: "2099-12-31" }, expect: { 申請日: { required: true, errors: ["未来の日付は申請できません"] } } },
      { label: "2020-01-01", values: { 申請日: "2020-01-01" }, expect: { 申請日: { required: true, errors: [] } } },
      { label: "空（必須の文だけ）", values: { 申請日: "" }, expect: { 申請日: { required: true, errors: ["必須項目"] } } }
    ]
  },
  {
    id: "P8", title: "テーブルの行ごとの必須と検証条件", want: "明細の行で、金額T があれば内容T を必須に、金額T が 1 万円を超えたらエラーにする（テーブルの中の式は同じ行の値を読む）",
    infos: [
      { fieldcode: "内容T", state: true, formulaSet: '金額T <> ""' },
      { fieldcode: "金額T", state: true, condInfos: [{ state: true, condSet: "金額T > 10000", jaSet: '"1 行 10,000 円まで"', enSet: "", zhSet: "" }] }
    ],
    cases: [
      {
        label: "3 行", rows: [{ 内容T: "", 金額T: "5000" }, { 内容T: "タクシー", 金額T: "20000" }, { 内容T: "", 金額T: "" }],
        expect: { "明細[1].内容T": { required: true, errors: ["必須項目"] }, "明細[2].金額T": { errors: ["1 行 10,000 円まで"] }, "明細[3].内容T": null }
      }
    ]
  },
  {
    id: "P9", title: "テーブルの列を隠す", want: "区分が「交通費」でないとき、明細の日付T の列を隠す（テーブル内非表示。テーブルの行に設定する。判定の表に出るのは「使う」がオンの子だけなので、日付T の行も「使う」をオンにする）",
    infos: [{ fieldcode: "明細", state: true, tblfields: [{ fieldcode: "日付T", state: true, hideSet: '区分 <> "交通費"' }] }, { fieldcode: "日付T", state: true }],
    cases: [
      { label: "その他", values: { 区分: "その他" }, rows: [{ 日付T: "2026-10-01", 内容T: "x" }], expect: { "明細[1].日付T": { hidden: true } } },
      { label: "交通費", values: { 区分: "交通費" }, rows: [{ 日付T: "2026-10-01", 内容T: "x" }], expect: { "明細[1].日付T": null } }
    ]
  },
  {
    id: "P10", title: "テーブルの行の追加を止める", want: "ステータスが「完了」のとき、明細の行の追加（＋）を隠す（行のボタンの行 明細($ADD)。削除は 明細($DEL)）",
    infos: [{ fieldcode: "明細($ADD)", state: true, hideSet: 'ステータス = "完了"' }],
    cases: [
      { label: "完了", values: { ステータス: "完了" }, rows: [{ 内容T: "x" }], expect: { "明細[1] 行の追加": { hidden: true } } },
      { label: "未処理", values: { ステータス: "未処理" }, rows: [{ 内容T: "x" }], expect: { "明細[1] 行の追加": null } }
    ]
  },
  {
    id: "P11", title: "隠したルックアップの値を消す", want: "区分が「交通費」のとき取引先（ルックアップ）を隠し、取得した値を消す（初期化をオン。初期値が空のルックアップは、隠れて値があればイベントによらず解除する）",
    infos: [{ fieldcode: "取引先", state: true, hideSet: '区分 = "交通費"', init: true }],
    cases: [
      { label: "交通費・値あり", values: { 区分: "交通費", 取引先: "A 社" }, expect: { 取引先: { hidden: true, reset: { value: "", lookup: "CLEAR" } } } },
      { label: "交通費・空", values: { 区分: "交通費" }, expect: { 取引先: { hidden: true, reset: undefined } } }
    ]
  },
  {
    id: "P12", title: "作成のときだけ必須にする", want: "レコードを作るときだけ申請者を必須にする（EV_INFO(\"type\") でイベントを見る。fv check の --event で作成と編集を比べる）",
    infos: [{ fieldcode: "申請者", state: true, formulaSet: 'LEFT(EV_INFO("type"), 17) = "app.record.create"' }],
    cases: [
      { label: "作成の保存の前", event: "app.record.create.submit", expect: { 申請者: { required: true, errors: ["必須項目"] } } },
      { label: "編集の保存の前", event: "app.record.edit.submit", expect: { 申請者: null } }
    ]
  },
  {
    id: "P13", title: "フォームの制約（式は要らない）", want: "「使う」をオンにした項目は、フォームで決めた文字数（口座は 7 文字）と数値の範囲（金額は 0〜1,000,000）も検査し、隠れていても空でも文が出る（式は書かなくてよい。「使う」がオフの項目は項目検証では検査しない。kintone も保存のときに検査する）",
    infos: [{ fieldcode: "口座", state: true }, { fieldcode: "金額", state: true }],
    cases: [
      { label: "口座が 3 文字、金額が -1", values: { 口座: "123", 金額: "-1" }, expect: { 口座: { errors: ["6文字より長くなければなりません。"] }, 金額: { errors: ["0以上である必要があります。"] } } },
      { label: "口座が空", values: { 口座: "" }, expect: { 口座: { errors: ["6文字より長くなければなりません。"] } } }
    ]
  },
  {
    id: "P14", title: "グループを隠す（判定の表には出ない）", want: "支払方法が「現金」のとき、グループ「振込先」を隠す（グループの行に非表示の式。判定の表はグループを出さず、中の項目の判定もそのまま。画面で確かめる）",
    infos: [{ fieldcode: "振込先", state: true, hideSet: '支払方法 = "現金"' }],
    cases: [
      { label: "現金・口座 7 文字", values: { 支払方法: "現金", 口座: "1234567" }, expect: { 口座: null } }
    ]
  }
];

/** 雛形（samples/項目検証/settings-source.json）に入れるパターン（同じ項目に重ならないもの） */
export const FV_SAMPLE_PATTERNS = ["P1", "P2", "P3", "P4", "P6", "P7", "P8", "P9", "P10", "P11"];
