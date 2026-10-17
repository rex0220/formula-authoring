/** Worker の入口（dist/eval-worker.mjs。workerData = EvalJob、結果は parentPort に 1 回だけ） */
import { parentPort, workerData } from "node:worker_threads";
import { runEvalJob } from "./eval-run.ts";
import type { EvalJob, EvalMessage } from "./eval-job.ts";

const post = (m: EvalMessage): void => { parentPort?.postMessage(m); };
runEvalJob(workerData as EvalJob)
  .then((outcome) => post({ ok: true, outcome }))
  .catch((e: unknown) => {
    const err = e as { name?: string; message?: string; code?: string; constructor?: { name?: string } };
    // 独自の Error クラス（PluginZipError など）は name を設定していないので、クラス名で補う（親の EvalError.innerName になる）
    const own = err?.name && err.name !== "Error" ? err.name : undefined;
    const name = own ?? err?.constructor?.name ?? "Error";
    post({ ok: false, error: { name: String(name), message: String(err?.message ?? e), ...(err?.code ? { code: String(err.code) } : {}) } });
  });
