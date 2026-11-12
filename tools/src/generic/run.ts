/**
 * 汎用のオーサリングの仕事を Worker で動かし、時間上限で止める（worker/run.ts と同じ形。仕事の中身が違う）。
 *   - Worker の入口は、ビルドでは dist/generic-worker.mjs、ソースから動かすときは src/generic/generic-worker.ts。
 *     MCP（CJS の束ね）は workerFile で入口の絶対パスを渡す
 *   - captureOutput を渡すと、Worker の標準出力・標準エラー（zip のコードの console の出力）を親に流さず、その関数に渡す（MCP の標準出力は JSON-RPC だけ）
 *   - inline は主スレッドで動かす（**グローバルに zip のコードが入る**。試験だけ）
 */
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { classifyGenericError, runGenericJob, type GenericErrorKind, type GenericJob, type GenericMessage } from "./host.ts";
import type { GenericZipErrorCode } from "./zip.ts";

export const GENERIC_DEFAULT_TIMEOUT_SEC = 60;
export const GENERIC_MAX_TIMEOUT_SEC = 600;

export class GenericTimeoutError extends Error {}

/** Worker の中の誤り。kind は中核が決めた種類（zip = zip の読み取りと検査、plugin = authoring API が投げた、other = それ以外）。plugin / other の文は値を含みうる */
export class GenericCallError extends Error {
  readonly kind: GenericErrorKind;
  readonly innerName: string;
  /** kind が zip のときの種類（GenericZipErrorCode） */
  readonly code?: GenericZipErrorCode;
  readonly pluginVersion?: string;
  constructor(error: Extract<GenericMessage, { ok: false }>["error"]) {
    super(error.message);
    this.kind = error.kind;
    this.innerName = error.name;
    this.code = error.code as GenericZipErrorCode | undefined;
    this.pluginVersion = error.pluginVersion;
  }
}

export interface GenericRunOptions {
  timeoutSec?: number;
  inline?: boolean;
  workerFile?: string;
  captureOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

function workerEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  // ビルド: dist/generic.mjs と同じフォルダーの generic-worker.mjs。ソース: src/generic/generic-worker.ts
  const built = path.join(dir, "generic-worker.mjs");
  if (here.endsWith(".mjs") && existsSync(built)) return built;
  const src = path.join(dir, "generic-worker.ts");
  if (existsSync(src)) return src;
  throw new Error(`Worker の入口が無い: ${built}`);
}

export async function callGeneric<T = unknown>(job: GenericJob, opt: GenericRunOptions = {}): Promise<T> {
  const timeoutSec = Math.min(Math.max(opt.timeoutSec ?? GENERIC_DEFAULT_TIMEOUT_SEC, 1), GENERIC_MAX_TIMEOUT_SEC);
  if (opt.inline) {
    try {
      return (await runGenericJob(job)) as T;
    } catch (e) {
      throw new GenericCallError(classifyGenericError(e));
    }
  }
  let entry: string;
  if (opt.workerFile !== undefined) {
    if (!path.isAbsolute(opt.workerFile) || !existsSync(opt.workerFile)) throw new Error(`Worker の入口が無い（絶対パスで指定する）: ${opt.workerFile}`);
    entry = opt.workerFile;
  } else entry = workerEntry();
  const capture = opt.captureOutput;
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(entry, { workerData: job, stdout: capture !== undefined, stderr: capture !== undefined });
    if (capture) {
      worker.stdout.on("data", (d: Buffer | string) => capture(String(d), "stdout"));
      worker.stderr.on("data", (d: Buffer | string) => capture(String(d), "stderr"));
    }
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 仕事は 1 回で終わり。結果を受けたら Worker を止める（グローバルに zip のコードを残さない）
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new GenericTimeoutError(`処理が ${timeoutSec} 秒を超えたので止めた（式が重いか、無限に近い繰り返し）`))), timeoutSec * 1000);
    worker.on("message", (m: GenericMessage) => finish(() => (m.ok ? resolve(m.result as T) : reject(new GenericCallError(m.error)))));
    worker.on("error", (e) => finish(() => reject(new GenericCallError({ kind: "other", name: e instanceof Error ? e.constructor.name : "Error", message: e?.message ?? String(e) }))));
    worker.on("exit", (code) => finish(() => reject(new Error(`Worker が結果を返さずに終わった（exit ${code}）`))));
  });
}
