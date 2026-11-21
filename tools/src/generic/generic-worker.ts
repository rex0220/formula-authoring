/** Worker の入口（dist/generic-worker.mjs。workerData = GenericJob、結果は parentPort に 1 回だけ） */
import { parentPort, workerData } from "node:worker_threads";
import { classifyGenericError, runGenericJob, type GenericJob, type GenericMessage } from "./host.ts";

const post = (m: GenericMessage): void => { parentPort?.postMessage(m); };
runGenericJob(workerData as GenericJob)
  .then((result) => post({ ok: true, result }))
  .catch((e: unknown) => post({ ok: false, error: classifyGenericError(e) }));
