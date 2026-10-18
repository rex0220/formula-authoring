/** Worker の中でも主スレッドでも同じ: 仕事 → 結果（zip の読み込み、normalize、calc） */
import { loadEngine } from "../engine.ts";
import { normalizeSettings } from "../commands/normalize.ts";
import { calcSettings } from "../commands/calc.ts";
import { trySettings } from "../commands/try.ts";
import { buildUsersInfo, UsersDataError } from "../users/index.ts";
import { InputError } from "../input.ts";
import { PluginZipError } from "../plugin-zip.ts";
import { PolicyError } from "../normalize/policy.ts";
import type { EvalErrorKind, EvalJob, EvalMessage, EvalOutcome } from "./eval-job.ts";

/**
 * Worker の中の誤りを種類に分ける（instanceof で。中核のクラスは zip のコードから届かないので、name の偽装では input / zip にならない）。
 * name も instanceof で決めた固定の名前（中核のクラスの名前か、JavaScript の組み込みの Error の名前。例外の name / constructor.name は使わない =
 * zip のコードが name に値やパスを入れても出ない。Codex の r3 レビュー N1）。文は other のときは信用しない（呼ぶ側が決まった文にする）
 */
export function classifyEvalError(e: unknown): Extract<EvalMessage, { ok: false }>["error"] {
  const message = String((e as { message?: unknown } | undefined)?.message ?? e);
  if (e instanceof InputError) return { kind: "input", name: "InputError", message };
  if (e instanceof PluginZipError) return { kind: "zip", name: "PluginZipError", message, code: e.code };
  if (e instanceof UsersDataError) return { kind: "users", name: "UsersDataError", message };
  if (e instanceof PolicyError) return { kind: "policy", name: "PolicyError", message };
  return { kind: "other", name: builtinErrorName(e), message };
}

/** JavaScript の組み込みの Error の種類（instanceof。同じ realm で動く zip のコードの例外も、この判定は偽装できない）。それ以外は Error */
export function builtinErrorName(e: unknown): string {
  if (e instanceof TypeError) return "TypeError";
  if (e instanceof RangeError) return "RangeError";
  if (e instanceof ReferenceError) return "ReferenceError";
  if (e instanceof SyntaxError) return "SyntaxError";
  if (e instanceof URIError) return "URIError";
  return "Error";
}

export async function runEvalJob(job: EvalJob): Promise<EvalOutcome> {
  const engine = await loadEngine({ pluginZip: job.pluginZip, devPluginDir: job.devPluginDir, mode: job.mode, vendorDir: job.vendorDir });
  if (job.baseUrl) engine.setContext({ baseUrl: job.baseUrl });
  const usersInfo = buildUsersInfo(job.usersSource);
  const usersLabel = job.usersOrigin.kind === "file" ? job.usersOrigin.file : "既定のテストデータ（架空）";
  if (job.kind === "try") {
    if (!job.try) throw new InputError("try の仕事に式が無い（try.formulas）");
    const t = job.try;
    const r = await trySettings({
      engine, formulas: t.formulas, records: t.records, fields: t.fields, data: t.data, base: t.base, appFields: t.appFields, evType: t.evType, event: t.event, mobile: t.mobile, user: t.user,
      usersInfo, usersOrigin: job.usersOrigin, usersLabel, policy: job.policy, lang: job.lang
    });
    const warnings = r.results.reduce((n, x) => n + x.findings.filter((f) => f.level === "warning").length, 0);
    return { normalize: { summary: r.summary, hasErrors: r.results.some((x) => x.status !== "ok"), warnings, findings: [] }, try: r, engineWarnings: [...engine.warnings] };
  }
  if (job.settingsText === undefined || job.settingsFile === undefined || !job.fields) throw new InputError(`${job.kind} の仕事に設定か項目定義が無い（settingsText / settingsFile / fields）`);
  const res = await normalizeSettings({
    settingsText: job.settingsText, settingsFile: job.settingsFile, fields: job.fields, engine, policy: job.policy, check: job.check, lang: job.lang, usersInfo, usersLabel, usersOrigin: job.usersOrigin
  });
  const outcome: EvalOutcome = {
    normalize: {
      summary: res.summary, hasErrors: res.findings.hasErrors, warnings: res.findings.count("warning"), findings: [...res.findings.items],
      output: res.output, checkDiffs: res.checkDiffs, appId: res.appId, size: res.size
    },
    engineWarnings: [...engine.warnings]
  };
  if (job.kind === "calc" && job.calc && !res.findings.hasErrors) {
    const c = job.calc;
    const r = calcSettings({
      normalized: res, engine, fields: job.fields, appId: c.appId, records: c.records, evType: c.evType, event: c.event, mobile: c.mobile, user: c.user, click: c.click,
      usersInfo, usersOrigin: job.usersOrigin
    });
    outcome.calc = { text: r.text, failed: r.records.some((x) => x.errors.length > 0 || x.failed), records: r.records, contextLine: r.contextLine, notice: r.notice, summary: r.summary };
  }
  return outcome;
}
