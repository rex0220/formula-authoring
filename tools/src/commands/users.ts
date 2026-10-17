/**
 * users --pull [--only-referenced <settings.json>] [--out users/<file>] [--force] [--max N] / users --summary [--users <file>] [--user <code>]
 * ユーザー・組織・グループと所属を User API（/v1/users、/v1/organizations、/v1/groups、/v1/organization/users、/v1/group/users）から取り、
 * users/<ホスト名>.json（UsersSource の形。--users で calc に渡す）に保存する。呼び出しは P(users) + P(orgs) + P(groups) + ΣP(組織の所属) + ΣP(グループの所属)
 * （P = ページ数。1 ページ 100）。実行前に見積もりを出す。個人情報を含むので records/ と同じ扱い（.gitignore、終わったら消す、AI は開かない）。
 * 認証は cybozu.com 共通管理の API トークン（Bearer）かログインユーザー（パスワード）。kintone アプリの API トークンでは呼べない。
 * --only-referenced <settings.json>（計画 4 章、Codex #11）: 設定の式が UINFO / OINFO / GINFO / OUSERS / GUSERS の 1 つ目の引数に文字列で書いた
 * コードだけを取る（組織・グループの所属のユーザー、ユーザーの所属組織・グループ、組織の親も）。呼び出しは codes[] と user/organizations、user/groups で
 * 参照の数に比例する。1 つ目の引数が無い（ログインユーザー）・項目の値・入れ子の式なら使えない（CLI は全部取る）。
 */
import type { RestClient } from "../kintone-rest.ts";
import type { GroupRecord, OrgRecord, UserRecord, UsersSource } from "../users/index.ts";

const PAGE = 100;
/** codes[] で 1 回に渡せる数（User API は 1 回 100 件まで） */
const CODES_PER_CALL = 100;
/** 1 回の pull で呼ぶ API の上限（暴走の保険。組織 + グループが多いドメインは --max で上げる） */
export const DEFAULT_MAX_CALLS = 300;

export interface PullUsersOptions {
  maxCalls?: number;
  /** 進み具合の表示（CLI） */
  log?: (line: string) => void;
}

export class UsersPullError extends Error {}

type Page<T> = Record<string, T[]>;

async function all<T>(client: RestClient, api: Parameters<RestClient["getUser"]>[0], key: string, params: Record<string, string | number | boolean | undefined>, budget: { calls: number; max: number }): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    if (++budget.calls > budget.max) throw new UsersPullError(`User API の呼び出しが ${budget.max} 回を超えた（--max で上げるか、組織・グループの多いドメインでは取らない）`);
    const res = await client.getUser<Page<T>>(api, { ...params, size: PAGE, offset });
    const items = res[key] ?? [];
    out.push(...items);
    if (items.length < PAGE) return out;
  }
}

interface RawUser extends Record<string, unknown> { id: string; code: string; name: string; valid?: boolean; customItemValues?: Array<{ code: string; value: string }> }
interface RawOrg extends Record<string, unknown> { id: string; code: string; name: string; parentCode?: string | null }
interface RawGroup extends Record<string, unknown> { id: string; code: string; name: string }

export async function pullUsers(client: RestClient, opt: PullUsersOptions = {}): Promise<{ source: UsersSource; calls: number }> {
  const budget = { calls: 0, max: opt.maxCalls ?? DEFAULT_MAX_CALLS };
  const log = opt.log ?? (() => undefined);
  const users = await all<RawUser>(client, "users", "users", {}, budget);
  const orgs = await all<RawOrg>(client, "organizations", "organizations", {}, budget);
  const groups = await all<RawGroup>(client, "groups", "groups", {}, budget);
  log(`ユーザー ${users.length}、組織 ${orgs.length}、グループ ${groups.length}（ここまで ${budget.calls} 回）。所属をあと ${orgs.length + groups.length} 回以上`);
  const valid = users.filter((u) => u.valid !== false);
  const codes = new Set(valid.map((u) => u.code));
  const orgRecords: OrgRecord[] = [];
  for (const o of orgs) {
    const members = await all<{ user: { code: string } }>(client, "organization/users", "userTitles", { code: o.code }, budget);
    orgRecords.push({ id: String(o.id), code: o.code, name: o.name, parentCode: o.parentCode ?? null, users: members.map((m) => m.user?.code).filter((c): c is string => !!c && codes.has(c)) });
  }
  const groupRecords: GroupRecord[] = [];
  for (const g of groups) {
    const members = await all<{ code: string }>(client, "group/users", "users", { code: g.code }, budget);
    groupRecords.push({ id: String(g.id), code: g.code, name: g.name, users: members.map((m) => m.code).filter((c) => codes.has(c)) });
  }
  const userRecords: UserRecord[] = valid.map((u) => ({ ...(u as unknown as UserRecord), id: String(u.id), customItemValues: u.customItemValues ?? [] }));
  return { source: { users: userRecords, organizations: orgRecords, groups: groupRecords }, calls: budget.calls };
}

// ---- --only-referenced ----

/** ユーザー情報の関数と、1 つ目の引数のコードの種類 */
export const USER_INFO_FUNCTIONS: Readonly<Record<string, "users" | "orgs" | "groups">> = { UINFO: "users", OINFO: "orgs", OUSERS: "orgs", GINFO: "groups", GUSERS: "groups" };

export interface ReferencedCodes {
  users: string[];
  orgs: string[];
  groups: string[];
  /** 文字列で決まらない呼び出し（1 つ目の引数が無い = ログインユーザー、項目や変数、入れ子の式）。あれば --only-referenced は使えない。決まった文（項目: 関数） */
  dynamic: string[];
  /** 式を見た項目の数 */
  fields: number;
}

const CALL_RE = /(?<![A-Za-z0-9_$\u0080-\uFFFF])(UINFO|OINFO|GINFO|OUSERS|GUSERS)\s*\(\s*("(?:\\"|[^"])*"|[^,()]*)/g;

/**
 * 設定（封筒か元の値）の pluginInfos の式から、ユーザー情報の関数が 1 つ目の引数に文字列で書いたコードを集める（"a,b" はカンマ区切り）。
 * strip はコメントと改行を除く関数（engine の api.stripFormula。文字列の中の // も行末までコメント = 設定画面と同じ）
 */
export function referencedCodesOf(settings: Record<string, unknown>, strip: (formula: string) => string): ReferencedCodes {
  const out: ReferencedCodes = { users: [], orgs: [], groups: [], dynamic: [], fields: 0 };
  const rows = Array.isArray(settings.pluginInfos) ? (settings.pluginInfos as Array<Record<string, unknown>>) : [];
  const add = (kind: "users" | "orgs" | "groups", code: string): void => {
    if (!out[kind].includes(code)) out[kind].push(code);
  };
  for (const r of rows) {
    if (!r || typeof r.formulaSet !== "string" || !r.formulaSet.trim()) continue;
    out.fields++;
    const fieldcode = typeof r.fieldcode === "string" ? r.fieldcode : "?";
    const text = strip(r.formulaSet);
    for (const m of text.matchAll(CALL_RE)) {
      const fn = m[1];
      const arg = m[2].trim();
      const kind = USER_INFO_FUNCTIONS[fn];
      const literal = /^"(?:\\"|[^"])*"$/.test(arg) ? arg.slice(1, -1) : undefined;
      if (literal === undefined) {
        out.dynamic.push(`${fieldcode}: ${fn}(${arg ? "式" : "引数なし = ログインユーザー"})`);
        continue;
      }
      const codes = literal.split(",").map((c) => c.trim()).filter(Boolean);
      if (!codes.length) {
        out.dynamic.push(`${fieldcode}: ${fn}("") = ログインユーザー`);
        continue;
      }
      for (const c of codes) add(kind, c);
    }
  }
  return out;
}

async function byCodes<T extends { code: string }>(client: RestClient, api: "users" | "organizations" | "groups", key: string, codes: readonly string[], budget: { calls: number; max: number }): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < codes.length; i += CODES_PER_CALL) {
    if (++budget.calls > budget.max) throw new UsersPullError(`User API の呼び出しが ${budget.max} 回を超えた（--max で上げる）`);
    const res = await client.getUser<Page<T>>(api, { codes: codes.slice(i, i + CODES_PER_CALL), size: PAGE });
    out.push(...(res[key] ?? []));
  }
  return out;
}

const uniq = (a: readonly string[]): string[] => [...new Set(a)];
const missingOf = (want: readonly string[], have: Iterable<{ code: string }>): string[] => {
  const got = new Set([...have].map((x) => x.code));
  return want.filter((c) => !got.has(c));
};

/** 参照しているコードとその所属だけを取る（referencedCodesOf の結果。dynamic が無いときだけ呼ぶ） */
export async function pullReferencedUsers(client: RestClient, ref: ReferencedCodes, opt: PullUsersOptions = {}): Promise<{ source: UsersSource; calls: number }> {
  const budget = { calls: 0, max: opt.maxCalls ?? DEFAULT_MAX_CALLS };
  const log = opt.log ?? (() => undefined);
  const one = async <T,>(api: "organization/users" | "group/users", key: string, code: string): Promise<T[]> => all<T>(client, api, key, { code }, budget);
  // 1. 参照している組織・グループの所属
  const orgMembers = new Map<string, string[]>();
  for (const o of uniq(ref.orgs)) orgMembers.set(o, (await one<{ user?: { code?: string } }>("organization/users", "userTitles", o)).map((m) => m.user?.code).filter((c): c is string => !!c));
  const groupMembers = new Map<string, string[]>();
  for (const g of uniq(ref.groups)) groupMembers.set(g, (await one<{ code?: string }>("group/users", "users", g)).map((m) => m.code).filter((c): c is string => !!c));
  // 2. ユーザー（参照 + 所属）
  const userCodes = uniq([...ref.users, ...[...orgMembers.values()].flat(), ...[...groupMembers.values()].flat()]);
  const rawUsers = userCodes.length ? await byCodes<RawUser>(client, "users", "users", userCodes, budget) : [];
  const missingUsers = missingOf(ref.users, rawUsers);
  if (missingUsers.length) throw new UsersPullError(`式が参照しているユーザーが無い: ${missingUsers.slice(0, 5).join(", ")}（コードを確かめる。全部取るなら --only-referenced を外す）`);
  const valid = rawUsers.filter((u) => u.valid !== false);
  log(`ユーザー ${valid.length}（参照 ${ref.users.length}、組織 ${ref.orgs.length} とグループ ${ref.groups.length} の所属を含む。ここまで ${budget.calls} 回）。所属をあと ${valid.length * 2} 回`);
  // 3. ユーザーの所属組織・グループ（UINFO の orgs / groups、OINFO の親に要る）
  const userOrgs = new Map<string, RawOrg[]>();
  const userGroups = new Map<string, RawGroup[]>();
  for (const u of valid) {
    if ((budget.calls += 2) > budget.max) throw new UsersPullError(`User API の呼び出しが ${budget.max} 回を超えた（--max で上げる）`);
    const o = await client.getUser<{ organizationTitles?: Array<{ organization?: RawOrg }> }>("user/organizations", { code: u.code });
    userOrgs.set(u.code, (o.organizationTitles ?? []).map((t) => t.organization).filter((x): x is RawOrg => !!x && typeof x.code === "string"));
    const g = await client.getUser<{ groups?: RawGroup[] }>("user/groups", { code: u.code });
    userGroups.set(u.code, (g.groups ?? []).filter((x) => !!x && typeof x.code === "string"));
  }
  // 4. 組織（参照 + 所属 + 親をたどる）
  const orgDetail = new Map<string, RawOrg>();
  for (const list of userOrgs.values()) for (const o of list) orgDetail.set(o.code, o);
  const parentsOf = (orgs: Iterable<RawOrg>): string[] => uniq([...orgs].map((o) => o.parentCode).filter((c): c is string => !!c));
  let pending = uniq([...ref.orgs, ...parentsOf(orgDetail.values())]).filter((c) => !orgDetail.has(c));
  while (pending.length) {
    const got = await byCodes<RawOrg>(client, "organizations", "organizations", pending, budget);
    for (const o of got) orgDetail.set(o.code, o);
    const missing = pending.filter((c) => !orgDetail.has(c));
    if (missing.length) throw new UsersPullError(`式が参照している組織が無い: ${missing.slice(0, 5).join(", ")}（コードを確かめる。全部取るなら --only-referenced を外す）`);
    pending = parentsOf(got).filter((c) => !orgDetail.has(c));
  }
  // 5. グループ（参照 + 所属）
  const groupDetail = new Map<string, RawGroup>();
  for (const list of userGroups.values()) for (const g of list) groupDetail.set(g.code, g);
  const gPending = uniq(ref.groups).filter((c) => !groupDetail.has(c));
  if (gPending.length) {
    for (const g of await byCodes<RawGroup>(client, "groups", "groups", gPending, budget)) groupDetail.set(g.code, g);
    const missing = gPending.filter((c) => !groupDetail.has(c));
    if (missing.length) throw new UsersPullError(`式が参照しているグループが無い: ${missing.slice(0, 5).join(", ")}（コードを確かめる。全部取るなら --only-referenced を外す）`);
  }
  // 6. 組み立て（所属は取ったユーザーの範囲だけ。id の順）
  const byId = (a: { id: string }, b: { id: string }): number => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id));
  const orgRecords: OrgRecord[] = [...orgDetail.values()].map((o) => ({
    id: String(o.id), code: o.code, name: o.name, parentCode: o.parentCode ?? null,
    users: valid.filter((u) => (orgMembers.get(o.code) ?? []).includes(u.code) || (userOrgs.get(u.code) ?? []).some((x) => x.code === o.code)).map((u) => u.code)
  })).sort(byId);
  const groupRecords: GroupRecord[] = [...groupDetail.values()].map((g) => ({
    id: String(g.id), code: g.code, name: g.name,
    users: valid.filter((u) => (groupMembers.get(g.code) ?? []).includes(u.code) || (userGroups.get(u.code) ?? []).some((x) => x.code === g.code)).map((u) => u.code)
  })).sort(byId);
  const userRecords: UserRecord[] = valid.map((u) => ({ ...(u as unknown as UserRecord), id: String(u.id), customItemValues: u.customItemValues ?? [] })).sort(byId);
  return { source: { users: userRecords, organizations: orgRecords, groups: groupRecords }, calls: budget.calls };
}

/** 出力のファイル名（ホスト名。例 users/example.cybozu.com.json） */
export function usersFileNameOf(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).hostname}.json`;
  } catch {
    return "users.json";
  }
}
