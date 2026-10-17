/**
 * 評価を Worker で動かし、時間上限で止める（Codex レビュー BLOCKER 1。公開の条件）。
 *   - 同期の dq はイベントループを塞ぐので、主スレッドではなく Worker で動かし、超えたら terminate する
 *   - Worker の入口は、ビルドでは dist/eval-worker.mjs（cli.mjs の隣）、ソースから動かすときは src/worker/eval-worker.ts
 *   - FORMULA_NO_WORKER=1 のときは主スレッドで動かす（テストと、Worker が使えない環境）
 * zip のコードは Worker でも同じ OS ユーザーの権限で動く（sandbox ではない）。時間上限は暴走を止める保険で、隔離ではない
 */
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runEvalJob } from "./eval-run.ts";
import type { EvalJob, EvalMessage, EvalOutcome } from "./eval-job.ts";

export const DEFAULT_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_SEC = 600;

export class EvalTimeoutError extends Error {}
/** Worker の中の誤り（name / code を持って主スレッドに戻す） */
export class EvalError extends Error {
  readonly innerName: string;
  readonly code?: string;
  constructor(message: string, innerName: string, code?: string) {
    super(message);
    this.innerName = innerName;
    this.code = code;
  }
}

function workerEntry(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  // ビルド: dist/cli.mjs と同じフォルダーの eval-worker.mjs。ソース: src/worker/eval-worker.ts
  const built = path.join(dir, "eval-worker.mjs");
  if (here.endsWith(".mjs") && existsSync(built)) return built;
  const src = path.join(dir, "eval-worker.ts");
  if (existsSync(src)) return src;
  throw new Error(`Worker の入口が無い: ${built}`);
}

export interface RunOptions {
  timeoutSec?: number;
  /** 主スレッドで動かす（テスト） */
  inline?: boolean;
}

export async function runEval(job: EvalJob, opt: RunOptions = {}): Promise<EvalOutcome> {
  const timeoutSec = Math.min(Math.max(opt.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);
  if (opt.inline) return runEvalJob(job);
  const entry = workerEntry();
  return new Promise<EvalOutcome>((resolve, reject) => {
    const worker = new Worker(entry, { workerData: job, stdout: false, stderr: false });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        void worker.terminate();
        reject(new EvalTimeoutError(`評価が ${timeoutSec} 秒を超えたので止めた（式が重いか無限に近い繰り返し。--timeout <秒> で上げられる。上限 ${MAX_TIMEOUT_SEC}）`));
      });
    }, timeoutSec * 1000);
    worker.on("message", (m: EvalMessage) => {
      finish(() => {
        if (m.ok) resolve(m.outcome);
        else reject(new EvalError(m.error.message, m.error.name, m.error.code));
      });
    });
    worker.on("error", (e) => finish(() => reject(e)));
    worker.on("exit", (code) => finish(() => reject(new Error(`評価の Worker が結果を返さずに終わった（exit ${code}）`))));
  });
}
