/**
 * 入力ファイルの読み込み（大きさの上限、JSON の形）と小さな共通の関数。print-craft-authoring の commands/normalize.ts の汎用の部分を分けた。
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { jsonErrorWhere } from "./json-error.ts";
import type { FieldsFile } from "./commands/fields.ts";

export const PLUGIN_NAME = "計算式プラグイン";
/** fields / record / 設定 JSON のファイルの上限（設定 JSON はさらに kit の上限） */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

export class InputError extends Error {}

const pad = (n: number): string => String(n).padStart(2, "0");
export function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 2 つの値の差を path 付きで集める（短く） */
export function jsonDiff(a: unknown, b: unknown, pathStr: string, out: string[]): void {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) jsonDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${pathStr}.${k}`, out);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((x, i) => jsonDiff(x, b[i], `${pathStr}[${i}]`, out));
    return;
  }
  const short = (v: unknown): string => {
    const s = JSON.stringify(v);
    return s === undefined ? "undefined" : s.length > 100 ? s.slice(0, 100) + "…" : s;
  };
  out.push(`${pathStr}: ${short(a)} → ${short(b)}`);
}

/** 大きさの上限を確かめてからテキストを読む */
export function readTextLimited(file: string, maxBytes = MAX_INPUT_BYTES): string {
  const size = statSync(file).size;
  if (size > maxBytes) throw new InputError(`${file} が大きすぎる（${size.toLocaleString()} バイト。上限 ${maxBytes.toLocaleString()}）`);
  return readFileSync(file, "utf8");
}

/** 大きさの上限を確かめてから JSON を読む（最上位はオブジェクト）。読めないときの文は位置だけ（中身を入れない）。先頭の BOM は除く */
export function readJsonLimited(file: string, maxBytes = MAX_INPUT_BYTES): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(readTextLimited(file, maxBytes).replace(/^﻿/, ""));
  } catch (e) {
    if (e instanceof InputError) throw e;
    throw new InputError(`${file} を JSON として読めない${jsonErrorWhere(e)}（中身は表示しない）`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new InputError(`${file} の最上位はオブジェクト`);
  return v as Record<string, unknown>;
}

export function readFieldsFile(file: string): FieldsFile {
  const fields = readJsonLimited(file) as unknown as FieldsFile;
  if (!fields.properties || typeof fields.properties !== "object") throw new InputError(`${file} は fields コマンドの出力ではない（properties が無い）`);
  if (typeof fields.appId !== "number" || !Number.isInteger(fields.appId) || fields.appId <= 0) throw new InputError(`${file} の appId が正の整数でない`);
  return fields;
}

export function relativeSettingsPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, path.resolve(cwd, file));
  return rel.startsWith("..") ? file : rel.replace(/\\/g, "/");
}

/** 呼び出しの間だけ console.log / warn / error を抑える（kit の legacy-field-ids の [rexgd] と計算式エンジンの err11 などの出力を tools の出力に混ぜない）。例外はそのまま */
export function quiet<T>(fn: () => T): T {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return fn();
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}
