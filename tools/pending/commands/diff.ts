/**
 * diff <before.json> <after.json> [--derived]
 * 既存設定の変更をインポートする前に人が見る差分（docs/authoring-plan.md 12.2、Codex MAJOR 8）。ボタン単位で、HTML 設定の行（CSS / HTML / 式は行の差分）、
 * 更新項目（項目ごとの state / 式）、共通 CSS、Web フォント、ルートの値を比べる。派生値（formula / usedFields / id / views / ルートの usedFields /
 * pluginUOG）は --derived を付けたときだけ。
 */
import { bodyOf } from "../normalize/derive.ts";
import { lineDiff, formatDiff } from "../normalize/line-diff.ts";
import { shortenDataUrls } from "./buttons.ts";

type Obj = Record<string, unknown>;
const DERIVED = new Set(["formula", "usedFields", "id", "views", "pluginUOG"]);
const ROW_SCALARS = ["state", "menu", "menu_en", "menu_ja", "menu_zh", "mcheck", "list", "authority", "guest", "users", "organizations", "groups", "desc", "desc_en", "desc_ja", "desc_zh", "remark", "viewsCsv"];
const TAGS_SCALARS = ["filecode", "pageSize", "orientation", "dpi", "printMode"];
const TAG_ROW_SCALARS = ["state", "desc", "remark", "fieldcode"];
const TAG_ROW_TEXTS = ["css", "html", "formulaSet"];

const show = (v: unknown): string => (v === undefined ? "（無し）" : JSON.stringify(v));

function scalarDiffs(a: Obj | undefined, b: Obj | undefined, keys: string[], out: string[], prefix: string): void {
  for (const k of keys) {
    const x = a?.[k];
    const y = b?.[k];
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${prefix}${k}: ${show(x)} → ${show(y)}`);
  }
}

function textDiff(label: string, a: string, b: string, out: string[]): void {
  if (a === b) return;
  out.push(`${label}:`);
  out.push(formatDiff(lineDiff(a, b)));
}

export function diffSettings(beforeEnvelope: Obj, afterEnvelope: Obj, opt: { derived?: boolean } = {}): string {
  const out: string[] = [];
  const a = bodyOf(beforeEnvelope);
  const b = bodyOf(afterEnvelope);
  // 封筒
  for (const k of ["appId", "appName", "PluginVersion"]) if (JSON.stringify(beforeEnvelope[k]) !== JSON.stringify(afterEnvelope[k])) out.push(`封筒 ${k}: ${show(beforeEnvelope[k])} → ${show(afterEnvelope[k])}`);
  // ルートの値
  scalarDiffs(a, b, ["pluginEnable", "pluginComment", "pluginDescription", "commonCssEnable", "externalRefs"], out, "");
  if (JSON.stringify(a.menuInfo) !== JSON.stringify(b.menuInfo)) out.push(`menuInfo: ${show(a.menuInfo)} → ${show(b.menuInfo)}`);
  if (JSON.stringify(a.fontInfo) !== JSON.stringify(b.fontInfo)) out.push(`Web フォント: ${show(a.fontInfo)} → ${show(b.fontInfo)}`);
  if (JSON.stringify(a.guestsInfo) !== JSON.stringify(b.guestsInfo)) out.push(`ゲスト: ${show(a.guestsInfo)} → ${show(b.guestsInfo)}`);
  // 共通 CSS（名前で）
  const cssA = new Map(((a.cssInfo ?? []) as Obj[]).map((c, i) => [String(c.name ?? i), c]));
  const cssB = new Map(((b.cssInfo ?? []) as Obj[]).map((c, i) => [String(c.name ?? i), c]));
  for (const name of new Set([...cssA.keys(), ...cssB.keys()])) {
    const x = cssA.get(name);
    const y = cssB.get(name);
    if (!x) out.push(`共通 CSS ${name}: 追加`);
    else if (!y) out.push(`共通 CSS ${name}: 削除`);
    else {
      scalarDiffs(x, y, ["state", "desc"], out, `共通 CSS ${name} / `);
      textDiff(`共通 CSS ${name} / css`, String(x.css ?? ""), String(y.css ?? ""), out);
    }
  }
  // ボタン（menu で対応付け。同名が複数なら順番）
  const key = (r: Obj, i: number, seen: Map<string, number>): string => {
    const base = String(r.menu ?? `#${i + 1}`);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  };
  const seenA = new Map<string, number>();
  const seenB = new Map<string, number>();
  const rowsA = new Map(((a.pluginInfos ?? []) as Obj[]).map((r, i) => [key(r, i, seenA), r]));
  const rowsB = new Map(((b.pluginInfos ?? []) as Obj[]).map((r, i) => [key(r, i, seenB), r]));
  for (const name of new Set([...rowsA.keys(), ...rowsB.keys()])) {
    const x = rowsA.get(name);
    const y = rowsB.get(name);
    const p = `ボタン ${name} / `;
    if (!x) {
      out.push(`ボタン ${name}: 追加`);
      continue;
    }
    if (!y) {
      out.push(`ボタン ${name}: 削除`);
      continue;
    }
    scalarDiffs(x, y, ROW_SCALARS, out, p);
    const tx = x.tagsInfo as Obj | undefined;
    const ty = y.tagsInfo as Obj | undefined;
    if (!!tx !== !!ty) out.push(`${p}HTML 設定: ${tx ? "削除" : "追加"}`);
    else if (tx && ty) {
      scalarDiffs(tx, ty, TAGS_SCALARS, out, `${p}HTML 設定 / `);
      const fa = (tx.fieldsInfo ?? []) as Obj[];
      const fb = (ty.fieldsInfo ?? []) as Obj[];
      for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
        const ra = fa[i];
        const rb = fb[i];
        const q = `${p}HTML 設定 ${i + 1} 行目 / `;
        if (!ra) {
          out.push(`${q}追加 (${show(rb?.desc)})`);
          continue;
        }
        if (!rb) {
          out.push(`${q}削除 (${show(ra.desc)})`);
          continue;
        }
        scalarDiffs(ra, rb, TAG_ROW_SCALARS, out, q);
        for (const k of TAG_ROW_TEXTS) textDiff(`${q}${k}`, String(ra[k] ?? ""), String(rb[k] ?? ""), out);
        if (opt.derived) scalarDiffs(ra, rb, ["id", "formula", "usedFields"], out, `${q}派生 `);
      }
    }
    const ca = new Map((((x.calcInfo as Obj | undefined)?.fieldsInfo ?? []) as Obj[]).map((c) => [String(c.fieldcode), c]));
    const cb = new Map((((y.calcInfo as Obj | undefined)?.fieldsInfo ?? []) as Obj[]).map((c) => [String(c.fieldcode), c]));
    for (const code of new Set([...ca.keys(), ...cb.keys()])) {
      const u = ca.get(code);
      const v = cb.get(code);
      const q = `${p}更新項目 ${code} / `;
      if (!u) {
        if (v?.state || v?.formulaSet) out.push(`${q}追加（state ${show(v?.state)}）`);
        continue;
      }
      if (!v) {
        if (u.state || u.formulaSet) out.push(`${q}削除`);
        continue;
      }
      scalarDiffs(u, v, ["state", "remark"], out, q);
      textDiff(`${q}formulaSet`, String(u.formulaSet ?? ""), String(v.formulaSet ?? ""), out);
      if (opt.derived) scalarDiffs(u, v, ["formula", "usedFields", "type", "ptcode"], out, `${q}派生 `);
    }
    if (opt.derived) scalarDiffs(x, y, ["id", "views"], out, `${p}派生 `);
  }
  if (opt.derived) scalarDiffs(a, b, ["usedFields", "pluginUOG"], out, "派生 ");
  const derivedNote = opt.derived ? "" : "（派生値 formula / usedFields / id / views / pluginUOG は除く。--derived で含める）";
  // 社印などの data: の URL（数千文字）は先頭と長さと SHA-256 の先頭だけにする（AI が読む量を減らす。2026-10-05 試用で気づいた）
  const body = shortenDataUrls(out.join("\n"), { hash: true });
  const dataNote = body.includes("…（data URL ") ? "（data: の URL は先頭・長さ・sha256 の先頭だけ）" : "";
  return out.length ? `${body}\n${derivedNote}${dataNote}`.trim() : `差分なし${derivedNote}`;
}

export const DERIVED_KEYS = DERIVED;
