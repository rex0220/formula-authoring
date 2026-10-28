/**
 * 項目検証の資料の機械生成（field-validation/docs/オーサリングツール_実装計画.md の段階 3）。gen-docs.mjs から呼ぶ。test/docs-sync.test.mjs が最新か確かめる。
 *   docs/項目検証/設定ファイル仕様.md       … 封筒と元の値のキー、列ごとに置けない型、書かないキー、更新系の関数、扱う版（tools の src/fv/ の決まりから）
 *   docs/項目検証/検証パターン.md           … fv-patterns.mjs のパターンを、サンプルアプリで fv normalize → fv check に通した結果（✔ / ✘）
 *   samples/項目検証/settings-source.json  … 雛形（重ならないパターンを合わせて fv normalize で書き出したもの）
 * サンプルアプリは samples/項目検証/fields-sample.json（経費申請（架空）。手で書いたもの）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { FV_PATTERNS, FV_SAMPLE_PATTERNS } from "./fv-patterns.mjs";

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s) => (s ? `\`${esc(s)}\`` : "");
const ARRAY_TYPES = new Set(["CHECK_BOX", "MULTI_SELECT", "USER_SELECT", "ORGANIZATION_SELECT", "GROUP_SELECT", "FILE"]);
const DEFAULT_EVENT = "app.record.index.edit.change";
/** 生成物に日時を入れない（いつ作っても同じ） */
const FIXED_NOW = () => new Date(2026, 9, 28, 9, 0, 0);

/** サンプルアプリのレコード（kintone の形。書かない項目は空。テーブルは 明細 の行） */
function recordOf(fields, values = {}, rows = []) {
  const rec = {};
  for (const [c, p] of Object.entries(fields.properties)) {
    if (p.type === "GROUP") continue;
    if (p.type === "SUBTABLE") {
      rec[c] = { type: "SUBTABLE", value: rows.map((r, i) => ({ id: String(i + 1), value: Object.fromEntries(Object.entries(p.fields).map(([k, f]) => [k, { type: f.type, value: r[k] ?? (ARRAY_TYPES.has(f.type) ? [] : "") }])) })) };
      continue;
    }
    rec[c] = { type: p.type, value: values[c] ?? (ARRAY_TYPES.has(p.type) ? [] : "") };
  }
  return rec;
}

/** 期待の文（null は印なし） */
function expectText(exp) {
  if (exp === null) return "印なし";
  const parts = [];
  for (const [k, label] of [["hidden", "非表示"], ["disabled", "入力不可"], ["required", "必須"]]) if (k in exp) parts.push(exp[k] ? label : `${label}でない`);
  if ("errors" in exp) parts.push(exp.errors.length ? `誤り「${exp.errors.join("」「")}」` : "誤りなし");
  if ("reset" in exp) parts.push(exp.reset ? `保存の前に ${exp.reset.lookup === "CLEAR" ? "ルックアップを解除して " : ""}${JSON.stringify(exp.reset.value)} を入れる` : "入れる値なし");
  return parts.join("、");
}

/** 1 つの期待を判定の行と比べる（書いたキーだけ。null は「行が無いか、印が無い」） */
function matches(line, exp) {
  if (exp === null) return !line || (!line.hidden && !line.disabled && !line.required && !line.errors.length && !line.reset);
  if (!line) return false;
  const got = { hidden: line.hidden, disabled: line.disabled, required: line.required, errors: line.errors, reset: line.reset };
  return Object.keys(exp).every((k) => JSON.stringify(got[k]) === JSON.stringify(exp[k]));
}

function settingText(i) {
  const parts = [];
  if (i.formulaSet) parts.push(`必須条件 ${code(i.formulaSet)}`);
  if (i.disabledSet) parts.push(`入力不可 ${code(i.disabledSet)}`);
  if (i.hideSet) parts.push(`非表示 ${code(i.hideSet)}`);
  if (i.init) parts.push("初期化オン");
  (i.condInfos ?? []).forEach((c, n) => parts.push(`検証条件 ${n + 1}: 条件 ${code(c.condSet)} → メッセージ 日 ${code(c.jaSet)}${c.enSet ? ` / 英 ${code(c.enSet)}` : ""}${c.zhSet ? ` / 中 ${code(c.zhSet)}` : ""}`));
  for (const t of i.tblfields ?? []) parts.push(`テーブル内非表示 ${t.fieldcode}: ${code(t.hideSet)}`);
  return parts.join("<br>") || "（式なし。「使う」をオン）";
}

export async function generateFvDocs({ engine, fv, defaultUsersInfo, repo }) {
  const files = new Map();
  const fields = JSON.parse(readFileSync(path.join(repo, "samples", "項目検証", "fields-sample.json"), "utf8"));
  const latest = fv.FV_ENGINES[fv.FV_ENGINES.length - 1];
  const envelope = (infos) => ({ pluginID: fv.FV_CONFIG_PLUGIN_ID, PluginVersion: String(latest.fvVersion), appId: fields.appId, appName: fields.appName, pluginInfos: infos });
  const usersInfo = defaultUsersInfo();
  const usersOrigin = { kind: "default" };
  const normalize = (infos, name) => fv.fvNormalizeSettings({ settingsText: JSON.stringify(envelope(infos)), settingsFile: name, fields, engine, usersInfo, usersOrigin, now: FIXED_NOW });

  // 1. 検証パターン
  const summary = { patterns: 0, cases: 0, checks: 0, ok: 0, ng: 0 };
  const md = [
    "# 検証パターン（項目検証）",
    "",
    "<!-- tools/scripts/gen-fv-docs.mjs が作る（元は tools/scripts/fv-patterns.mjs）。手で直さない -->",
    "",
    "項目検証の設定の「やりたいこと」ごとの書き方です。どの例も、サンプルアプリ [samples/項目検証/fields-sample.json](../../samples/項目検証/fields-sample.json)（経費申請（架空））で `fv normalize` → `fv check` に通し、期待と合うかを確かめてあります（✔ = 合う）。",
    "自分のアプリでは、項目コードを読み替えて使い、`fv check` で確かめます。",
    "",
    "- 式は計算式プラグインと同じ言語です（関数は [docs/関数一覧.md](../関数一覧.md)）。条件は真（true・0 以外の数・空でない文字列）のとき効きます",
    "- メッセージも式です。文は `\"…\"` で囲みます（`&` で項目の値をつなげる）",
    "- イベントの既定は `app.record.index.edit.change`（一覧編集向けの判定と同じ）。初期化（保存の前に入れる値）は `…submit` のときだけ出ます",
    "- 判定の表の「印なし」は、非表示・入力不可・必須・誤り・入れる値のどれも無いこと（「使う」がオフの項目は判定しない）",
    ""
  ];
  for (const p of FV_PATTERNS) {
    summary.patterns++;
    const n = await normalize(p.infos, p.id);
    const errs = n.findings.items.filter((f) => f.level === "error");
    const warns = [...new Set(n.findings.items.filter((f) => f.level === "warning").map((f) => f.rule))];
    md.push(`## ${p.id} ${p.title}`, "", p.want, "");
    if (p.infos.length) {
      md.push("| 項目 | 設定 |", "| --- | --- |");
      for (const i of p.infos) md.push(`| ${esc(i.fieldcode)} | ${settingText(i)} |`);
      md.push("");
    }
    md.push(`fv normalize: エラー ${errs.length}${warns.length ? `、警告 ${warns.join(", ")}` : ""}${errs.length ? `（${errs.map((e) => esc(e.message)).join(" / ")}）` : ""}`, "");
    md.push("| ケース | イベント | 項目 | 期待 | 結果 |", "| --- | --- | --- | --- | --- |");
    for (const c of p.cases) {
      summary.cases++;
      const event = c.event ?? DEFAULT_EVENT;
      let lines = [];
      if (!errs.length) {
        const r = fv.fvCheckSettings({ normalized: n, engine, fields, appId: fields.appId, records: [{ id: "1", record: recordOf(fields, c.values, c.rows) }], events: [event], lang: c.lang, usersInfo, usersOrigin, all: true });
        lines = r.records[0].events[0].lines;
      }
      for (const [field, exp] of Object.entries(c.expect)) {
        summary.checks++;
        const line = lines.find((l) => l.field === field);
        const ok = !errs.length && matches(line, exp);
        if (ok) summary.ok++;
        else summary.ng++;
        md.push(`| ${esc(c.label)}${c.lang ? `（${c.lang}）` : ""} | ${event} | ${esc(field)} | ${esc(expectText(exp))} | ${ok ? "✔" : `✘ ${esc(line ? fv.renderFvLine(line) : "行が無い")}`} |`);
      }
    }
    md.push("");
  }
  md.push(`パターン ${summary.patterns}、ケース ${summary.cases}、確かめた項目 ${summary.checks}（✔ ${summary.ok}、✘ ${summary.ng}）。計算式 Ver.${engine.source.pluginVersion} の zip のエンジンで評価。`, "");
  files.set("docs/項目検証/検証パターン.md", md.join("\n"));

  // 2. 雛形（重ならないパターンを合わせる）
  const sampleInfos = FV_PATTERNS.filter((p) => FV_SAMPLE_PATTERNS.includes(p.id)).flatMap((p) => p.infos);
  const sample = await normalize(sampleInfos, "samples/項目検証/settings-source.json");
  if (!sample.output) throw new Error(`雛形が fv normalize に通らない: ${sample.summary}`);
  files.set("samples/項目検証/settings-source.json", JSON.stringify(sample.output, null, 2) + "\n");

  // 3. 設定ファイル仕様
  const update = [...fv.fvUpdateFunctions(engine.api.FUNCTION_TAGS.sideEffect ?? [])];
  const deny = fv.FV_COLUMN_DENY;
  const spec = [
    "# 設定ファイル仕様（項目検証）",
    "",
    "<!-- tools/scripts/gen-fv-docs.mjs が作る（tools の src/fv/ の決まりから）。手で直さない -->",
    "",
    `項目検証プラグイン（rex0220 field validation）Ver.${fv.FV_MIN_VERSION} 以降の設定ファイルの形です。AI は**封筒 + 元の値**だけを書きます（雛形 [samples/項目検証/settings-source.json](../../samples/項目検証/settings-source.json)）。`,
    "設定画面の「設定をダウンロード」のファイルは保存値（派生値・内部番号）も入っていますが、取り込みは元の値だけを使うので、`fv normalize` はそれらを捨てます。",
    "",
    "## 封筒",
    "",
    "| キー | 値 |",
    "| --- | --- |",
    `| \`pluginID\` | \`"${fv.FV_CONFIG_PLUGIN_ID}"\`（違えば取り込めない） |`,
    `| \`PluginVersion\` | 項目検証の版の数の文字列（\`"${latest.fvVersion}"\` など。${fv.FV_MIN_VERSION} 未満はエラー） |`,
    "| `appId` | アプリ番号（数。`fields` のアプリと同じ） |",
    "| `appName` / `pluginName` / `date` | 任意（`fv normalize` の出力では補う） |",
    "",
    "## 元の値（封筒と同じ階層）",
    "",
    "| キー | 型 | 既定 | 意味 |",
    "| --- | --- | --- | --- |",
    "| `pluginEnable` | true / false | true | プラグインを有効にする |",
    "| `pluginPreHide` | true / false | false | 非表示前処理（非表示の式がある項目を、画面を開いたときに先に隠す。ほかのプラグインと競合するときは外す） |",
    "| `pluginProductEnv` | true / false | false | 設定画面で保存するとき「運用環境に反映」もする |",
    "| `pluginComment` / `pluginDescription` | 文字列 | \"\" | NOTE（ツールバーの 1 行）/ 説明（「説明」のダイアログ） |",
    `| \`pluginBorderInfo\` | \`{ borderList: [行 × 3 まで] }\` | {}（既定の枠線） | 枠線。行は \`state\` / \`btype\`（区分の文言）/ \`width\`（0〜8 の整数）/ \`color\`（#rrggbb）。順は ${["必須で未入力", "必須で入力済み", "エラー"].map((x, i) => `${i + 1} ${x}（既定 ${fv.FV_BORDER_DEFAULTS[i].width}px ${fv.FV_BORDER_DEFAULTS[i].color}）`).join("、")} |`,
    "| `pluginInfos` | 行の配列 | [] | 項目ごとの設定（下）。書かない項目は設定なし。フォームで必須の項目は、書かなくても必須条件 `\"1\"` の行になる |",
    "",
    "## 行（`pluginInfos` の要素）",
    "",
    "| キー | 型 | 意味 |",
    "| --- | --- | --- |",
    "| `fieldcode` | 文字列 | 行の識別（必須）。項目はフィールドコード、スペース・ラベル・罫線は `\"(要素ID)\"`、テーブルの行の追加・削除ボタンは `\"<テーブル>($ADD)\"` / `\"<テーブル>($DEL)\"`、グループはグループのフィールドコード。同じ行を 2 つ書かない |",
    "| `state` | true / false | 「使う」。オフの行の式は効かない |",
    "| `formulaSet` | 式 | 必須条件（真のとき必須。フォームで必須の項目は `\"1\"` に固定） |",
    "| `disabledSet` | 式 | 入力不可（真のとき入力できない） |",
    "| `hideSet` | 式 | 非表示（真のとき隠す） |",
    "| `init` | true / false | 初期化（隠れたまま保存するとき初期値に戻す。初期値が空のルックアップは、隠れて値があれば解除する） |",
    "| `condInfos` | 検証条件の配列 | 上から見て、「使う」がオンで条件が真の最初の 1 つのメッセージでエラーにする。キーは `state` / `condSet`（条件の式）/ `jaSet` / `enSet` / `zhSet`（メッセージの式。英・中が空なら日）。オンなら条件とメッセージ（日）は必須 |",
    "| `tblfields` | テーブル内非表示の配列 | テーブルの行だけ。子の列を隠す。キーは `fieldcode`（子）/ `state` / `hideSet`（式）。書かない子は設定なし |",
    "",
    "旧い形のキー `formula` / `disabled` / `hide`（行）、`cond` / `ja` / `en` / `zh`（検証条件）も読みます（出力は新しい形）。",
    "",
    "## 列ごとに置けない型",
    "",
    "| 列 | 置けない型 |",
    "| --- | --- |",
    `| 必須条件 \`formulaSet\`・入力不可 \`disabledSet\` | ${deny.formulaSet.join(", ")} |`,
    `| 初期化 \`init\` | ${deny.init.join(", ")} |`,
    `| 検証条件 \`condInfos\` | ${deny.condInfos.join(", ")} |`,
    "| テーブル内非表示 `tblfields` | テーブル（SUBTABLE）の行のほか全部 |",
    "| 非表示 `hideSet` | どの行にも置ける |",
    "",
    `行になる型: ${fv.FV_TARGET_TYPES.join(", ")}。要素 ID の行: ${fv.FV_ELEMENT_TYPES.join(", ")}（要素 ID があるもの）。行のボタン: \`${fv.FV_BUTTON_TYPE}\`。`,
    "",
    "## 書かないキー",
    "",
    `保存値のキー（${fv.FV_DERIVED_KEYS.map((k) => `\`${k}\``).join(", ")}）、外枠のキー（\`pluginLastUpdate\` など）、行の画面・保存のキー（\`id\` / \`type\` / \`usedFields\` / \`condDesc\` / \`fieldno\` など）。設定画面が保存のときに作るので書かない（書いてあっても捨てる）。`,
    "",
    "## 式の決まり",
    "",
    `- 項目検証では使わない更新系の関数（\`fv normalize\` のエラー \`formula.update\`。「使う」がオフの行でも）: ${update.map((f) => `\`${f}\``).join(", ")}`,
    "- 保存のとき、式の `//` から行末までと改行が消える（文字列の中も）。`\"https://…\"` のような文字列は切れて式が壊れる",
    "- 式は表示・値の変更・保存の前・一覧の編集のたびに評価される。`TODAY` / `NOW` / `RAND` などは評価のたびに変わる（警告 `formula.volatile`）",
    "",
    "## 扱う版",
    "",
    `- 設定: 項目検証 Ver.${fv.FV_MIN_VERSION} 以降（取り込み方「全置換 / 項目の置換」と元の値の形が Ver.${fv.FV_MIN_VERSION} から）`,
    `- 式の評価: 計算式プラグインの zip Ver.${fv.FV_MIN_FORMULA_VERSION} 以降（試用版でよい）。項目検証の版に同梱のエンジンと違えば、情報 \`engine.differs\` を出して続ける`,
    "",
    "| 項目検証 | 同梱のエンジン（計算式の版） |",
    "| --- | --- |",
    ...fv.FV_ENGINES.map((e) => `| Ver.${e.fvVersion} | 計算式 Ver.${e.formulaVersion}（engine sha256 \`${e.engineSha256.slice(0, 12)}…\`） |`),
    ""
  ];
  files.set("docs/項目検証/設定ファイル仕様.md", spec.join("\n"));
  return { files, summary };
}
