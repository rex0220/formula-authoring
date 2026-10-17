/**
 * summary <settings.json> [--field <code>]
 * 設定ファイル（元の値 FormulaSource の封筒。設定画面のダウンロード / pull / AI が作ったもの）の要約。AI が設定ファイルを Read で丸ごと開かずに済むように
 * （print-craft-authoring の buttons に相当）。計算式は 1 行 80 字で切り、--field で 1 項目の計算式を全部出す。
 */
import { InputError } from "../input.ts";

export interface SourceRow {
  fieldcode: string;
  state: boolean;
  formulaSet: string;
  edit: boolean;
  hide: boolean;
  rank: number | string;
}

export interface Envelope {
  date?: string;
  pluginName?: string;
  pluginID?: string;
  PluginVersion?: string;
  appId?: number;
  appName?: string;
  [key: string]: unknown;
}

const ENVELOPE_KEYS = new Set(["date", "pluginName", "pluginID", "PluginVersion", "appId", "appName"]);

/** 封筒から本体（pluginInfos など）を取る。形の検査は normalize が行う（ここは要約なので緩い） */
export function bodyOf(envelope: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) if (!ENVELOPE_KEYS.has(k)) body[k] = v;
  return body;
}

export function rowsOf(body: Record<string, unknown>, file: string): SourceRow[] {
  const infos = body.pluginInfos;
  if (!Array.isArray(infos)) throw new InputError(`${file} は計算式プラグインの設定ではない（pluginInfos が無い）`);
  return infos.map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      fieldcode: String(o.fieldcode ?? ""),
      state: !!o.state,
      formulaSet: typeof o.formulaSet === "string" ? o.formulaSet : typeof o.formula === "string" ? o.formula : "",
      edit: !!o.edit,
      hide: !!o.hide,
      rank: typeof o.rank === "number" || typeof o.rank === "string" ? o.rank : ""
    };
  });
}

const oneLine = (s: string, max = 80): string => {
  const t = s.replace(/\r?\n/g, " ⏎ ").replace(/\s+/g, " ").trim();
  return [...t].length > max ? [...t].slice(0, max).join("") + "…" : t;
};

/** 計算の順（formula の deriveSemantic と同じ: ランクの大きい順、"" は 0、同じならレイアウトの順） */
const rankNum = (r: number | string): number => (r === "" ? 0 : Number(r) || 0);

/** 要約の本文 */
export function summarizeSettings(envelope: Record<string, unknown>, file: string, opt: { field?: string; defaults?: { misc?: Record<string, unknown> } } = {}): string {
  const env = envelope as Envelope;
  const body = bodyOf(envelope);
  const rows = rowsOf(body, file);
  const lines: string[] = [];
  lines.push(`${file}: ${env.pluginName ?? "?"} Ver.${env.PluginVersion ?? "?"}、アプリ ${env.appId ?? "?"} ${env.appName ?? ""}（${env.date ?? "日付なし"}）`);
  if (opt.field) {
    const r = rows.find((x) => x.fieldcode === opt.field);
    if (!r) throw new InputError(`${file} に項目 ${opt.field} の設定が無い`);
    lines.push(`${r.fieldcode}: ${r.state ? "有効" : "無効"}${r.edit ? "、編集可" : ""}${r.hide ? "、非表示" : ""}、ランク ${r.rank === "" ? "なし" : r.rank}`);
    lines.push("計算式:");
    lines.push(r.formulaSet || "（空）");
    return lines.join("\n");
  }
  const withFormula = rows.filter((r) => r.formulaSet.trim() !== "");
  const enabled = withFormula.filter((r) => r.state);
  lines.push(`項目 ${rows.length}、計算式あり ${withFormula.length}（有効 ${enabled.length}、無効 ${withFormula.length - enabled.length}）、編集可 ${rows.filter((r) => r.edit).length}、非表示 ${rows.filter((r) => r.hide).length}`);
  lines.push(`プラグイン ${body.pluginEnable === false ? "無効" : "有効"}、運用環境に反映 ${body.pluginProductEnv ? "する" : "しない"}、計算式ツール ${body.toolEnable === false ? "無効" : "有効"}${typeof body.pluginDescription === "string" && body.pluginDescription ? `、説明「${oneLine(body.pluginDescription, 40)}」` : ""}`);
  const misc = (body.pluginMiscInfo ?? {}) as Record<string, unknown>;
  const miscOn = Object.entries(misc).filter(([k, v]) => v === true && !(opt.defaults?.misc && opt.defaults.misc[k] === true)).map(([k]) => k);
  const miscOff = Object.entries(misc).filter(([k, v]) => v === false && opt.defaults?.misc && opt.defaults.misc[k] === true).map(([k]) => k);
  if (miscOn.length || miscOff.length) lines.push(`各種設定${opt.defaults?.misc ? "（既定と違うもの）" : "（ON）"}: ${[...miscOn.map((k) => `${k} ON`), ...miscOff.map((k) => `${k} OFF`)].join(", ")}`);
  const btn = (body.pluginBtnInfo ?? {}) as Record<string, { state?: boolean; default?: string }>;
  const btnOn = Object.entries(btn).filter(([, v]) => v && v.state).map(([k, v]) => `${k}（${v.default ?? ""}）`);
  if (btnOn.length) lines.push(`ボタン: ${btnOn.join(", ")}`);
  const list = (body.pluginListInfo ?? {}) as { all_enabled?: boolean; views?: Record<string, unknown> };
  if (list.all_enabled === false && list.views && Object.keys(list.views).length) lines.push(`一覧別設定: 一覧 ${Object.keys(list.views).join(", ")} だけ`);
  const auth = (body.authority ?? {}) as { everyone?: boolean; users?: Record<string, unknown>; organizations?: Record<string, unknown>; groups?: Record<string, unknown> };
  if (auth.everyone === false) lines.push(`権限設定: 全員ではない（ユーザー ${Object.keys(auth.users ?? {}).length}、組織 ${Object.keys(auth.organizations ?? {}).length}、グループ ${Object.keys(auth.groups ?? {}).length}）`);
  lines.push("計算式（計算の順 = ランクの大きい順。ランクなしは 0。同じならレイアウトの順。計算式は 80 字で切る。全文は --field <code>）:");
  const sorted = withFormula.map((r, i) => ({ r, i })).sort((a, b) => rankNum(b.r.rank) - rankNum(a.r.rank) || a.i - b.i).map((x) => x.r);
  for (const r of sorted) {
    lines.push(`  ${r.state ? "○" : "×"} ${r.rank === "" ? "  -" : String(r.rank).padStart(3)}  ${r.fieldcode}${r.edit ? " [編集可]" : ""}${r.hide ? " [非表示]" : ""}  ${oneLine(r.formulaSet)}`);
  }
  return lines.join("\n");
}
