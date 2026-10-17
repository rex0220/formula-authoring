/** Worker の中でも主スレッドでも同じ: 仕事 → 結果（zip の読み込み、normalize、calc） */
import { loadEngine } from "../engine.ts";
import { normalizeSettings } from "../commands/normalize.ts";
import { calcSettings } from "../commands/calc.ts";
import { buildUsersInfo } from "../users/index.ts";
import type { EvalJob, EvalOutcome } from "./eval-job.ts";

export async function runEvalJob(job: EvalJob): Promise<EvalOutcome> {
  const engine = await loadEngine({ pluginZip: job.pluginZip, devPluginDir: job.devPluginDir, mode: job.mode });
  if (job.baseUrl) engine.setContext({ baseUrl: job.baseUrl });
  const usersInfo = buildUsersInfo(job.usersSource);
  const usersLabel = job.usersOrigin.kind === "file" ? job.usersOrigin.file : "既定のテストデータ（架空）";
  const res = await normalizeSettings({
    settingsText: job.settingsText, settingsFile: job.settingsFile, fields: job.fields, engine, policy: job.policy, check: job.check, lang: job.lang, usersInfo, usersLabel
  });
  const outcome: EvalOutcome = {
    normalize: { summary: res.summary, hasErrors: res.findings.hasErrors, warnings: res.findings.count("warning"), output: res.output, checkDiffs: res.checkDiffs },
    engineWarnings: [...engine.warnings]
  };
  if (job.kind === "calc" && job.calc && !res.findings.hasErrors) {
    const c = job.calc;
    const r = calcSettings({
      normalized: res, engine, fields: job.fields, appId: c.appId, records: c.records, evType: c.evType, event: c.event, mobile: c.mobile, user: c.user,
      usersInfo, usersOrigin: job.usersOrigin
    });
    outcome.calc = { text: r.text, failed: r.records.some((x) => x.errors.length > 0 || x.failed) };
  }
  return outcome;
}
