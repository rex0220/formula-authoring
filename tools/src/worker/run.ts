/**
 * 評価を Worker で動かし、時間上限で止める（Codex レビュー BLOCKER 1。公開の条件）。
 *   - 同期の dq はイベントループを塞ぐので、主スレッドではなく Worker で動かし、超えたら terminate する
 *   - Worker の入口は、ビルドでは dist/eval-worker.mjs（cli.mjs の隣）、ソースから動かすときは src/worker/eval-worker.ts。
 *     MCP（CJS の束ね。import.meta.url が無い）は workerFile で入口の絶対パスを渡す（tools 0.2.0。計画 24.4）
 *   - FORMULA_NO_WORKER=1 のときは主スレッドで動かす（テストと、Worker が使えない環境）
 *   - captureOutput を渡すと、Worker の標準出力・標準エラー（zip のコードの console の出力など）を親の標準出力に流さず、その関数に渡す
 *     （MCP の標準出力は JSON-RPC だけ。Worker の stdout: false は「親の process.stdout に自動で流す」なので、捨てるには stdout: true で読む）
 * zip のコードは Worker でも同じ OS ユーザーの権限で動く（sandbox ではない）。時間上限は暴走を止める保険で、隔離ではない
 */
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { builtinErrorName, classifyEvalError, runEvalJob } from "./eval-run.ts";
import type { EvalErrorKind, EvalJob, EvalMessage, EvalOutcome } from "./eval-job.ts";

export const DEFAULT_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_SEC = 600;

export class EvalTimeoutError extends Error {}
/**
 * Worker の中の誤り（kind / name / code を持って主スレッドに戻す）。kind は中核が instanceof で決めた信頼できる種類（input / zip / users / policy / other）。
 * innerName は参考の名前（other のときは zip のコードが付けた名前かもしれない）。other のときの文は値やパスを含みうる（MCP は返さない）
 */
export class EvalError extends Error {
  readonly innerName: string;
  readonly code?: string;
  readonly kind: EvalErrorKind;
  constructor(message: string, innerName: string, code?: string, kind: EvalErrorKind = "other") {
    super(message);
    this.innerName = innerName;
    this.code = code;
    this.kind = kind;
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
  /** Worker の入口（絶対パス）。省略すれば自分の隣の eval-worker.mjs / eval-worker.ts */
  workerFile?: string;
  /** Worker の標準出力・標準エラーの受け取り先（渡すと親の標準出力・標準エラーに流さない） */
  captureOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export async function runEval(job: EvalJob, opt: RunOptions = {}): Promise<EvalOutcome> {
  const timeoutSec = Math.min(Math.max(opt.timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC);
  if (opt.inline) {
    // 主スレッドで動かすときも、誤りは Worker と同じ形（kind 付きの EvalError）にする
    try {
      return await runEvalJob(job);
    } catch (e) {
      const c = classifyEvalError(e);
      throw new EvalError(c.message, c.name, c.code, c.kind);
    }
  }
  let entry: string;
  if (opt.workerFile !== undefined) {
    if (!path.isAbsolute(opt.workerFile) || !existsSync(opt.workerFile)) throw new Error(`Worker の入口が無い（絶対パスで指定する）: ${opt.workerFile}`);
    entry = opt.workerFile;
  } else entry = workerEntry();
  const capture = opt.captureOutput;
  return new Promise<EvalOutcome>((resolve, reject) => {
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
        else reject(new EvalError(m.error.message, m.error.name, m.error.code, m.error.kind ?? "other"));
      });
    });
    // Worker の中で捕まえられなかった例外（読み込みの失敗など）。種類は other（文も name も信用しない）
    worker.on("error", (e) => finish(() => reject(new EvalError(e?.message ?? String(e), builtinErrorName(e), undefined, "other"))));
    worker.on("exit", (code) => finish(() => reject(new Error(`評価の Worker が結果を返さずに終わった（exit ${code}）`))));
  });
}
