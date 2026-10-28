/**
 * fv summary <settings.json> [--field <code>] / fv diff <before.json> <after.json>
 * 項目検証の設定ファイルの要約と差（設定ファイルを Read で開かないため。計算式の summary / diff と同じ役目）。
 * 設定画面のダウンロード（保存値つき）と元の値だけの封筒のどちらでも読む（元の値だけを見る）
 */
import { fvSourceOf, type FvSourceInfo } from "./model.ts";

const SHORT = 60;
const short = (s: string): string => {
  const one = s.replace(/\s*\n\s*/g, " ");
  return one.length > SHORT ? `${one.slice(0, SHORT)}…` : one;
};
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function rowLine(i: FvSourceInfo): string {
  const parts: string[] = [];
  if (i.formulaSet) parts.push(`必須条件 ${short(i.formulaSet)}`);
  if (i.disabledSet) parts.push(`入力不可 ${short(i.disabledSet)}`);
  if (i.hideSet) parts.push(`非表示 ${short(i.hideSet)}`);
  if (i.init) parts.push("初期化");
  const conds = i.condInfos.filter((c) => c.condSet || c.jaSet);
  if (conds.length) parts.push(`検証条件 ${conds.filter((c) => c.state).length}/${conds.length}`);
  const tbl = (i.tblfields ?? []).filter((t) => t.state);
  if (tbl.length) parts.push(`テーブル内非表示 ${tbl.map((t) => t.fieldcode).join(", ")}`);
  return `${i.state ? "○" : "－"} ${i.fieldcode}: ${parts.join("、") || "（式なし）"}`;
}

/** 要約（封筒、共通の設定、行ごとの式の有無と短い式）。field を渡すとその行の式の全文 */
export function fvSummarizeSettings(raw: unknown, file: string, opt: { field?: string } = {}): string {
  const data = isPlain(raw) ? raw : {};
  const s = fvSourceOf(data);
  const head = `${file}: 項目検証 Ver.${String(data.PluginVersion ?? "?")}、アプリ ${String(data.appId ?? "?")} ${String(data.appName ?? "")}、日時 ${String(data.date ?? "?")}`;
  if (opt.field) {
    const i = s.pluginInfos.find((x) => x.fieldcode === opt.field);
    if (!i) return `${head}\n${opt.field} の行は無い（行のある項目: ${s.pluginInfos.map((x) => x.fieldcode).join(", ")}）`;
    const lines = [head, `${i.fieldcode}（使う ${i.state ? "オン" : "オフ"}、初期化 ${i.init ? "オン" : "オフ"}）`, `  必須条件: ${i.formulaSet || "（なし）"}`, `  入力不可: ${i.disabledSet || "（なし）"}`, `  非表示: ${i.hideSet || "（なし）"}`];
    i.condInfos.forEach((c, n) => lines.push(`  検証条件 ${n + 1}（${c.state ? "オン" : "オフ"}）: 条件 ${c.condSet || "（なし）"}`, `    メッセージ 日 ${c.jaSet || "（なし）"} / 英 ${c.enSet || "（日と同じ）"} / 中 ${c.zhSet || "（日と同じ）"}`));
    for (const t of i.tblfields ?? []) if (t.state || t.hideSet) lines.push(`  テーブル内非表示 ${t.fieldcode}（${t.state ? "オン" : "オフ"}）: ${t.hideSet || "（なし）"}`);
    return lines.join("\n");
  }
  const borders = s.pluginBorderInfo.borderList ?? [];
  const common = [
    `有効 ${s.pluginEnable ? "オン" : "オフ"}、非表示前処理 ${s.pluginPreHide ? "オン" : "オフ"}、運用環境に反映 ${s.pluginProductEnv ? "オン" : "オフ"}`,
    `コメント ${s.pluginComment.length} 文字、NOTE ${s.pluginDescription.length} 文字、枠線 ${borders.length ? borders.map((b, n) => `${n + 1}:${b.state ? `${b.width}px ${b.color}` : "オフ"}`).join(" ") : "既定"}`
  ];
  const on = s.pluginInfos.filter((i) => i.state).length;
  return [head, ...common, `行 ${s.pluginInfos.length}（使う ${on}）。○ = 使う、－ = 使わない。式は ${SHORT} 文字で切る（--field <code> で全文）`, ...s.pluginInfos.map(rowLine)].join("\n");
}

export interface FvDiffResult {
  lines: string[];
  /** 変わった行の項目コード（足した・消したものを含む） */
  changed: string[];
}

/** 2 つの設定の差（共通の設定と行ごと。式は短くして並べる） */
export function fvDiffSettings(a: unknown, b: unknown, labels: { before: string; after: string }): FvDiffResult {
  const sa = fvSourceOf(isPlain(a) ? a : {});
  const sb = fvSourceOf(isPlain(b) ? b : {});
  const lines = [`差: ${labels.before} → ${labels.after}`];
  for (const k of ["pluginEnable", "pluginPreHide", "pluginProductEnv", "pluginComment", "pluginDescription", "pluginBorderInfo"] as const) {
    if (JSON.stringify(sa[k]) !== JSON.stringify(sb[k])) lines.push(`共通 ${k}: ${short(JSON.stringify(sa[k]))} → ${short(JSON.stringify(sb[k]))}`);
  }
  const before = new Map(sa.pluginInfos.map((i) => [i.fieldcode, i]));
  const after = new Map(sb.pluginInfos.map((i) => [i.fieldcode, i]));
  const changed: string[] = [];
  for (const code of new Set([...before.keys(), ...after.keys()])) {
    const x = before.get(code);
    const y = after.get(code);
    if (!x && y) { changed.push(code); lines.push(`+ ${rowLine(y)}`); continue; }
    if (x && !y) { changed.push(code); lines.push(`- ${rowLine(x)}`); continue; }
    if (!x || !y || JSON.stringify(x) === JSON.stringify(y)) continue;
    changed.push(code);
    lines.push(`~ ${code}`);
    if (x.state !== y.state) lines.push(`    使う: ${x.state ? "オン" : "オフ"} → ${y.state ? "オン" : "オフ"}`);
    for (const [k, label] of [["formulaSet", "必須条件"], ["disabledSet", "入力不可"], ["hideSet", "非表示"]] as const) {
      if (x[k] !== y[k]) lines.push(`    ${label}: ${short(x[k]) || "（なし）"} → ${short(y[k]) || "（なし）"}`);
    }
    if (x.init !== y.init) lines.push(`    初期化: ${x.init ? "オン" : "オフ"} → ${y.init ? "オン" : "オフ"}`);
    const n = Math.max(x.condInfos.length, y.condInfos.length);
    for (let i = 0; i < n; i++) {
      const c = x.condInfos[i], d = y.condInfos[i];
      if (JSON.stringify(c) === JSON.stringify(d)) continue;
      const show = (v: typeof c): string => (v ? `${v.state ? "オン" : "オフ"} ${short(v.condSet)} → ${short(v.jaSet)}` : "（なし）");
      lines.push(`    検証条件 ${i + 1}: ${show(c)}  ⇒  ${show(d)}`);
    }
    if (JSON.stringify(x.tblfields ?? []) !== JSON.stringify(y.tblfields ?? [])) {
      const t = (v: FvSourceInfo): string => (v.tblfields ?? []).filter((z) => z.state).map((z) => `${z.fieldcode}=${short(z.hideSet)}`).join(", ") || "（なし）";
      lines.push(`    テーブル内非表示: ${t(x)} → ${t(y)}`);
    }
  }
  if (lines.length === 1) lines.push("差は無い");
  return { lines, changed };
}
