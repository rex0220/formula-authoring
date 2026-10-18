/**
 * 資料の例の検証（計画 25.4。工程 8-4）: docs/計算パターン_検証.md を作る。
 *   1. 計算パターン集のケース（scripts/pattern-cases.mjs）を、同梱のサンプルアプリに項目を足した架空の値で trySettings に評価させ、期待と突き合わせる
 *   2. 関数一覧の使用例（エンジンの説明文の ex: の「式 -> 結果」）を評価して、合わない例と評価できない例を列挙する（work-link/formula-examples-check.mjs を取り込んだもの。
 *      項目や日時・kintone の文脈に依る例は合わない = 手で見る。結果の値は書かない（日時で変わる例があるため。一覧が同じなら最新）
 * gen-docs.mjs が呼ぶ。test/docs-sync.test.mjs が「生成物が最新」と「ケースが全部一致」を確かめる（エンジンの版が変わったときの回帰検査）
 */
import { PATTERN_CASES } from "./pattern-cases.mjs";

const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const isTable = (v) => Array.isArray(v) && v.every((r) => r && typeof r === "object" && "value" in r);
const json = (v) => (v === undefined ? "undefined" : JSON.stringify(v));

/** 1 ケースを評価して、式ごとの行を返す */
async function runCase(c, deps) {
  const { engine, trySettings, defaultUsersInfo } = deps;
  const policy = c.policy ? { allowFunctions: c.policy.allowFunctions ?? [], allowMiscChanges: c.policy.allowMiscChanges ?? false } : undefined;
  const r = await trySettings({
    engine, usersInfo: defaultUsersInfo(), usersOrigin: { kind: "default" }, policy,
    formulas: c.formulas.map(({ formula, as, table, click }) => ({ formula, as, table, click })), fields: c.fields, data: c.data, base: c.base, records: c.records
  });
  return c.formulas.map((f, i) => {
    const x = r.results[i];
    const got = x.values.map((v) => {
      if (f.click) {
        // クリックの模擬: 押した後に変わる項目（項目コード → 後の値。テーブルは show の子の値の配列）。項目コード順
        if (!v.click) return null;
        return Object.fromEntries(v.click.changes.map((l) => [l.fieldcode, f.show && isTable(l.after) ? l.after.map((row) => row.value?.[f.show]?.value) : l.after]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
      }
      let val = v.value;
      if (f.show && isTable(val)) val = val.map((row) => row.value?.[f.show]?.value);
      return val;
    });
    const errors = [...x.findings.filter((y) => y.level === "error").map((y) => `${y.rule}: ${y.message}`), ...x.values.map((v) => v.error).filter(Boolean), ...x.values.flatMap((v) => (v.click?.errors ?? []).map((e) => `click（${e.phases.join(", ")}）: ${e.message}`))];
    // expectIncludes: 長い HTML などは、結果の JSON に含まれるべき文字列で確かめる
    const match = x.status === "ok" && (f.expectIncludes ? f.expectIncludes.every((t) => json(got).includes(t)) : json(got) === json(f.expect));
    const target = x.target ? `${x.target.code}${x.target.table ? `（${x.target.table} の中）` : ""}${f.click ? "（クリック: 押した後に変わる項目）" : ""}${f.show ? ` → ${f.show}` : ""}` : "—";
    return { formula: f.formula, target, got, expect: f.expectIncludes ? `（含む）${f.expectIncludes.join(" / ")}` : f.expect, match, errors, note: f.note, records: r.app.records, extraFields: r.app.extraFields };
  });
}

/** 関数一覧の使用例を評価する（説明文の「式 -> 結果」）。結果は { total, ok, ng: [行], err: [行] } */
export function evaluateExamples(engine, quiet) {
  const api = engine.api;
  const docs = engine.functionDocs();
  const kf = api.createRunner({}, {}, "app.record.edit.show");
  const norm = (v) => JSON.stringify(v);
  const loose = (a, b) => String(a).replace(/^"|"$/g, "") === String(b).replace(/^"|"$/g, "");
  let total = 0, ok = 0;
  const ng = [], err = [];
  const tagLabel = { sideEffect: "副作用", kintoneContext: "kintone の文脈", userInfo: "ユーザー情報", event: "イベント", volatile: "再計算で変わる" };
  for (const name of Object.keys(docs).sort()) {
    const text = docs[name]?.ja;
    if (typeof text !== "string" || !text.includes("ex:")) continue;
    const tags = api.functionTagsOf(name).map((t) => tagLabel[t]).join("、");
    for (const line of text.split("\n").map((l) => l.trim()).filter((l) => l.includes(" -> "))) {
      const i = line.indexOf(" -> ");
      const expr = line.slice(0, i).trim();
      const expected = line.slice(i + 4).trim();
      total++;
      let result;
      try {
        engine.clearSinkCalls();
        result = quiet(() => {
          if (typeof kf.usedFields === "function") kf.usedFields({});
          return kf.dq(expr);
        });
      } catch {
        err.push(`${name}: ${line}${tags ? `（${tags}）` : ""}`);
        continue;
      }
      let exp = null;
      try { exp = norm(JSON.parse(expected)); } catch { exp = null; }
      const got = norm(result);
      const same = got === exp || loose(got, expected) || String(result) === expected || (exp !== null && JSON.stringify(String(result)) === exp) ||
        (typeof result === "number" && Number(expected) === result) || (typeof result === "string" && !isNaN(Number(result)) && !isNaN(Number(expected)) && Number(result) === Number(expected));
      if (same) ok++;
      else ng.push(`${name}: ${line}${tags ? `（${tags}）` : ""}`);
    }
  }
  engine.clearSinkCalls();
  return { total, ok, ng, err };
}

/**
 * 生成物（path → 本文）と要約。deps: { engine, trySettings, defaultUsersInfo, quiet, cases? }
 * 要約の ng が 0 でなければケースと期待のどちらかが変わった（試験が止める）
 */
export async function generateVerification(deps) {
  const cases = deps.cases ?? PATTERN_CASES;
  const ver = deps.engine.source.pluginVersion;
  const out = [];
  let formulas = 0, ok = 0;
  const sections = new Map();
  for (const c of cases) {
    const rows = await runCase(c, deps);
    formulas += rows.length;
    ok += rows.filter((r) => r.match).length;
    if (!sections.has(c.section)) sections.set(c.section, []);
    sections.get(c.section).push({ c, rows });
  }
  const ng = formulas - ok;
  out.push("# 計算パターンの検証（同梱のサンプルアプリと架空の値で評価した結果）");
  out.push("");
  out.push(`計算式プラグイン Ver.${ver} の計算式エンジンで、[計算パターン.md](計算パターン.md) の式の例（\`tools/scripts/pattern-cases.mjs\`）を \`try\`（同梱のサンプルアプリ 4329 に項目を足し、架空の値のレコードで 1 式ずつ）に評価させ、期待と突き合わせたもの。\`tools/scripts/gen-docs.mjs\` が作る。手で直さない。`);
  out.push(`ケース ${cases.length}、式 ${formulas}、一致 ${ok}、不一致 ${ng}。値は対象の型に入れた後の値（数値も文字列。テーブルの対象は子の値の配列）。複数の式の組（分類ごとの集計など）は、前の式の結果を架空の値に書いて 1 式ずつ確かめている。`);
  out.push("");
  for (const [section, items] of sections) {
    out.push(`## ${section}`);
    out.push("");
    for (const { c, rows } of items) {
      out.push(`### ${c.pattern}`);
      out.push("");
      const r0 = rows[0];
      const inputs = [];
      if (r0.extraFields.length) inputs.push(`足した項目: ${r0.extraFields.map(code).join("、")}`);
      if (c.data) inputs.push(`架空の値: ${c.data.map((d, i) => `d${i + 1} = ${code(json(d))}`).join("、")}`);
      if (c.records) inputs.push(`標本のレコード: ${c.records.join(", ")}`);
      if (c.policy) inputs.push(`policy: allowFunctions ${code(json(c.policy.allowFunctions ?? []))}`);
      if (inputs.length) out.push(inputs.map((l) => `- ${esc(l)}`).join("\n"));
      if (inputs.length) out.push("");
      out.push("| 式 | 対象 | 結果（レコードごと） | 期待 | 一致 | 注 |");
      out.push("| --- | --- | --- | --- | --- | --- |");
      for (const r of rows) {
        const note = [r.note, ...r.errors].filter(Boolean).join("。");
        const gotText = json(r.got);
        const shown = [...gotText].length > 300 ? `${[...gotText].slice(0, 300).join("")}…（${[...gotText].length.toLocaleString()} 字）` : gotText;
        out.push(`| ${code(esc(r.formula))} | ${esc(r.target)} | ${code(esc(shown))} | ${code(esc(typeof r.expect === "string" ? r.expect : json(r.expect)))} | ${r.match ? "✔" : "✘"} | ${esc(note)} |`);
      }
      out.push("");
    }
  }
  const ex = evaluateExamples(deps.engine, deps.quiet);
  out.push("## 関数一覧の使用例の評価");
  out.push("");
  out.push(`[関数一覧.md](関数一覧.md) の使用例（説明文の \`ex:\` の「式 -> 結果」）${ex.total} 件を項目の無い文脈で評価: 一致 ${ex.ok}、合わない ${ex.ng.length}、評価できない ${ex.err.length}。合わない・評価できない例は、項目・日時・ログインユーザー・kintone の文脈に依るもの（印を添えた）で、環境で変わる。結果の値は書かない（日時で変わるため。一覧が同じなら最新）。`);
  out.push("");
  if (ex.ng.length) {
    out.push("### 合わない例（手で見る）");
    out.push("");
    for (const l of ex.ng) out.push(`- ${code(esc(l))}`);
    out.push("");
  }
  if (ex.err.length) {
    out.push("### 評価できない例（項目や外部の情報が要る）");
    out.push("");
    for (const l of ex.err) out.push(`- ${code(esc(l))}`);
    out.push("");
  }
  const files = new Map([["docs/計算パターン_検証.md", out.join("\n")]]);
  return { files, summary: { cases: cases.length, formulas, ok, ng, examples: { total: ex.total, ok: ex.ok, ng: ex.ng.length, err: ex.err.length } } };
}
