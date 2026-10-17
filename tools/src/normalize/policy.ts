/**
 * policy/authoring-policy.json（利用者が書く。AI は書かない）。
 * {
 *   "allowFunctions": ["FSET", "FSET_TADD"],   // 副作用のある関数のうち、normalize / calc で評価してよいもの（関数単位。Codex レビュー #17）
 *   "allowMiscChanges": false                   // 各種設定（pluginMiscInfo）を既定から変えてよいか
 * }
 * EV_SET は policy で許可できない（テスト用。設定に残れば常にエラー）。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface Policy {
  allowFunctions: string[];
  allowMiscChanges: boolean;
}

export class PolicyError extends Error {}

export const POLICY_FILE = path.join("policy", "authoring-policy.json");
const MAX_POLICY_BYTES = 64 * 1024;
const FUNCTION_NAME = /^[A-Z][A-Z0-9_]{0,40}$/;

export const DEFAULT_POLICY: Policy = { allowFunctions: [], allowMiscChanges: false };

export function parsePolicy(text: string, file: string): Policy {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new PolicyError(`${file} を JSON として読めない: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PolicyError(`${file} の最上位はオブジェクト`);
  const obj = raw as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (k !== "allowFunctions" && k !== "allowMiscChanges") throw new PolicyError(`${file}: $.${k} は使えない（allowFunctions と allowMiscChanges だけ）`);
  const out: Policy = { ...DEFAULT_POLICY, allowFunctions: [] };
  if (obj.allowFunctions !== undefined) {
    if (!Array.isArray(obj.allowFunctions)) throw new PolicyError(`${file}: allowFunctions は関数名の配列`);
    for (const f of obj.allowFunctions) {
      if (typeof f !== "string" || !FUNCTION_NAME.test(f)) throw new PolicyError(`${file}: allowFunctions の値が関数名でない: ${String(f)}`);
      if (f === "EV_SET") throw new PolicyError(`${file}: EV_SET は許可できない（テスト用の関数。設定には入れない）`);
      out.allowFunctions.push(f);
    }
  }
  if (obj.allowMiscChanges !== undefined) {
    if (typeof obj.allowMiscChanges !== "boolean") throw new PolicyError(`${file}: allowMiscChanges は true / false`);
    out.allowMiscChanges = obj.allowMiscChanges;
  }
  return out;
}

/** 作業フォルダーの policy/authoring-policy.json（無ければ既定 = 何も許可しない） */
export function loadPolicy(root: string): Policy {
  const file = path.join(root, POLICY_FILE);
  if (!existsSync(file)) return { ...DEFAULT_POLICY, allowFunctions: [] };
  if (statSync(file).size > MAX_POLICY_BYTES) throw new PolicyError(`${POLICY_FILE} が大きすぎる`);
  return parsePolicy(readFileSync(file, "utf8"), POLICY_FILE);
}
