/**
 * 計算パターン集（docs/計算パターン.md）の例を、同梱のサンプルアプリ（4329）に項目を足し、架空の値で評価する検証ケース（計画 25.4。工程 8-4）。
 * scripts/verify-patterns.mjs が trySettings で評価して docs/計算パターン_検証.md を作る。test/docs-sync.test.mjs が「生成物が最新」と「全部一致」を確かめる。
 *   - 1 ケース = 1 回の trySettings（fields / data / records は共通、formulas は式ごとに独立の 1 行の設定。複数の式の組は、前の式の結果を data に書いて 1 式ずつ）
 *   - expect はレコードごとの値（対象の型に入れた後の値）。show を付けるとテーブル（SUBTABLE の対象）の結果はその子の値の配列。
 *     長い HTML などは expectIncludes（結果の JSON に含まれるべき文字列の配列）で確かめる（検証の文書では結果を 300 字で切る）
 *   - policy は副作用のある関数（FSET など）を評価するときだけ付ける。note は検証の文書に添える説明
 *   - click: true（ボタンのクリックの模擬。計画 26 章）: expect はレコードごとの「押した後に変わる項目」（{ 項目コード: 後の値 }。項目コード順。テーブルは show の子の値の配列）
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
    section: "値・文字列・日付", pattern: "テーブルの文字列を 1 つの項目にまとめる",
    data: [{ テーブル1: [{ T1_文字列: "りんご" }, { T1_文字列: "" }, { T1_文字列: "みかん" }, { T1_文字列: "りんご" }] }, { テーブル1: [] }],
    formulas: [
      { formula: 'JOIN(TARRAYIF(T1_文字列 <> "", T1_文字列), "、")', expect: ["りんご、みかん、りんご", ""], note: "空の行を除き、順はそのまま、末尾に区切りは付かない" },
      { formula: 'JOIN(TARRAYIF(T1_文字列 <> "", T1_文字列), NEWLINE())', as: "MULTI_LINE_TEXT", expect: ["りんご\nみかん\nりんご", ""] },
      { formula: "CONCAT(T1_文字列)", expect: ["りんごみかんりんご", ""] },
      { formula: 'CONCAT(T1_文字列, "、")', expect: ["りんご、、みかん、りんご、", ""], note: "区切りは各行の後ろ（最後にも）。空の行は空のまま" },
      { formula: 'CONCATIF(T1_文字列 <> "", T1_文字列, "、")', expect: ["りんご、みかん、りんご、", ""], note: "空の行は除くが末尾の区切りは残る" },
      { formula: 'JOIN(TDS(T1_文字列), "、")', expect: ["みかん、りんご", ""], note: "重複を除いて並べ替える" },
      { formula: 'TEXTJOIN("、", 1, T1_文字列)', expect: ["りんご", ""], note: "テーブルの列には使えない（1 行目だけ）" }
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
    section: "値・文字列・日付", pattern: "日付の書式・加算・差", data: [{ 日付1: "2026-01-31", 日付2: "2026-03-01" }, { 日付1: "2027-12-15" }, { 日付1: "2028-01-31" }, { 日付1: "" }],
    formulas: [
      { formula: 'DATE_ENDOF(DATE_ADD(日付1, 1, "month"), "month")', as: "DATE", expect: ["2026-02-28", "2028-01-31", "2028-02-29", ""], note: "翌月末日（1 か月足してから月末。年またぎ、うるう年、空）" },
      { formula: 'DATE_STARTOF(DATE_ADD(日付1, 1, "month"), "month")', as: "DATE", expect: ["2026-02-01", "2028-01-01", "2028-02-01", ""], note: "翌月初" },
      { formula: 'DATE_FORMAT(日付1, "YYYY/MM/DD")', as: "TEXT", expect: ["2026/01/31", "2027/12/15", "2028/01/31", ""] },
      { formula: 'DATE_ADD(日付1, 1, "months")', as: "DATE", expect: ["2026-02-28", "2028-01-15", "2028-02-29", ""] },
      { formula: 'DATE_DIFF(日付1, 日付2, "days")', as: "NUMBER", expect: ["29", "-21166", "-21213", "0"], note: "引数は（前の日付, 後の日付）。逆にすると負の数。空の日付は 1970-01-01 として数えられる（両方空なら 0）ので、空は IF で分ける" },
      { formula: 'DATE_DIFF(日付2, 日付1, "days")', as: "NUMBER", expect: ["-29", "21166", "21213", "0"] },
      { formula: 'IF(AND(日付1, 日付2), DATE_DIFF(日付1, 日付2, "days"), "")', as: "NUMBER", expect: ["29", "", "", ""], note: "空を分けた形" }
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
  // ---- スペース項目（標本の sp1 を対象に。レコードに値が無いので返り値をそのまま。表示は実機） ----
  {
    section: "スペース項目", pattern: "文字を表示する（ラベルと値、書式）", data: [{ 日付1: "1996-01-15" }, { 日付1: "" }],
    formulas: [
      { formula: 'ARRAY("年齢", "", IF(日付1, DATE_DIFF(日付1, "TODAY", "years") & " 才"), "text-align:right;")', as: "sp1", expect: [["年齢", "", "30 才", "text-align:right;"], ["年齢", "", "", "text-align:right;"]], note: "返り値は 4 要素の配列。年齢は 2026 年の評価" },
      { formula: 'IF(日付1, ARRAY("年齢", "", DATE_DIFF(日付1, "TODAY", "years") & " 才", "text-align:right;"), ARRAY())', as: "sp1", expect: [["年齢", "", "30 才", "text-align:right;"], []], note: "ARRAY() は非表示" }
    ]
  },
  {
    section: "スペース項目", pattern: "HTML の表やまとめを表示する", data: [{ 文字列1: "架空商事", 数値1: 1234567 }],
    formulas: [
      { formula: 'LET(label, TAGS_HTML(TAG("style", JOIN(ARRAY(".custom-table td { border: 1px solid darkgray; padding: 4px 6px; }"), NEWLINE())), TAG("div", "概要")), table, TAGS_HTML(TAG("table", ATTR("class", "custom-table"), TAG("tr", TAG("td", "顧客名"), TAG("td", 文字列1)), TAG("tr", TAG("td", "合計"), TAG("td", FIXED(数値1), STYLE("text-align:right;"), IF(数値1 > 1000000, STYLE("color:red;")))))), ARRAY(label, "", table, ""))',
        as: "sp1", expect: [['<style>.custom-table td { border: 1px solid darkgray; padding: 4px 6px; }</style>\n<div>概要</div>', "", '<table  class="custom-table"><tr><td>顧客名</td><td>架空商事</td></tr><tr><td>合計</td><td  style="text-align:right; color:red;">1,234,567</td></tr></table>', ""]], note: "1 つの LET に label と table を並べる。STYLE は複数書けて 1 つの style 属性にまとまる" },
      { formula: 'TAGS_HTML(TAG("tr", ARRAY_MAP(ARRAY("A", "B"), v, TAG("th", v))))', expect: ["<tr><th>A</th><th>B</th></tr>"], note: "ARRAY_MAP で行や列を繰り返す（結果は TAG の配列。TAG の中に置くと並ぶ。配列をそのまま文字列の項目に入れると [object Object]）" }
    ]
  },
  {
    section: "スペース項目", pattern: "月のカレンダーを表示する（日曜は赤、土曜は青、基準日は黄色）", data: [{ 日付1: "2026-10-18" }, { 日付1: "2026-08-31" }],
    formulas: [{
      formula: `LET(
  基準日, 日付1,
  月初, DATE_STARTOF(基準日, "month", "YYYY-MM-DD"),
  月末, DATE_ENDOF(基準日, "month", "YYYY-MM-DD"),
  日数, DATE_DIFF(月初, 月末, "days") + 1,
  空き, MOD(DATE_DIFF("2023-01-01", 月初, "days"), 7),
  今日マス, 空き + DATE_DIFF(月初, 基準日, "days"),
  終マス, 空き + 日数 - 1,
  週数, ROUNDUP((空き + 日数) / 7, 0),
  css, TAG("style", JOIN(ARRAY(
    ".fml-cal { border-collapse: collapse; }",
    ".fml-cal th, .fml-cal td { border: 1px solid #ccc; width: 36px; height: 28px; text-align: center; }",
    ".fml-cal .sun { color: #d33; }",
    ".fml-cal .sat { color: #36c; }",
    ".fml-cal .today { background: #ffe58a; font-weight: bold; }"
  ), NEWLINE())),
  見出し, TAG("tr", ARRAY_MAP(ARRAY("日", "月", "火", "水", "木", "金", "土"), w, i,
    TAG("th", ATTR("class", IF(i = 0, "sun", IF(i = 6, "sat", ""))), w))),
  本体, ARRAY_FOR(週数, r, TAG("tr", ARRAY_FOR(7, c,
    TAG("td",
      ATTR("class", IF(r * 7 + c = 今日マス,
        IF(c = 0, "sun today", IF(c = 6, "sat today", "today")),
        IF(c = 0, "sun", IF(c = 6, "sat", "")))),
      IF(AND(r * 7 + c >= 空き, r * 7 + c <= 終マス), r * 7 + c - 空き + 1, ""))))),
  ARRAY(
    TAGS_HTML(css, TAG("div", DATE_FORMAT(月初, "YYYY年M月"))), "",
    TAGS_HTML(TAG("table", ATTR("class", "fml-cal"), 見出し, 本体)), ""
  )
)`,
      as: "sp1",
      expectIncludes: ['<div>2026年10月</div>', '<td  class=\\"\\">1</td><td  class=\\"\\">2</td><td  class=\\"sat\\">3</td>', '<td  class=\\"sun today\\">18</td>', '<td  class=\\"sat\\">31</td></tr></table>', '<div>2026年8月</div>', '<td  class=\\"sun\\">30</td><td  class=\\"today\\">31</td>'],
      note: "1 つの LET に 11 個の変数。基準日を TODAY() にすれば今月（再計算で変わる印が付く）。10 月は 5 週、8 月 31 日は 6 週目。実機で表示を確かめた（2026-10-18）"
    }]
  },
  {
    section: "スペース項目", pattern: "属性の値を条件で変える（class など）。& は関数の結果の空白を落とす", records: [3],
    formulas: [
      { formula: 'TAGS_HTML(TAG("td", ATTR("class", IF(1 = 1, "sun today", "sun")), "18"))', expect: ['<td  class="sun today">18</td>'] },
      { formula: '"sun" & IF(1 = 1, " today", "")', expect: ["suntoday"], note: "& は関数の結果の前後の空白を落とす" },
      { formula: '"sun" & " today"', expect: ["sun today"], note: "文字列と項目の空白は残る" },
      { formula: 'CONCAT("sun", IF(1 = 1, " today", ""))', expect: ["sun today"], note: "CONCAT は落とさない" },
      { formula: 'LET(a, 1, b, a + 1, c, b * 2, a & "-" & b & "-" & c)', expect: ["1-2-4"], note: "1 つの LET に変数を並べる（後の式で前の変数を使える）" }
    ]
  },
  // ---- 空・比較・端数の決まり（2026-10-18 Takashi「Go」で追加。どの式にも効く） ----
  {
    section: "空・比較・端数の決まり", pattern: "空の数値（計算は空のまま、比較は偽、空の判定）", data: [{ 数値1: "", 数値2: 10 }, { 数値1: 2.5, 数値2: 0 }],
    formulas: [
      { formula: "数値1 + 1", as: "NUMBER", expect: ["", "3.5"], note: "空の数値を計算すると空のまま" },
      { formula: 'IF(数値1 > 0, "正", "正でない")', expect: ["正でない", "正"], note: "空との比較は偽" },
      { formula: 'IF(数値1 = "", "空", "空でない")', expect: ["空", "空でない"] },
      { formula: 'ISBLANK(数値1) & "/" & NOT(数値1)', expect: ["true/true", "false/false"], note: "ISBLANK は複数の項目をまとめて判定できる" },
      { formula: 'IF(数値2, "値あり", "空か 0")', expect: ["値あり", "空か 0"], note: "IF(項目, …) は 0 も偽" },
      { formula: "1 / 数値2", as: "NUMBER", expect: ["0.1", ""], note: "ゼロ除算は空（エラーにならない）" }
    ]
  },
  {
    section: "空・比較・端数の決まり", pattern: "比較は、両方が数に見えれば数、そうでなければ文字順", data: [{ 文字列1: "2", 文字列2: "10" }, { 文字列1: "abc", 文字列2: "abd" }, { 文字列1: "2", 文字列2: "10a" }],
    formulas: [
      { formula: 'IF(文字列1 > 文字列2, "大きい", "小さい")', expect: ["小さい", "小さい", "大きい"], note: '"2" と "10" は数として比べる（2 < 10）。"2" と "10a" は文字順（"2" > "1"）' },
      { formula: 'IF(文字列1 * 1 > 文字列2 * 1, "数で大きい", "数で小さい")', expect: ["数で小さい", "数で小さい", "数で大きい"], note: '* 1 で数にする。数でない文字は空になる（"abc" * 1 → 空、"10a" * 1 → 空）ので比較は偽か逆になる' },
      { formula: 'IF(文字列1 = 2, "等しい", "違う")', expect: ["等しい", "違う", "等しい"], note: "数と文字の = も数として比べる" }
    ]
  },
  {
    section: "空・比較・端数の決まり", pattern: "端数と小数（10 進で計算。割った後は ROUND）", records: [3],
    formulas: [
      { formula: 'ROUND(2.5, 0) & "/" & ROUND(3.5, 0) & "/" & ROUND(-1.5, 0) & "/" & ROUND(-2.5, 0)', expect: ["3/4/-2/-3"], note: "ROUND は 0 から遠い方へ（四捨五入。銀行丸めでない）" },
      { formula: 'ROUNDDOWN(-2.5, 0) & "/" & ROUNDUP(-2.5, 0) & "/" & INT(-2.5) & "/" & MOD(-7, 3)', expect: ["-2/-3/-3/-1"], note: "ROUNDDOWN は 0 へ、ROUNDUP は 0 から遠い方へ、INT は小さい方へ、MOD の符号は割られる数" },
      { formula: 'ROUND(1.005, 2) & "/" & (0.1 + 0.2) & "/" & (12345.678 * 1.1)', expect: ["1.01/0.3/13580.2458"], note: "10 進で計算するので 2 進の誤差は出ない" },
      { formula: "1 / 3 * 3", as: "NUMBER", expect: ["0.99999999999999999999"], note: "割り切れない値は 20 桁。割った後は ROUND" },
      { formula: "ROUND(1 / 3 * 3, 10)", as: "NUMBER", expect: ["1"] }
    ]
  },
  // ---- 日付・時刻（曜日、年度、和暦、時刻の差、タイムゾーン） ----
  {
    section: "日付・時刻", pattern: "曜日（英語の略と日本語、休日の判定）", data: [{ 日付1: "2026-10-18" }, { 日付1: "2026-10-19" }, { 日付1: "" }],
    formulas: [
      { formula: 'DATE_FORMAT(日付1, "ddd")', expect: ["Sun", "Mon", ""], note: "曜日の名前は英語" },
      { formula: 'IF(日付1, ARRAY_GET(ARRAY("日", "月", "火", "水", "木", "金", "土"), DATE_FORMAT(日付1, "d") * 1), "")', expect: ["日", "月", ""], note: '"d" は 0（日曜）〜6。空は分ける' },
      { formula: 'IF(日付1, IF(IN(DATE_FORMAT(日付1, "d") * 1, 0, 6), "休日", "平日"), "")', expect: ["休日", "平日", ""] }
    ]
  },
  {
    section: "日付・時刻", pattern: "年度（4 月始まり）と和暦", data: [{ 日付1: "2026-10-18" }, { 日付1: "2026-03-31" }, { 日付1: "2019-04-30" }, { 日付1: "2019-05-01" }, { 日付1: "" }],
    formulas: [
      { formula: 'FISCAL_YEAR(日付1, "04-01")', as: "NUMBER", expect: ["2026", "2025", "2019", "2019", ""], note: "年度の始まりは月日で指定" },
      { formula: `LET(
  fDate, DATE_FORMAT(日付1),
  eDate, IFS(fDate >= "2019-05-01", "2019-01-01", fDate >= "1989-01-08", "1989-01-01", fDate >= "1926-12-25", "1926-01-01", fDate >= "1912-07-30", "1912-01-01", fDate >= "1868-01-25", "1868-01-01", ""),
  gengo, IFS(fDate >= "2019-05-01", "令和", fDate >= "1989-01-08", "平成", fDate >= "1926-12-25", "昭和", fDate >= "1912-07-30", "大正", fDate >= "1868-01-25", "明治", ""),
  IF(eDate, gengo & (DATE_DIFF(eDate, fDate, "years") + 1) & "年", "")
)`, expect: ["令和8年", "令和8年", "平成31年", "令和1年", ""], note: "記事 9f8eb7607fec4f22060a の式を 1 つの LET に。元号の開始日以上で判定、年は開始年の 1 月 1 日との差 + 1。「元年」にするなら年が 1 のときを IF で分ける" }
    ]
  },
  {
    section: "日付・時刻", pattern: "時刻項目の差（勤務時間など。日をまたぐとき）", data: [{ 時刻1: "09:30", 時刻2: "18:15" }, { 時刻1: "22:00", 時刻2: "06:00" }, { 時刻1: "", 時刻2: "" }],
    formulas: [
      { formula: 'DATE_DIFF(時刻1, 時刻2, "minutes")', as: "NUMBER", expect: ["NaN", "NaN", "0"], note: "時刻の項目を DATE_DIFF に渡すと NaN（日付が無いため。両方空なら 0）" },
      { formula: 'DURATION_AS(時刻2, "minutes") - DURATION_AS(時刻1, "minutes")', as: "NUMBER", expect: ["525", "-960", "0"], note: "DURATION_AS で分に。日をまたぐと負" },
      { formula: 'MOD(DURATION_AS(時刻2, "minutes") - DURATION_AS(時刻1, "minutes") + 1440, 1440)', as: "NUMBER", expect: ["525", "480", "0"], note: "日をまたぐなら 1440 を足して MOD。空は 0 になるので IF で分ける" },
      { formula: 'DURATION_FORMAT(DURATION(MOD(DURATION_AS(時刻2, "minutes") - DURATION_AS(時刻1, "minutes") + 1440, 1440), "minutes"), "%H時間 @m分")', expect: ["8時間 45分", "8時間 0分", "0時間 0分"], note: "表示は DURATION_FORMAT" }
    ]
  },
  {
    section: "日付・時刻", pattern: "日時の表示はタイムゾーンで変わる", data: [{ 日時1: "2026-10-18T09:30:00Z" }],
    formulas: [
      { formula: 'DATE_FORMAT(日時1, "YYYY-MM-DD HH:mm")', expect: ["2026-10-18 18:30"], note: "既定は利用者のタイムゾーン（検証の環境は Asia/Tokyo）" },
      { formula: 'DATE_FORMAT(日時1, "YYYY-MM-DD HH:mm", "UTC")', expect: ["2026-10-18 09:30"], note: "3 つ目の引数でタイムゾーン" }
    ]
  },
  // ---- 文字列の操作 ----
  {
    section: "文字列の操作", pattern: "長さ・切り出し・検索（位置の数え方に注意）", data: [{ 文字列2: "東京都千代田区" }],
    formulas: [
      { formula: 'LENGTH(文字列2) & "/" & LEFT(文字列2, 3) & "/" & RIGHT(文字列2, 3)', expect: ["7/東京都/代田区"], note: "長さは LENGTH（LEN は無い）" },
      { formula: 'MID(文字列2, 3, 4) & "/" & SUBSTR(文字列2, 3, 4)', expect: ["都千代田/千代田区"], note: "MID の位置は 1 から、SUBSTR は 0 から" },
      { formula: 'FIND(文字列2, "千代田") & "/" & FIND(文字列2, "大阪") & "/" & TEST(文字列2, "千代田")', expect: ["3/-1/true"], note: "FIND は 0 から数えた位置、無ければ -1。TEST は文字の有無（正規表現ではない）" },
      { formula: 'REPLACE(文字列2, "千代田", "港") & "/" & REPLACEALL(文字列2, ARRAY("東京", "大阪", "千代田", "北"))', expect: ["東京都港区/大阪都北区"] }
    ]
  },
  {
    section: "文字列の操作", pattern: "全角半角・空白・大文字小文字・ゼロ埋め・分割", data: [{ 文字列1: " ＡＢＣ-123-ｱｲｳ ", 数値1: 42 }],
    formulas: [
      { formula: 'ASC(文字列1) & "|" & JIS(文字列1)', expect: ["ABC-123-ｱｲｳ|ＡＢＣ－１２３－アイウ"], note: "ASC は全角 → 半角、JIS は半角 → 全角（2 つ目の引数で対象を絞れる。関数一覧）" },
      { formula: 'TRIM(文字列1) & "|" & UPPER("abc") & "|" & LOWER("ABC")', expect: ["ＡＢＣ-123-ｱｲｳ|ABC|abc"] },
      { formula: 'RIGHT("0000" & 数値1, 4) & "/" & REPEAT("*", 3)', expect: ["0042/***"], note: "ゼロ埋めは 0 を足して右から取る" },
      { formula: 'ARRAY_GET(SPLIT(TRIM(文字列1), "-"), 1) & "/" & ARRAY_COUNT(SPLIT(TRIM(文字列1), "-"))', expect: ["123/3"], note: "SPLIT で配列にして ARRAY_GET（0 から）" }
    ]
  },
  // ---- テーブルの検査 ----
  {
    section: "テーブルの検査", pattern: "重複・件数・条件に合う行の別項目・最大の行", data: [{ テーブル1: [{ T1_文字列: "a", T1_数値: 10 }, { T1_文字列: "b", T1_数値: 30 }, { T1_文字列: "a", T1_数値: 20 }, { T1_文字列: "", T1_数値: "" }] }],
    formulas: [
      { formula: 'IF(TDUPCK(T1_文字列), "重複あり", "重複なし")', expect: ["重複あり"], note: "TDUPCK は重複があれば true（2 つ目の引数 1 で空を数えない）" },
      { formula: 'COUNTROW(テーブル1) & "/" & COUNT(T1_数値) & "/" & COUNTA(T1_文字列)', expect: ["4/3/3"], note: "行数は COUNTROW、数値のある行は COUNT、空でない行は COUNTA" },
      { formula: 'LASTIF(T1_数値 = MAX(T1_数値), T1_文字列)', expect: ["b"], note: "最大の行の別の項目（同じ最大が複数なら最後の行）" },
      { formula: 'FIRSTIF(T1_文字列 = "a", T1_数値) & "/" & LASTIF(T1_文字列 = "a", T1_数値)', expect: ["10/20"], note: "条件に合う最初 / 最後の行の値" },
      { formula: 'ARRAY_COUNT(TARRAYIF(T1_数値 > 15, T1_数値))', as: "NUMBER", expect: ["2"], note: "条件に合う行の数（COUNTIF でも）" },
      { formula: 'IF(T1_数値 = MAX(T1_数値), "最大", "")', as: "T1_文字列", table: "テーブル1", expect: [["", "最大", "", ""]], note: "テーブルの中で全体の最大と比べる" }
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
  {
    section: "ユーザー情報", pattern: "上長・所属組織（ユーザー選択項目の上司を上司項目に。既定のテストデータの boss）",
    data: [{ ユーザー1: "demo_user02" }, { ユーザー1: "demo_user01" }, { ユーザー1: ["demo_user02", "demo_user03"] }, { ユーザー1: [] }],
    formulas: [
      { formula: 'IF(ユーザー1, SET_CODE(UINFO(SEL_CODE(ユーザー1, "text"), "#boss")), "")', as: "ユーザー2", expect: [[{ code: "demo_user01" }], [], [{ code: "demo_user01" }], []], note: "上司の無い人は空。2 人の上司が同じなら 1 人。空は空" },
      { formula: 'SET_CODE(UINFO(SEL_CODE(ユーザー1, "text"), "#boss"))', as: "ユーザー2", expect: [[{ code: "demo_user01" }], [], [{ code: "demo_user01" }], [{ code: "demo_user01" }, { code: "demo_user02" }, { code: "demo_user03" }]], note: "IF を省くと、空のときに全員の上司が入る" }
    ]
  },
  // ---- ボタン・イベント ----
  {
    section: "ボタン・イベント", pattern: "ボタンで項目をセットする（BUTTON + FSET）", data: [{ 数値1: 10 }, { 数値1: "" }], policy: { allowFunctions: ["BUTTON", "FSET"], allowMiscChanges: true },
    formulas: [
      { formula: 'BUTTON("加算", FSET(数値1, NVL(数値1, 0) + 1), FSET(文字列1, "押した"))', click: true, expect: [{ 数値1: "11", 文字列1: "押した" }, { 数値1: "1", 文字列1: "押した" }], note: "スペース項目に置く。押す前の表示は { TYPE: BUTTON, TITLE: 加算 }。押すと FSET の順に値が入り、全項目を再計算する。空の数値 + 1 は空のまま（空・比較・端数の決まり）なので NVL で 0 に" },
      { formula: 'BUTTON("加算", FSET(数値1, 数値1 + 1))', click: true, expect: [{ 数値1: "11" }, {}], note: "NVL が無いと、空の数値は押しても空のまま（変わる項目なし）" },
      { formula: 'BUTTON(BOPT("TITLE", "加算", "CSS", "{\'color\':\'white\',\'background-color\':\'#3498db\'}"), FSET(数値1, NVL(数値1, 0) + 1))', click: true, expect: [{ 数値1: "11" }, { 数値1: "1" }], note: "BOPT で色（CSS）。押した後の値は同じ" }
    ]
  },
  {
    section: "ボタン・イベント", pattern: "確認ダイアログの後にセットする（DIALOG + FSET）", data: [{ 数値1: 10 }], policy: { allowFunctions: ["DIALOG", "FSET"], allowMiscChanges: true },
    formulas: [
      { formula: 'DIALOG(ARRAY("確認", "数値1 に 1 を足します", "question"), FSET(数値1, 数値1 + 1))', click: true, expect: [{ 数値1: "11" }], note: "表示は TITLE / HTML / ICON（info / warning / question / success / error）/ キャンセルの有無（4 つ目。既定あり）。OK で FSET が走る。キャンセルなら何も変わらない" }
    ]
  },
  {
    section: "ボタン・イベント", pattern: "ボタンでテーブルに行を足す（BUTTON + FSET_TADD）", data: [{ テーブル1: [{ T1_数値: 1 }] }, { テーブル1: [] }], policy: { allowFunctions: ["BUTTON", "FSET_TADD"], allowMiscChanges: true },
    formulas: [
      { formula: "BUTTON(\"行を追加\", FSET_TADD(テーブル1, \"[{'T1_数値':'5','T1_文字列':'x'}]\"))", click: true, show: "T1_数値", expect: [{ テーブル1: ["1", "5"] }, { テーブル1: ["5"] }], note: "行の値は JSON の文字列（引用符は '）か配列。書かない子は空。0 行のテーブルにも足せる" }
    ]
  },
  {
    section: "ボタン・イベント", pattern: "ボタンでテーブルを空にする・行を置き換える・行数を指定する（BUTTON + FSET）", data: [{ テーブル1: T1_ROWS }, { テーブル1: [] }], policy: { allowFunctions: ["BUTTON", "DIALOG", "FSET"], allowMiscChanges: true },
    formulas: [
      { formula: 'DIALOG(ARRAY("クリア", "テーブルの行をすべて消します", "warning"), FSET(テーブル1, "0"))', click: true, show: "T1_数値", expect: [{ テーブル1: [] }, {}], note: "行数は文字列の \"0\"（数の 0 は何もしない）。0 行のテーブルは変わらない。消すと戻せないので DIALOG で確認（Ver.101 で MAX_TABLE_ROWS の未定義を直した）" },
      { formula: 'BUTTON("クリア", FSET(テーブル1, 0))', click: true, show: "T1_数値", expect: [{}, {}], note: "数の 0 は行数の指定にならず、何も起きない（テーブル自身の計算式の行数の制御と同じ決まり）" },
      { formula: 'BUTTON("2 行に", FSET(テーブル1, 2))', click: true, show: "T1_数値", expect: [{ テーブル1: ["100", "200"] }, { テーブル1: ["", ""] }], note: "行数の指定。多ければ後ろを消し、少なければ空の行を足す" },
      { formula: "BUTTON(\"置き換え\", FSET(テーブル1, ARRAY(\"\", \"[{'T1_数値':'7'},{'T1_数値':'8'}]\")))", click: true, show: "T1_数値", expect: [{ テーブル1: ["7", "8"] }, { テーブル1: ["7", "8"] }], note: "ARRAY(行数, 初期データ)。テーブル自身の計算式の行数の制御と同じ書き方。今の行は消えて初期データの行になる。JSON の文字列だけを FSET に渡しても何も起きない（行を足すのは FSET_TADD）" },
      { formula: 'BUTTON("絞る", FSET(テーブル1, TABLE_SORT(テーブル1, TPFILTER(T1_数値 > 150))))', click: true, show: "T1_数値", expect: [{ テーブル1: ["200", "300"] }, {}], note: "条件に合う行だけ残す（TABLE_SORT の結果をそのまま入れる）。0 行なら変わらない" }
    ]
  },
  {
    section: "ボタン・イベント", pattern: "イベントで結果を変える（既定は allUpdate）", records: [3],
    formulas: [{ formula: 'EV_INFO("type")', as: "TEXT", expect: ["allUpdate"] }]
  }
];
