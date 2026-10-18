/** Worker の入口（dist/eval-worker.mjs。workerData = EvalJob、結果は parentPort に 1 回だけ） */
import { parentPort, workerData } from "node:worker_threads";
import { classifyEvalError, runEvalJob } from "./eval-run.ts";
import type { EvalJob, EvalMessage } from "./eval-job.ts";

const post = (m: EvalMessage): void => { parentPort?.postMessage(m); };
runEvalJob(workerData as EvalJob)
  .then((outcome) => post({ ok: true, outcome }))
  // 種類（kind）は中核のクラスの instanceof で決める（zip のコードが name を偽装しても input / zip にならない。親の EvalError.kind）
  .catch((e: unknown) => post({ ok: false, error: classifyEvalError(e) }));
