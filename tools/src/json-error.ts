/**
 * JSON の読み込みの誤りの文（tools 2.0.0。Codex の実装レビュー BLOCKER 1）。JSON.parse の誤りの文には、Node 20 から読んだファイルの中身の一部が入る
 * （`Unexpected token 'S', "{"token":SECRET…"... is not valid JSON`）。トークン・レコードの値などを応答・標準エラーに出さないよう、位置だけにする
 */

/** JSON.parse の誤りの位置（行と列。無ければ文字の位置）。分からなければ空 */
export function jsonErrorWhere(e: unknown): string {
  const m = /in JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(e instanceof Error ? e.message : String(e));
  if (!m) return "";
  return m[2] ? `（${m[2]} 行 ${m[3]} 列）` : `（位置 ${m[1]}）`;
}

/** 構文の誤りなら位置だけの決まった文、それ以外（大きさ・深さの上限など、中身を含まない文）はそのまま */
export function jsonErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof SyntaxError || /is not valid JSON|in JSON at position|Unexpected (token|end|non-whitespace)|Bad control character|Unterminated string/.test(msg)) return `JSON の構文の誤り${jsonErrorWhere(e)}（中身は表示しない）`;
  return msg;
}
