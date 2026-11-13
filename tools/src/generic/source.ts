/**
 * 元の値（authoring API の契約の `{ common, rows }`）の操作。プラグインの名前も、行の中身の意味も知らない。
 * 行を直す・足す・消す・並べ替えるのは JSON の操作で、プラグインの API を呼ばない。決まりを確かめるのは check（check.ts）。
 * どの関数も、渡された値を書き換えずに新しい値を返す。
 *
 * 行のキーは位置で決まる（"01"、"02" …。API の toSource と check が振るのと同じ）。行を足す・消す・並べ替えると振り直す。
 */
import { createHash } from "node:crypto";

type Json = Record<string, unknown>;
export interface GenericSourceRow extends Json { key: string; state: boolean }
export interface GenericSource extends Json { common: Json; rows: GenericSourceRow[] }

export class SourceError extends Error {}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** キーの並びをそろえた JSON（plugin-config-kit の canonicalJson と同じ結果）。保存値の中身が同じかを比べる */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

/** 保存値・元の値の印（最後に検査を通ったものと同じかを確かめる） */
export function digestOfJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertSource(value: unknown): GenericSource {
  if (!isObject(value) || !isObject(value.common) || !Array.isArray(value.rows)) throw new SourceError("元の値は { common, rows } の形で書く");
  value.rows.forEach((r, i) => { if (!isObject(r)) throw new SourceError(`rows[${i}] はオブジェクトで書く`); });
  return value as GenericSource;
}

const keyOf = (index: number): string => String(index + 1).padStart(2, "0");

/** 行のキーを位置で振り直す */
export function renumber(source: GenericSource): GenericSource {
  const s = clone(assertSource(source));
  s.rows = s.rows.map((r, i) => ({ ...r, key: keyOf(i), state: r.state !== false }));
  return s;
}

function indexOfKey(source: GenericSource, key: string): number {
  const i = source.rows.findIndex((r) => String(r.key) === String(key));
  if (i < 0) throw new SourceError(`行が無い: ${key}（ある行: ${source.rows.map((r) => r.key).join(", ") || "なし"}）`);
  return i;
}

export function getRow(source: GenericSource, key: string): GenericSourceRow {
  const s = assertSource(source);
  return clone(s.rows[indexOfKey(s, key)]);
}

/** 行を入れ替える（キーはそのまま） */
export function setRow(source: GenericSource, key: string, row: Json): GenericSource {
  if (!isObject(row)) throw new SourceError("行はオブジェクトで書く");
  const s = clone(assertSource(source));
  const i = indexOfKey(s, key);
  s.rows[i] = { ...clone(row), key: s.rows[i].key, state: row.state !== false } as GenericSourceRow;
  return s;
}

/** 行の一部を直す（いちばん外側のキーだけを入れ替える。中の並びやオブジェクトは丸ごと替わる） */
export function patchRow(source: GenericSource, key: string, patch: Json): GenericSource {
  if (!isObject(patch)) throw new SourceError("直す内容はオブジェクトで書く");
  const s = assertSource(source);
  return setRow(s, key, { ...s.rows[indexOfKey(s, key)], ...clone(patch) });
}

/** 行を足す（position は 0 始まりの位置。省略すれば末尾）。足した行のキーを返す */
export function addRow(source: GenericSource, row: Json, position?: number): { source: GenericSource; key: string } {
  if (!isObject(row)) throw new SourceError("行はオブジェクトで書く");
  const s = clone(assertSource(source));
  const at = position === undefined ? s.rows.length : Math.min(Math.max(Math.trunc(position), 0), s.rows.length);
  s.rows.splice(at, 0, { ...clone(row), key: "", state: row.state !== false } as GenericSourceRow);
  return { source: renumber(s), key: keyOf(at) };
}

export function removeRow(source: GenericSource, key: string): GenericSource {
  const s = clone(assertSource(source));
  s.rows.splice(indexOfKey(s, key), 1);
  return renumber(s);
}

/** 行を動かす（position は動かした後の 0 始まりの位置） */
export function moveRow(source: GenericSource, key: string, position: number): { source: GenericSource; key: string } {
  const s = clone(assertSource(source));
  const [row] = s.rows.splice(indexOfKey(s, key), 1);
  const at = Math.min(Math.max(Math.trunc(position), 0), s.rows.length);
  s.rows.splice(at, 0, row);
  return { source: renumber(s), key: keyOf(at) };
}

/** 行の外の設定の一部を直す（いちばん外側のキーだけを入れ替える） */
export function patchCommon(source: GenericSource, patch: Json): GenericSource {
  if (!isObject(patch)) throw new SourceError("直す内容はオブジェクトで書く");
  const s = clone(assertSource(source));
  s.common = { ...s.common, ...clone(patch) };
  return s;
}

// ---- 要約と差分 ------------------------------------------------------------------------------------

const short = (v: unknown, max = 100): string => {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
/** 値を 1 行ずつの文にする（並びの要素は 1 行に 1 つ。state が false の要素は「－」を付ける） */
function linesOf(name: string, value: unknown, indent: string, out: string[]): void {
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    out.push(`${indent}${name}:`);
    value.forEach((x, i) => {
      if (isObject(x)) {
        const { state, ...rest } = x;
        out.push(`${indent}  ${state === false ? "－" : "・"}${i + 1} ${Object.entries(rest).filter(([, v]) => v !== "" && v !== false && v !== null && v !== undefined).map(([k, v]) => `${k}=${short(v, 80)}`).join(" ")}`);
      } else out.push(`${indent}  ・${i + 1} ${short(x)}`);
    });
    return;
  }
  if (isObject(value)) {
    const simple = Object.entries(value).filter(([, v]) => !Array.isArray(v) && !isObject(v));
    const nested = Object.entries(value).filter(([, v]) => Array.isArray(v) || isObject(v));
    const text = simple.filter(([, v]) => v !== "" && v !== false && v !== null && v !== undefined).map(([k, v]) => `${k}=${short(v, 80)}`).join(" ");
    if (text || nested.length > 0) out.push(`${indent}${name}: ${text}`);
    for (const [k, v] of nested) linesOf(k, v, `${indent}  `, out);
    return;
  }
  if (value !== "" && value !== false && value !== null && value !== undefined) out.push(`${indent}${name}: ${short(value)}`);
}

/** 元の値の要約（行ごとの見出しと中身）。中身の読み方はプラグインの資料（設定ファイル仕様）に書く */
export function summarizeSource(source: GenericSource): string {
  const s = assertSource(source);
  const out: string[] = [`行 ${s.rows.length}（有効 ${s.rows.filter((r) => r.state !== false).length}）`];
  out.push("[行の外の設定]");
  for (const [k, v] of Object.entries(s.common)) linesOf(k, v, "  ", out);
  for (const r of s.rows) {
    const { key, state, ...rest } = r;
    out.push(`[行 ${key}] ${state === false ? "無効" : "有効"}${typeof rest.name === "string" && rest.name ? ` ${rest.name}` : ""}`);
    for (const [k, v] of Object.entries(rest)) if (k !== "name") linesOf(k, v, "  ", out);
  }
  return out.join("\n");
}

function pathsOf(a: unknown, b: unknown, p: string, out: string[]): void {
  if (canonicalJson(a) === canonicalJson(b)) return;
  if (isObject(a) && isObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) pathsOf(a[k], b[k], p ? `${p}.${k}` : k, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => pathsOf(x, b[i], `${p}[${i}]`, out));
    return;
  }
  out.push(`${p}: ${short(a, 60)} → ${short(b, 60)}`);
}

export interface SourceDiff {
  common: string[];
  rows: Array<{ change: "added" | "removed" | "changed"; before?: string; after?: string; name?: string; paths: string[] }>;
}

/** 2 つの行がどれだけ似ているか（いちばん外側のキーのうち、中身が同じものの割合。name が同じなら足す。名前だけ変えた行も「変わった」と見るので、違っても引かない） */
function similarity(a: GenericSourceRow, b: GenericSourceRow): number {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "key");
  if (keys.length === 0) return 0;
  const same = keys.filter((k) => canonicalJson(a[k]) === canonicalJson(b[k])).length / keys.length;
  const na = typeof a.name === "string" ? a.name : "";
  const nb = typeof b.name === "string" ? b.name : "";
  return same + (na && na === nb ? 1 : 0);
}

/**
 * 元の値の差分。行は、中身が同じものを先に対にし（位置がずれても「変わっていない」）、残りは似ているもの同士を対にして、変わった所を出す。
 * 対にならなかった行は、足した・消した。**残りの対の決め方は目安**（name が同じ行、次に中身の近い行。半分より多く違う行は別の行と見る）
 */
export function diffSource(before: GenericSource, after: GenericSource): SourceDiff {
  const a = assertSource(before);
  const b = assertSource(after);
  const body = (r: GenericSourceRow): string => { const { key: _k, ...rest } = r; return canonicalJson(rest); };
  const ka = a.rows.map(body);
  const kb = b.rows.map(body);
  // 同じ中身の行の、いちばん長い共通の並び（LCS）
  const n = ka.length;
  const m = kb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const restA: number[] = [];
  const restB: number[] = [];
  const out: SourceDiff = { common: [], rows: [] };
  const flush = (): void => {
    // 似ているもの同士を、似ている順に対にする
    const cands: Array<{ ia: number; ib: number; score: number }> = [];
    for (const ia of restA) for (const ib of restB) cands.push({ ia, ib, score: similarity(a.rows[ia], b.rows[ib]) });
    cands.sort((x, y) => y.score - x.score || x.ia - y.ia || x.ib - y.ib);
    const usedA = new Set<number>();
    const usedB = new Set<number>();
    const found: Array<{ ia: number; ib: number }> = [];
    for (const c of cands) {
      if (c.score <= 0.5 || usedA.has(c.ia) || usedB.has(c.ib)) continue;
      usedA.add(c.ia);
      usedB.add(c.ib);
      found.push({ ia: c.ia, ib: c.ib });
    }
    const nameOf = (r: GenericSourceRow): string | undefined => (typeof r.name === "string" ? r.name : undefined);
    const group: Array<{ at: number; row: SourceDiff["rows"][number] }> = [];
    for (const { ia, ib } of found) {
      const paths: string[] = [];
      const { key: _ka, ...ba } = a.rows[ia];
      const { key: _kb, ...bb } = b.rows[ib];
      pathsOf(ba, bb, "", paths);
      group.push({ at: ib, row: { change: "changed", before: a.rows[ia].key, after: b.rows[ib].key, name: nameOf(b.rows[ib]), paths } });
    }
    for (const ib of restB) if (!usedB.has(ib)) group.push({ at: ib, row: { change: "added", after: b.rows[ib].key, name: nameOf(b.rows[ib]), paths: [] } });
    // 今の並びの順に出し、消した行は後ろに
    group.sort((x, y) => x.at - y.at);
    for (const x of group) out.rows.push(x.row);
    for (const ia of restA) if (!usedA.has(ia)) out.rows.push({ change: "removed", before: a.rows[ia].key, name: nameOf(a.rows[ia]), paths: [] });
    restA.length = 0;
    restB.length = 0;
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && ka[i] === kb[j]) { flush(); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) restB.push(j++);
    else restA.push(i++);
  }
  flush();
  pathsOf(a.common, b.common, "", out.common);
  return out;
}

export function renderDiff(d: SourceDiff): string {
  const out: string[] = [];
  if (d.common.length === 0 && d.rows.length === 0) return "差分なし";
  if (d.common.length > 0) { out.push("[行の外の設定]"); for (const p of d.common) out.push(`  ${p}`); }
  for (const r of d.rows) {
    const name = r.name ? ` ${r.name}` : "";
    if (r.change === "added") out.push(`[行 ${r.after}] 足した${name}`);
    else if (r.change === "removed") out.push(`[前の行 ${r.before}] 消した${name}`);
    else { out.push(`[行 ${r.after}${r.before !== r.after ? `（前は ${r.before}）` : ""}] 変わった${name}`); for (const p of r.paths) out.push(`  ${p}`); }
  }
  return out.join("\n");
}
