/**
 * 項目検証の設定の保存（tools 0.6.0。formula MCP の fv_save_settings / fv_update_rows の本体。CLI は使わない。CLI は fv normalize --out）。
 * 計算式の保存（commands/save.ts）と同じ約束（expectedAbsent、digest の照合、書ける場所と kintone/ の下の許可、ロック、確定の仕方、状態と誤りの文）で、検査は Worker の fv-normalize。
 *   - 新しい設定（fvSaveNewSettings）: 書くのは既定値を補った元の値の封筒（fv normalize --out と同じ）。同じ名前があれば conflict
 *   - 既存の設定の行（fvUpdateRows）: rows（1〜50 行）を fieldcode で差し替え、設定に無い fieldcode の行は足す（state を省けば true、ほかの省いた値は fv normalize が既定で補う）。
 *     行の中のキーは丸ごと置き換える（condInfos は検証条件の全部、テーブルの行の tblfields は列の全部）。common（FV_COMMON_KEYS）はキーごとに置き換える
 *   - 項目定義の決め方、入力の上限（256 KiB）、ダウンロード / pull のファイルを書き換えないことは計算式と同じ
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { InputError } from "../input.ts";
import { ENVELOPE_KEYS } from "../normalize/model.ts";
import { WRITE_ROOTS, resolveRead, resolveWrite } from "../safe-path.ts";
import { assertChangeAllowed } from "../permission.ts";
import { assertUsableInKintone, isEditName, isSnapshotName } from "../workspace.ts";
import {
  ConflictError, MAX_SAVE_INPUT_BYTES, MAX_UPDATE_ROWS, SaveDenied, commit, digestOf, errorResult, fieldsFileFor, finish, isPlainObject, normalizeText, parseInput, rel, tooLarge,
  type SaveContext, type SaveResult
} from "../commands/save.ts";
import type { EvalOutcome } from "../worker/eval-job.ts";
import { FV_CONFIG_PLUGIN_ID } from "./meta.ts";
import { FV_COMMON_KEYS, FV_ROW_KEYS } from "./model.ts";
import { fvDiffSettings } from "./summary.ts";

const READ_AGAIN = "fv_summary";

function assertFvEnvelope(v: Record<string, unknown>, what: string): void {
  if (v.pluginID !== FV_CONFIG_PLUGIN_ID) throw new InputError(`${what}は項目検証の設定ではない（封筒の pluginID が "${FV_CONFIG_PLUGIN_ID}" でない。計算式の設定は fml_save_settings / fml_update_fields）`);
}

/** 新しい設定を保存する（expectedAbsent: true が要る。同じ名前のファイルがあれば conflict） */
export async function fvSaveNewSettings(ctx: SaveContext, opt: { path: string; content: string; fields?: string; expectedAbsent: true }): Promise<SaveResult> {
  if (opt.expectedAbsent !== true) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: "新しい設定の保存は expectedAbsent: true が要る（既存のファイルを直すなら fv_update_rows）" };
  if (tooLarge(opt.content)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `content は ${MAX_SAVE_INPUT_BYTES.toLocaleString()} バイトまで` };
  let target: string;
  try {
    target = resolveWrite(opt.path, WRITE_ROOTS.settings, ctx.root);
    const name = path.basename(target);
    if (isSnapshotName(name)) throw new SaveDenied("ダウンロード / pull の名前（rex0220-field-validation-app<番号>-<日時>.json、計算式は rex0220-formula-app…）では新しく保存しない");
    if (isEditName(name)) throw new SaveDenied("-edit.json の名前では新しく保存しない（ダウンロード / pull を直すなら fml_edit（plugin: field-validation）で写してから fv_update_rows）");
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
  } catch (e) {
    return errorResult(ctx.root, path.resolve(ctx.root, opt.path), e);
  }
  if (existsSync(target)) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "同じ名前のファイルがある（新しい設定の保存は上書きしない。直すなら fv_update_rows）" };
  let outcome: EvalOutcome;
  try {
    const envelope = parseInput(opt.content, "content");
    if (!isPlainObject(envelope)) throw new InputError("content の最上位はオブジェクト（封筒形式の設定 JSON）");
    assertFvEnvelope(envelope, "content ");
    outcome = await normalizeText(ctx, target, opt.content, fieldsFileFor(ctx, target, opt.fields, envelope), "fv-normalize");
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  if (outcome.normalize.hasErrors || !outcome.normalize.output) return { status: "invalid", code: "NormalizeError", path: rel(ctx.root, target), findings: outcome.normalize.findings, summary: outcome.normalize.summary, message: "fv normalize のエラーがあるので保存しない" };
  const text = JSON.stringify(outcome.normalize.output, null, 2) + "\n";
  return finish(ctx, target, outcome, () =>
    commit(ctx, target, text, "new", () => {
      if (existsSync(target)) throw new ConflictError("確定の直前に同じ名前のファイルができた");
    }, READ_AGAIN)
  );
}

/** rows を読む。設定にある fieldcode の行は差し替え（キーごと）、無い fieldcode の行は足す（state を省けば true。ほかは fv normalize が補う） */
function parseRows(text: string, current: Array<Record<string, unknown>>): { replace: Map<string, Record<string, unknown>>; added: Array<Record<string, unknown>> } {
  const v = parseInput(text, "rows");
  if (!Array.isArray(v)) throw new InputError("rows は行（fieldcode を持つオブジェクト）の配列");
  if (v.length === 0) throw new InputError("rows が空");
  if (v.length > MAX_UPDATE_ROWS) throw new InputError(`rows は 1 回に ${MAX_UPDATE_ROWS} 行まで（${v.length} 行）`);
  const known = new Set<string>(FV_ROW_KEYS);
  const codes = new Set(current.map((r) => (isPlainObject(r) ? String(r.fieldcode ?? "") : "")));
  const replace = new Map<string, Record<string, unknown>>();
  const added: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  v.forEach((row, i) => {
    if (!isPlainObject(row)) throw new InputError(`rows[${i}] はオブジェクト`);
    const code = row.fieldcode;
    if (typeof code !== "string" || !code) throw new InputError(`rows[${i}] に fieldcode（文字列）が要る`);
    const unknown = Object.keys(row).filter((k) => !known.has(k));
    if (unknown.length) throw new InputError(`rows[${i}]（${code}）に行の元の値でないキーがある: ${unknown.join(", ")}（使えるのは ${FV_ROW_KEYS.join(", ")}。テーブルの列の非表示はテーブルの行の tblfields）`);
    if (seen.has(code)) throw new InputError(`rows の fieldcode が重複: ${code}`);
    seen.add(code);
    if (codes.has(code)) replace.set(code, row);
    // 足す行は「使う」を既定でオンに（省くと fv normalize の既定はオフ = 判定しない。足すのは使うため）
    else added.push({ state: true, ...row });
  });
  return { replace, added };
}

/** common を読む（FV_COMMON_KEYS だけ。封筒・pluginInfos・知らないキーは invalid） */
function parseCommon(text: string): Record<string, unknown> {
  const v = parseInput(text, "common");
  if (!isPlainObject(v)) throw new InputError(`common は共通の設定のキー（${FV_COMMON_KEYS.join("、")}）を持つオブジェクト`);
  const fixed = Object.keys(v).filter((k) => k === "pluginInfos" || (ENVELOPE_KEYS as readonly string[]).includes(k));
  if (fixed.length) throw new InputError(`common で変えられないキー: ${fixed.join(", ")}（項目の行は rows、封筒（appId など）は変えない）`);
  const unknown = Object.keys(v).filter((k) => !(FV_COMMON_KEYS as readonly string[]).includes(k));
  if (unknown.length) throw new InputError(`common に共通の設定でないキーがある: ${unknown.join(", ")}（使えるのは ${FV_COMMON_KEYS.join("、")}）`);
  if (!Object.keys(v).length) throw new InputError("common が空（変えないなら渡さない）");
  return v;
}

/**
 * 既存の設定の行を差し替える（rows は行の JSON の配列の文字列。common は共通の設定の JSON の文字列）。
 * expectedDigest は fv_summary が返した値。差し替えた後の設定を fv normalize し、エラーが無ければ確定する（書くのは元の値の封筒）
 */
export async function fvUpdateRows(ctx: SaveContext, opt: { path: string; expectedDigest: string; rows: string; common?: string; fields?: string }): Promise<SaveResult> {
  if (tooLarge(opt.rows)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `rows は ${MAX_SAVE_INPUT_BYTES.toLocaleString()} バイトまで` };
  if (opt.common !== undefined && tooLarge(opt.common)) return { status: "invalid", code: "InputError", path: opt.path, findings: [], message: `common は ${MAX_SAVE_INPUT_BYTES.toLocaleString()} バイトまで` };
  let target: string;
  try {
    target = resolveRead(opt.path, ctx.root);
    resolveWrite(opt.path, WRITE_ROOTS.settings, ctx.root);
    if (isSnapshotName(path.basename(target))) throw new SaveDenied("ダウンロード / pull のファイルは書き換えない。fml_edit（plugin: field-validation）で -edit.json に写して直す");
    assertUsableInKintone(ctx.root, target, ctx.mode);
    assertChangeAllowed(ctx.root, target, "settings", ctx.mode);
  } catch (e) {
    return errorResult(ctx.root, path.resolve(ctx.root, opt.path), e);
  }
  if (!existsSync(target)) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "ファイルが無い（新しい設定なら fv_save_settings）" };
  const current = readFileSync(target);
  if (digestOf(current) !== opt.expectedDigest) return { status: "conflict", code: "ConflictError", path: rel(ctx.root, target), findings: [], message: "読んだ後にファイルが変わった（digest が違う）。fv_summary で読み直す" };
  let settings: Record<string, unknown>;
  try {
    const v = parseInput(current.toString("utf8").replace(/^﻿/, ""), "設定のファイル");
    if (!isPlainObject(v)) throw new InputError("設定のファイルの最上位はオブジェクト");
    assertFvEnvelope(v, "設定のファイル");
    if (!Array.isArray(v.pluginInfos)) throw new InputError("設定のファイルに pluginInfos（項目の行）が無い");
    settings = v;
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  const rows = settings.pluginInfos as Array<Record<string, unknown>>;
  let next: Record<string, unknown>;
  try {
    const { replace, added } = parseRows(opt.rows, rows);
    const common = opt.common !== undefined ? parseCommon(opt.common) : {};
    const merged = rows.map((r) => {
      const rep = replace.get(isPlainObject(r) ? String(r.fieldcode ?? "") : "");
      return rep ? { ...r, ...rep } : r;
    });
    next = { ...settings, ...common, pluginInfos: [...merged, ...added] };
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  let outcome: EvalOutcome;
  try {
    outcome = await normalizeText(ctx, target, JSON.stringify(next), fieldsFileFor(ctx, target, opt.fields, settings), "fv-normalize");
  } catch (e) {
    return errorResult(ctx.root, target, e);
  }
  if (outcome.normalize.hasErrors || !outcome.normalize.output) return { status: "invalid", code: "NormalizeError", path: rel(ctx.root, target), findings: outcome.normalize.findings, summary: outcome.normalize.summary, message: "fv normalize のエラーがあるので保存しない（ファイルは変えていない）" };
  const output = outcome.normalize.output;
  const text = JSON.stringify(output, null, 2) + "\n";
  const name = rel(ctx.root, target);
  const d = fvDiffSettings(settings, output, { before: `${name}（前）`, after: name });
  return finish(
    ctx, target, outcome,
    () =>
      commit(ctx, target, text, "replace", () => {
        if (digestOf(readFileSync(target)) !== opt.expectedDigest) throw new ConflictError("確定の直前にファイルが変わった（digest が違う）。fv_summary で読み直す");
      }, READ_AGAIN),
    { fvDiff: { lines: d.lines, changed: d.changed } }
  );
}
