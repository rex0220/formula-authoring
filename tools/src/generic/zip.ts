/**
 * 汎用のオーサリングが扱うプラグインの zip を読む。展開・上限・CRC は plugin-zip.ts（計算式と共通）を使い、読むファイルは表（registry.ts）から決める。
 *
 * **動かしてよい zip の条件**（計画 11 章の B4。2026-11-12 Takashi「勧めのとおり」）:
 *   1. 外側の zip の PUBKEY から出るプラグイン ID が、表のプラグインのものと同じ
 *   2. **SIGNATURE が、その PUBKEY で contents.zip を検証して通る**（RSA-SHA1。kintone のプラグインの署名の形）
 * 1 だけでは、PUBKEY を残して contents.zip を差し替えた zip を見分けられない。2 で「その鍵で署名した中身」であることを確かめる。
 * ここを通っても sandbox ではない（zip のコードは Node を起動した OS ユーザーの権限で動く）。
 * 計算式・項目検証・印刷屋の読み方（plugin-zip.ts の readPluginZip。SIGNATURE を見ない）は変えていない。
 */
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { pluginIdOf, sha256Hex, unzip } from "../plugin-zip.ts";
import type { GenericPlugin } from "./registry.ts";

/**
 * not-configured: zip の場所が分からない / missing: zip が無い / unreadable: zip として読めない（プラグインの 2 層の形でない、manifest が読めない、大きすぎる）
 * not-plugin: プラグイン ID が表のプラグインのものでない / bad-signature: 署名が通らない（中身が差し替えられた、壊れている）
 * unsupported-version: 版が対応外 / no-api: authoring API が無い（古い版） / incomplete: 表のスクリプトが無い
 * api-unreadable / api-unsupported / api-mismatch: zip のコードを読み込んだ後の検査（host.ts）
 */
export type GenericZipErrorCode =
  | "not-configured" | "missing" | "unreadable" | "not-plugin" | "bad-signature" | "unsupported-version" | "no-api" | "incomplete"
  | "api-unreadable" | "api-unsupported" | "api-mismatch";

export class GenericZipError extends Error {
  readonly code: GenericZipErrorCode;
  readonly pluginVersion?: string;
  constructor(message: string, code: GenericZipErrorCode, pluginVersion?: string) {
    super(message);
    this.code = code;
    this.pluginVersion = pluginVersion;
  }
}

export interface GenericZipSources {
  from: string;
  pluginId: string;
  pluginVersion: string;
  /** 読む順 */
  scripts: Array<{ entry: string; code: string }>;
  api: string;
  /** zip の世代（差し替えを見分ける。状態の表示にも出す） */
  stamp: { size: number; mtimeMs: number };
  sha256: { contents: string; api: string };
}

const text = (buf: Buffer): string => buf.toString("utf8");

export function readGenericZip(file: string | undefined, plugin: GenericPlugin): GenericZipSources {
  if (!file) throw new GenericZipError(`${plugin.title}プラグインの zip の場所が分からない（環境変数か .env の ${plugin.zipEnv} に書く）`, "not-configured");
  if (!existsSync(file)) throw new GenericZipError(`${plugin.title}プラグインの zip が無い: ${file}`, "missing");
  const st = statSync(file);
  let outer: Map<string, Buffer>;
  try {
    outer = unzip(readFileSync(file));
  } catch (e) {
    throw new GenericZipError(`zip として読めない: ${file}（${e instanceof Error ? e.message : String(e)}）`, "unreadable");
  }
  const contents = outer.get("contents.zip");
  const pubkey = outer.get("PUBKEY");
  const signature = outer.get("SIGNATURE");
  if (!contents || !pubkey || !signature) throw new GenericZipError(`kintone のプラグインの zip の形でない（contents.zip / PUBKEY / SIGNATURE が要る）: ${file}`, "unreadable");
  const pluginId = pluginIdOf(pubkey);
  if (pluginId !== plugin.kintonePluginId) throw new GenericZipError(`${plugin.title}プラグインの zip ではない（プラグイン ID ${pluginId}。${plugin.kintonePluginId} が要る）: ${file}`, "not-plugin");
  let signed = false;
  try {
    signed = verify("RSA-SHA1", contents, createPublicKey({ key: pubkey, format: "der", type: "spki" }), signature);
  } catch {
    signed = false;
  }
  if (!signed) throw new GenericZipError(`zip の署名が通らない（中身が差し替えられたか、壊れている）。配布元から取り直す: ${file}`, "bad-signature");
  let inner: Map<string, Buffer>;
  let manifest: { version?: unknown };
  try {
    inner = unzip(contents);
    manifest = JSON.parse(text(inner.get("manifest.json") ?? Buffer.from(""))) as { version?: unknown };
  } catch (e) {
    throw new GenericZipError(`zip の中身を読めない: ${file}（${e instanceof Error ? e.message : String(e)}）`, "unreadable");
  }
  const pluginVersion = String(manifest.version ?? "");
  if (!/^[1-9]\d{0,5}$/.test(pluginVersion) || Number(pluginVersion) < plugin.minPluginVersion) {
    throw new GenericZipError(`${plugin.title}プラグインの版 ${pluginVersion || "?"} には対応していない（Ver.${plugin.minPluginVersion} 以降の zip が要る）: ${file}`, "unsupported-version", pluginVersion);
  }
  const api = inner.get(plugin.apiEntry);
  if (!api) throw new GenericZipError(`zip に authoring API（${plugin.apiEntry}）が無い: ${file}`, "no-api", pluginVersion);
  const scripts: Array<{ entry: string; code: string }> = [];
  for (const entry of plugin.scripts) {
    const buf = inner.get(entry);
    if (!buf) throw new GenericZipError(`zip に ${entry} が無い: ${file}`, "incomplete", pluginVersion);
    scripts.push({ entry, code: text(buf) });
  }
  return { from: file, pluginId, pluginVersion, scripts, api: text(api), stamp: { size: st.size, mtimeMs: st.mtimeMs }, sha256: { contents: sha256Hex(contents), api: sha256Hex(api) } };
}
