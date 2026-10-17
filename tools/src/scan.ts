/**
 * 計算式の字面の走査（dq の前。オーサリングツール_実装計画.md 2 章「評価の安全」、6 章の順序）。
 * 入力は stripFormula の後の文字列（コメントと改行を除いたもの。設定画面と同じ規則: 文字列の中の // も行末までコメント）。
 *   - 文字列: "…"（\" でエスケープ。エンジンの dq と同じ正規表現 "(\\"|[^"])*"）
 *   - 関数の呼び出し: 識別子の直後（空白を挟んでもよい）に (
 *   - 識別子: 英数字、_、$、全角・日本語（項目コード、変数名、true / false など）。数字だけのものは数値
 * 評価はしない。FUNCTION_TAGS の分類は呼ぶ側（normalize）が行う
 */
export interface ScanResult {
  /** 関数名（大文字のまま）→ 呼び出しの数。入れ子も数える */
  functions: Record<string, number>;
  /** 関数名でない識別子（項目コード・変数名の候補。true / false / 数値は含めない） */
  identifiers: Set<string>;
  /** 文字列の中身（エスケープは解かない） */
  strings: string[];
  /** 文字列と、それを引数に持つ最も内側の関数名（"" なら関数の外。UINFO 系の引数のコードの突き合わせに） */
  stringArgs: Array<{ text: string; call: string }>;
  /** 閉じていない文字列・括弧（検査の誤りとして出す） */
  problems: string[];
}

const IDENT = /[A-Za-z0-9_$\u0080-￿]/;
const KEYWORDS = new Set(["true", "false", "TRUE", "FALSE", "null"]);

export function scanFormula(text: string): ScanResult {
  const functions: Record<string, number> = {};
  const identifiers = new Set<string>();
  const strings: string[] = [];
  const stringArgs: Array<{ text: string; call: string }> = [];
  const problems: string[] = [];
  /** 開いている括弧ごとの関数名（関数の呼び出しでない括弧は ""） */
  const calls: string[] = [];
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      let s = "";
      let closed = false;
      while (j < n) {
        if (text[j] === "\\" && text[j + 1] === '"') { s += '\\"'; j += 2; continue; }
        if (text[j] === '"') { closed = true; break; }
        s += text[j];
        j++;
      }
      if (!closed) problems.push(`閉じていない文字列（${i} 文字目から）`);
      strings.push(s);
      stringArgs.push({ text: s, call: calls[calls.length - 1] ?? "" });
      i = closed ? j + 1 : n;
      continue;
    }
    if (ch === "(") { depth++; calls.push(""); i++; continue; }
    if (ch === ")") { depth--; calls.pop(); if (depth < 0) { problems.push(`対応しない ) （${i} 文字目）`); depth = 0; } i++; continue; }
    if (IDENT.test(ch)) {
      let j = i;
      while (j < n && IDENT.test(text[j])) j++;
      const word = text.slice(i, j);
      let k = j;
      while (k < n && (text[k] === " " || text[k] === "\t")) k++;
      if (text[k] === "(") {
        functions[word] = (functions[word] ?? 0) + 1;
        depth++;
        calls.push(word);
        i = k + 1;
        continue;
      } else if (!/^\d+(\.\d+)?$/.test(word) && !KEYWORDS.has(word)) {
        identifiers.add(word);
      }
      i = j;
      continue;
    }
    i++;
  }
  if (depth > 0) problems.push(`閉じていない ( が ${depth} 個`);
  return { functions, identifiers, strings, stringArgs, problems };
}

/** 関数名(引数) の、識別子だけの引数（例 LOOKUP_GETID(顧客) の 顧客）。文脈の検査（ルックアップ先）に */
export function staticArgsOf(text: string, fn: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![A-Za-z0-9_$\\u0080-\\uFFFF])${fn}\\s*\\(\\s*([A-Za-z0-9_$\\u0080-\\uFFFF]+)\\s*[,)]`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

/** 複数の式をまとめて走査（項目ごとの結果と、全体の関数の数） */
export function scanFormulas(formulas: ReadonlyArray<{ fieldcode: string; formula: string }>): { byField: Map<string, ScanResult>; functions: Record<string, number> } {
  const byField = new Map<string, ScanResult>();
  const functions: Record<string, number> = {};
  for (const f of formulas) {
    const r = scanFormula(f.formula);
    byField.set(f.fieldcode, r);
    for (const [name, c] of Object.entries(r.functions)) functions[name] = (functions[name] ?? 0) + c;
  }
  return { byField, functions };
}
