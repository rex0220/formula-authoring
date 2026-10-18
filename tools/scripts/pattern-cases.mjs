/**
 * 計算パターン集（docs/計算パターン.md）の例を、同梱のサンプルアプリ（4329）に項目を足し、架空の値で評価する検証ケース（計画 25.4。工程 8-4）。
 * scripts/verify-patterns.mjs が trySettings で評価して docs/計算パターン_検証.md を作る。test/docs-sync.test.mjs が「生成物が最新」と「全部一致」を確かめる。
 *   - 1 ケース = 1 回の trySettings（fields / data / records は共通、formulas は式ごとに独立の 1 行の設定。複数の式の組は、前の式の結果を data に書いて 1 式ずつ）
 *   - expect はレコードごとの値（対象の型に入れた後の値）。show を付けるとテーブル（SUBTABLE の対象）の結果はその子の値の配列
 *   - policy は副作用のある関数（FSET など）を評価するときだけ付ける。note は検証の文書に添える説明
 *   - 値はすべて架空。実在の人・組織・本番の値は入れない
 */

/** 2305「テーブル内集計」と同じ形のテーブル（分類は 概要 / 明細 / 小計） */
const TABLE_2305 = { code: "テーブル", type: "SUBTABLE", fields: [
  { code: "No", type: "NUMBER" }, { code: "商品", type: "TEXT" }, { code: "分類", type: "DROP_DOWN", options: ["概要", "明細", "小計"] },
  { code: "数量", type: "NUMBER" }, { code: "単価", type: "NUMBER" }, { code: "金額", type: "NUMBER" }, { code: "見出し", type: "TEXT" }
] };
const ROWS_2305 = [
  { No: 1, 商品: "Aセット", 分類: "概要" },
  { No: 2, 商品: "品1", 分類: "明細", 数量: 2, 単価: 100, 金額: 200 },
  { No: 3, 商品: "品2", 分類: "明細", 数量: 3, 単価: 200, 金額: 600 },
  { No: 4, 分類: "小計", 金額: 800 },
  { No: 5, 商品: "Bセット", 分類: "概要" },
  { No: 6, 商品: "品3", 分類: "明細", 数量: 1, 単価: 50, 金額: 50 },
  { No: 7, 分類: "小計", 金額: 50 }
];
/** 4328「出張管理」と同じ形: テーブル1 に 旅費分類 / 金額、テーブル2 に 分類 / 分類金額（標本のテーブルに子として足す） */
const TRIP_FIELDS = [
  { code: "旅費分類", type: "DROP_DOWN", options: ["鉄道", "バス", "飛行機", "タクシー", "宿泊費", "その他"], table: "テーブル1" },
  { code: "金額", type: "NUMBER", table: "テーブル1" },
  { code: "分類", type: "TEXT", table: "テーブル2" },
  { code: "分類金額", type: "NUMBER", table: "テーブル2" }
];
const TRIP_ROWS = [{ 旅費分類: "鉄道", 金額: 393 }, { 旅費分類: "バス", 金額: 230 }, { 旅費分類: "鉄道", 金額: 100 }];
const NAMES = '"鉄道","バス","飛行機","タクシー","宿泊費","その他"';
/** 標本のテーブル1（T1_数値 100 / 200 / 300 の 3 行）を使うケースの架空の値 */
const T1_ROWS = [{ T1_数値: 100, T1_文字列: "a", T1_ドロップダウン: "B" }, { T1_数値: 200, T1_文字列: "b", T1_ドロップダウン: "A" }, { T1_数値: 300, T1_文字列: "c", T1_ドロップダウン: "A" }];

export const PATTERN_CASES = [
  // ---- テーブルの行 ----
  {
    section: "テーブルの行", pattern: "行番号（1 から）", data: [{ テーブル1: T1_ROWS }],
    formulas: [{ formula: "ROWNO(テーブル1)+1", as: "T1_文字列", table: "テーブル1", expect: [["1", "2", "3"]] }]
  },
  {
    section: "テーブルの行", pattern: "行数を固定する（常に N 行）", data: [{ テーブル2: [{ T2_文字列: "x" }] }],
    formulas: [{ formula: "6", as: "テーブル2", show: "T2_文字列", expect: [["x", "", "", "", "", ""]] }]
  },
  {
    section: "テーブルの行", pattern: "固定の行に分類の名前を入れる", data: [{ テーブル2: [{}, {}, {}, {}, {}, {}] }],
    formulas: [{ formula: `ARRAY_GET(ARRAY(${NAMES}), ROWNO(テーブル2))`, as: "T2_文字列", table: "テーブル2", expect: [["鉄道", "バス", "飛行機", "タクシー", "宿泊費", "その他"]] }]
  },
  {
    section: "テーブルの行", pattern: "初期の行（更新のときも入れる ARRAY(\"\", \"[…]\", 1)）", fields: TRIP_FIELDS, data: [{ テーブル1: [] }],
    formulas: [{ formula: `ARRAY("", "[{'旅費分類':'鉄道','金額':'393'},{'旅費分類':'バス','金額':'230'}]", 1)`, as: "テーブル1", show: "金額", expect: [["393", "230"]] }]
  },
  {
    section: "テーブルの行", pattern: "並べ替え・絞り込み", data: [{ テーブル1: T1_ROWS }],
    formulas: [
      { formula: "TABLE_SORT(テーブル1, TPFILTER(T1_数値>0), TPSORT(T1_ドロップダウン, T1_数値, 0))", as: "テーブル1", show: "T1_数値", expect: [["300", "200", "100"]] },
      { formula: "TABLE_SORT(テーブル1, TPFILTER(T1_数値>100))", as: "テーブル1", show: "T1_数値", expect: [["200", "300"]] }
    ]
  },
  {
    section: "テーブルの行", pattern: "別のテーブルへ転記（項目の対応を変えて）", data: [{ テーブル1: T1_ROWS, テーブル2: [] }],
    formulas: [{ formula: 'TABLE_DATA(TABLE_MAP(テーブル1, TPDIC("T2_文字列", T1_文字列, "T2_数値", T1_数値)))', as: "テーブル2", show: "T2_数値", expect: [["100", "200", "300"]] }]
  },
  // ---- テーブルの集計 ----
  {
    section: "テーブルの集計", pattern: "合計・件数・最大・最小（テーブルの外）", data: [{ テーブル1: T1_ROWS }, { テーブル1: [] }],
    formulas: [
      { formula: "SUM(T1_数値)", as: "NUMBER", expect: ["600", "0"] },
      { formula: "COUNT(T1_数値)", as: "NUMBER", expect: ["3", "0"] },
      { formula: "MAX(T1_数値)", as: "NUMBER", expect: ["300", ""] },
      { formula: "MIN(T1_数値)", as: "NUMBER", expect: ["100", ""] }
    ]
  },
  {
    section: "テーブルの集計", pattern: "条件付きの合計・件数", fields: [TABLE_2305], data: [{ テーブル: ROWS_2305 }],
    formulas: [
      { formula: 'SUMIF(分類="小計", 金額)', as: "NUMBER", expect: ["850"] },
      { formula: 'COUNTIF(分類="小計", No)', as: "NUMBER", expect: ["2"] }
    ]
  },
  {
    section: "テーブルの集計", pattern: "分類ごとの集計 (a) 固定の行で全分類を出す（0 も出る）", fields: TRIP_FIELDS,
    data: [{ テーブル1: TRIP_ROWS, テーブル2: [{ 分類: "鉄道" }, { 分類: "バス" }, { 分類: "飛行機" }, { 分類: "タクシー" }, { 分類: "宿泊費" }, { 分類: "その他" }] }],
    formulas: [
      { formula: "6", as: "テーブル2", show: "分類", expect: [["鉄道", "バス", "飛行機", "タクシー", "宿泊費", "その他"]] },
      { formula: `ARRAY_GET(ARRAY(${NAMES}), ROWNO(テーブル2))`, as: "分類", table: "テーブル2", expect: [["鉄道", "バス", "飛行機", "タクシー", "宿泊費", "その他"]] },
      { formula: "LET(c, 分類, NVL(SUMIF(旅費分類=c, 金額), 0))", as: "分類金額", table: "テーブル2", expect: [["493", "230", "0", "0", "0", "0"]] }
    ]
  },
  {
    section: "テーブルの集計", pattern: "分類ごとの集計 (c) 該当のある分類だけ、未選択・空の値の扱いも決めて", fields: TRIP_FIELDS,
    data: [{ テーブル1: [...TRIP_ROWS, { 旅費分類: "", 金額: 50 }], テーブル2: [{ 分類: "その他" }, { 分類: "バス" }, { 分類: "鉄道" }] }],
    formulas: [
      { formula: 'ARRAY_COUNT(TDS(NVL(旅費分類, "その他")))', as: "テーブル2", show: "分類", expect: [["その他", "バス", "鉄道"]] },
      { formula: 'ARRAY_GET(ARRAY_SORT(TDS(NVL(旅費分類, "その他"))), ROWNO(テーブル2))', as: "分類", table: "テーブル2", expect: [["その他", "バス", "鉄道"]] },
      { formula: 'LET(c, 分類, NVL(SUMIF(NVL(旅費分類, "その他") = c, 金額), 0))', as: "分類金額", table: "テーブル2", expect: [["50", "230", "493"]] }
    ]
  },
  {
    section: "テーブルの集計", pattern: "分類ごとの集計 (b) 該当のある分類だけ（TLTABLE）", fields: TRIP_FIELDS, data: [{ テーブル1: TRIP_ROWS, テーブル2: [] }],
    formulas: [
      { formula: "TLTABLE(テーブル1, TPKEY(旅費分類), TPVAL(金額), TPOUT(分類, 分類金額), TPSORT(分類))", as: "テーブル2", show: "分類", expect: [["バス", "鉄道"]] },
      { formula: "TLTABLE(テーブル1, TPKEY(旅費分類), TPVAL(金額), TPOUT(分類, 分類金額), TPSORT(分類))", as: "テーブル2", show: "分類金額", expect: [[230, 493]], note: "TLTABLE が作る行の値は数（文字列でない）" }
    ]
  },
  {
    section: "テーブルの集計", pattern: "小計の行（直前の小計より後の明細の合計）", fields: [TABLE_2305], data: [{ テーブル: ROWS_2305.map((r) => ({ ...r, 金額: undefined })) }],
    formulas: [{
      formula: 'LET(CNO, ROWNO(テーブル), SWITCH(分類, "明細", 数量*単価, "小計", LET(PNO, NVL(LASTIF(AND(ROWNO(テーブル)<CNO, 分類="小計"), ROWNO(テーブル)), -1), SUMIF(AND(ROWNO(テーブル)>PNO, ROWNO(テーブル)<CNO, 分類="明細"), 金額)), ""))',
      as: "金額", table: "テーブル", expect: [["", "200", "600", "800", "", "50", "50"]]
    }]
  },
  {
    section: "テーブルの集計", pattern: "区切りの先頭の行の値を小計の行に入れる", fields: [TABLE_2305], data: [{ テーブル: ROWS_2305 }],
    formulas: [{
      formula: 'LET(CNO, ROWNO(テーブル), PNO, NVL(LASTIF(AND(ROWNO(テーブル)<CNO, 分類="小計"), ROWNO(テーブル)), -1), IF(分類="小計", FIRSTIF(AND(ROWNO(テーブル)>PNO, ROWNO(テーブル)<CNO, 分類="概要"), 商品), ""))',
      as: "見出し", table: "テーブル", expect: [["", "", "", "Aセット", "", "", "Bセット"]]
    }]
  },
  {
    section: "テーブルの集計", pattern: "累計（その行までの合計）", fields: [{ code: "累計", type: "NUMBER", table: "テーブル1" }], data: [{ テーブル1: T1_ROWS }],
    formulas: [{ formula: "LET(CNO, ROWNO(テーブル1), SUMIF(ROWNO(テーブル1)<=CNO, T1_数値))", as: "累計", table: "テーブル1", expect: [["100", "300", "600"]] }]
  },
  {
    section: "テーブルの集計", pattern: "割合（%）", fields: [{ code: "割合", type: "NUMBER", table: "テーブル1" }], data: [{ テーブル1: T1_ROWS }],
    formulas: [{ formula: "ROUND(T1_数値 / SUM(T1_数値) * 100, 1)", as: "割合", table: "テーブル1", expect: [["16.7", "33.3", "50"]] }]
  },
  {
    section: "テーブルの集計", pattern: "行ごとに全体を見る（前の行の値など）", fields: [{ code: "前の行", type: "NUMBER", table: "テーブル1" }], data: [{ テーブル1: T1_ROWS }],
    formulas: [{ formula: "LET(CNO, ROWNO(テーブル1), LASTIF(ROWNO(テーブル1)<CNO, T1_数値))", as: "前の行", table: "テーブル1", expect: [["", "100", "200"]] }]
  },
  {
    section: "テーブルの集計", pattern: "消費税など行ごとの計算と合計", fields: [{ code: "税", type: "NUMBER", table: "テーブル1" }], data: [{ テーブル1: T1_ROWS.map((r) => ({ ...r, 税: Math.floor(r.T1_数値 * 0.1) })) }],
    formulas: [
      { formula: "ROUNDDOWN(T1_数値*0.1, 0)", as: "税", table: "テーブル1", expect: [["10", "20", "30"]] },
      { formula: "SUM(税)", as: "NUMBER", expect: ["60"] }
    ]
  },
  // ---- 値・文字列・日付 ----
  {
    section: "値・文字列・日付", pattern: "条件で値を変える", data: [{ ドロップダウン1: "A", 数値1: 5 }, { ドロップダウン1: "B", 数値1: 5 }, { ドロップダウン1: "C", 数値1: 5 }],
    formulas: [
      { formula: 'IF(ドロップダウン1="A", 数値1, "")', as: "NUMBER", expect: ["5", "", ""] },
      { formula: 'SWITCH(ドロップダウン1, "A", 1, "B", 2, 0)', as: "NUMBER", expect: ["1", "2", "0"] },
      { formula: 'IN(ドロップダウン1, "A", "B")', as: "TEXT", expect: ["true", "true", "false"] },
      { formula: 'IFS(ドロップダウン1="A", "甲", ドロップダウン1="B", "乙", "他")', as: "TEXT", expect: ["甲", "乙", "他"] }
    ]
  },
  {
    section: "値・文字列・日付", pattern: "空のときの既定", data: [{ テーブル1: T1_ROWS }, { テーブル1: [] }],
    formulas: [
      { formula: "SUMIF(T1_数値 > 1000, T1_数値)", as: "NUMBER", expect: ["0", "0"] },
      { formula: 'NVL(LASTIF(T1_数値 > 1000, T1_数値), 0)', as: "NUMBER", expect: ["0", "0"] },
      { formula: 'LASTIF(T1_数値 > 1000, T1_数値)', as: "NUMBER", expect: ["", ""] }
    ]
  },
  {
    section: "値・文字列・日付", pattern: "選択した値・名前を文字列にする（ユーザー・組織・グループ、チェックボックス・複数選択）",
    fields: [{ code: "担当者", type: "USER_SELECT" }],
    data: [{ 担当者: ["demo_user02", "demo_user03"], 組織1: ["demo_hq", "demo_sales"], チェック1: ["A", "C"], 複数選択1: ["B", "C"], 作業者: ["demo_user04"] }, { 担当者: [], チェック1: [] }],
    formulas: [
      { formula: "担当者", expect: ["架空 営業部長, 架空 開発部長", ""], note: "名前を「, 」（カンマと空白）で" },
      { formula: "組織1", expect: ["架空本社, 架空営業部", ""] },
      { formula: 'SEL_NAME(担当者, "text", "、")', expect: ["架空 営業部長、架空 開発部長", ""] },
      { formula: 'SEL_NAME(担当者, "text", NEWLINE())', as: "MULTI_LINE_TEXT", expect: ["架空 営業部長\n架空 開発部長", ""], note: "区切りは式として評価される（Ver.101 の 2026-10-18 の直し）" },
      { formula: 'SEL_CODE(担当者, "text")', expect: ["demo_user02,demo_user03", ""] },
      { formula: "チェック1", expect: ["A,C", ""], note: "値を「,」で" },
      { formula: 'JOIN(チェック1, "、")', expect: ["A、C", ""] },
      { formula: "複数選択1", expect: ["B,C", ""] },
      { formula: 'SEL_NAME(作業者, "text")', expect: ["架空 営業一郎", ""], note: "作業者をそのまま書くと [object Object]" }
    ]
  },
  {
    section: "値・文字列・日付", pattern: "文字をつなぐ", fields: [TABLE_2305, { code: "金額合計", type: "NUMBER" }], data: [{ テーブル: ROWS_2305, 金額合計: 850 }],
    formulas: [{ formula: '"小計 " & COUNTIF(分類="小計", No) & " 件 / 合計 " & 金額合計', as: "TEXT", expect: ["小計 2 件 / 合計 850"] }]
  },
  {
    section: "値・文字列・日付", pattern: "変数で式を短く", data: [{ 数値1: 5 }], policy: { allowFunctions: ["FSET"], allowMiscChanges: true },
    formulas: [
      { formula: "LET(x, 数値1 * 2, y, x + 1, y)", as: "NUMBER", expect: ["11"] },
      { formula: "LET(x, 1, y, FSET(x, x + 10), x)", as: "NUMBER", expect: ["11"] }
    ]
  },
  {
    section: "値・文字列・日付", pattern: "置換（複数の組）", data: [{ 文字列1: "(株)甲 （株）乙" }],
    formulas: [{ formula: 'REPLACEALL(文字列1, ARRAY("(株)", "株式会社", "（株）", "株式会社"))', as: "TEXT", expect: ["株式会社甲 株式会社乙"] }]
  },
  {
    section: "値・文字列・日付", pattern: "日付の書式・加算・差", data: [{ 日付1: "2026-01-31", 日付2: "2026-03-01" }],
    formulas: [
      { formula: 'DATE_FORMAT(日付1, "YYYY/MM/DD")', as: "TEXT", expect: ["2026/01/31"] },
      { formula: 'DATE_ADD(日付1, 1, "months")', as: "DATE", expect: ["2026-02-28"] },
      { formula: 'DATE_DIFF(日付1, 日付2, "days")', as: "NUMBER", expect: ["29"], note: "引数は（前の日付, 後の日付）。逆にすると負の数" },
      { formula: 'DATE_DIFF(日付2, 日付1, "days")', as: "NUMBER", expect: ["-29"] }
    ]
  },
  {
    section: "値・文字列・日付", pattern: "配列を回す・作る", records: [3],
    formulas: [
      { formula: 'ARRAY_FOR(3, idx, "A"&idx)', as: "TEXT", expect: ["A0,A1,A2"] },
      { formula: "ARRAY_MAP(ARRAY(1,2,3), v, v*10)", as: "TEXT", expect: ["10,20,30"] },
      { formula: "ARRAY_FIL(ARRAY(1,2,3), v, v>1)", as: "TEXT", expect: ["2,3"] }
    ]
  },
  // ---- ユーザー情報（既定のテストデータ。架空） ----
  {
    section: "ユーザー情報", pattern: "ログインユーザーの情報（既定のテストデータ。ログインユーザーは authoring）", records: [3],
    formulas: [
      { formula: "LOGIN_CODE()", as: "TEXT", expect: ["authoring"] },
      { formula: 'UINFO(LOGIN_CODE(), "name")', as: "TEXT", expect: ["架空 オーサリング"] },
      { formula: 'UINFO(LOGIN_CODE(), "#boss")', as: "TEXT", expect: ["demo_user03"] }
    ]
  },
  {
    section: "ユーザー情報", pattern: "組織・グループの名前・メンバー（既定のテストデータ）", records: [3],
    formulas: [
      { formula: 'OINFO("demo_sales", "name")', as: "TEXT", expect: ["架空営業部"] },
      { formula: 'OUSERS("demo_sales")', as: "TEXT", expect: ["demo_user02,demo_user04,demo_user05,demo_user09"], note: "配列を文字列の項目に入れるとカンマ区切り" },
      { formula: 'GINFO("demo_managers", "name")', as: "TEXT", expect: ["架空管理職"] }
    ]
  },
  // ---- イベント ----
  {
    section: "ボタン・イベント", pattern: "イベントで結果を変える（既定は allUpdate）", records: [3],
    formulas: [{ formula: 'EV_INFO("type")', as: "TEXT", expect: ["allUpdate"] }]
  }
];
