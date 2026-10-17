/**
 * users --pull [--out users/<file>] [--force] / users --summary [--users <file>] [--user <code>]
 * ユーザー・組織・グループと所属を User API（/v1/users、/v1/organizations、/v1/groups、/v1/organization/users、/v1/group/users）から取り、
 * users/<ホスト名>.json（UsersSource の形。--users で calc に渡す）に保存する。呼び出しは P(users) + P(orgs) + P(groups) + ΣP(組織の所属) + ΣP(グループの所属)
 * （P = ページ数。1 ページ 100）。実行前に見積もりを出す。個人情報を含むので records/ と同じ扱い（.gitignore、終わったら消す、AI は開かない）。
 * 認証はログインユーザー（パスワード。kintone アプリの API トークンでは呼べない）。
 */
import type { RestClient } from "../kintone-rest.ts";
import type { GroupRecord, OrgRecord, UserRecord, UsersSource } from "../users/index.ts";

const PAGE = 100;
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

/** 出力のファイル名（ホスト名。例 users/example.cybozu.com.json） */
export function usersFileNameOf(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).hostname}.json`;
  } catch {
    return "users.json";
  }
}
