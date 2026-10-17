/**
 * ユーザー情報のテストデータ → エンジンが読む表（rex0220_users_info3.data。formula の libs.ts の UsersInfoData と同じ形）。
 *   - 既定: default-users.ts（架空の 10 人）。--users <ファイル> で差し替える（同じ UsersSource の形の JSON）
 *   - カスタマイズ項目（customItemValues）は rex0220_users_info と同じく "#コード" のキーに平らにする（UINFO(…, "#boss")）
 *   - users[].orgs / groups（所属コードの配列）は organizations[].users / groups[].users から組む（UINFO の "orgs" / "groups"）
 */
import type { UsersSource, UserRecord } from "./default-users.ts";
import { DEFAULT_USERS } from "./default-users.ts";

export type UsersOrigin = { kind: "default" } | { kind: "file"; file: string };

/** エンジンが読む形（formula の libs.ts の UsersInfoData を any で持つ） */
export interface UsersInfoTable {
  users: Record<string, unknown>[];
  organizations: Record<string, unknown>[];
  groups: Record<string, unknown>[];
  userCodes: Record<string, Record<string, unknown>>;
  orgCodes: Record<string, Record<string, unknown>>;
  groupCodes: Record<string, Record<string, unknown>>;
  userIds: Record<string, string>;
  orgIds: Record<string, string>;
  groupIds: Record<string, string>;
}

export class UsersDataError extends Error {}

/** --users のファイルの中身を確かめる（形が違えば名指しで止める） */
export function validateUsersSource(v: unknown, from: string): UsersSource {
  const bad = (msg: string): never => { throw new UsersDataError(`ユーザー情報のテストデータ（${from}）: ${msg}`); };
  if (!v || typeof v !== "object" || Array.isArray(v)) bad("JSON のオブジェクトではない");
  const o = v as Record<string, unknown>;
  for (const k of ["users", "organizations", "groups"] as const) {
    if (!Array.isArray(o[k])) bad(`${k} が配列ではない`);
  }
  const codes = new Set<string>();
  (o.users as unknown[]).forEach((x, i) => {
    const r = x as Record<string, unknown>;
    if (!r || typeof r !== "object" || typeof r.code !== "string" || !r.code || typeof r.id !== "string" && typeof r.id !== "number") bad(`users[${i}] に code（文字列）と id が要る`);
    if (codes.has(r.code as string)) bad(`users の code が重複: ${String(r.code)}`);
    codes.add(r.code as string);
    if (r.customItemValues !== undefined && !Array.isArray(r.customItemValues)) bad(`users[${i}].customItemValues は [{ code, value }] の配列`);
  });
  for (const k of ["organizations", "groups"] as const) {
    (o[k] as unknown[]).forEach((x, i) => {
      const r = x as Record<string, unknown>;
      if (!r || typeof r !== "object" || typeof r.code !== "string" || !r.code) bad(`${k}[${i}] に code（文字列）が要る`);
      if (r.users !== undefined && !Array.isArray(r.users)) bad(`${k}[${i}].users は所属ユーザーのコードの配列`);
      for (const c of (r.users as unknown[] | undefined) ?? []) if (!codes.has(String(c))) bad(`${k}[${i}].users の ${String(c)} が users に無い`);
    });
  }
  return v as UsersSource;
}

/** テストデータ → エンジンの表 */
export function buildUsersInfo(src: UsersSource): UsersInfoTable {
  const t: UsersInfoTable = { users: [], organizations: [], groups: [], userCodes: {}, orgCodes: {}, groupCodes: {}, userIds: {}, orgIds: {}, groupIds: {} };
  const orgsOf: Record<string, string[]> = {};
  const groupsOf: Record<string, string[]> = {};
  for (const o of src.organizations) for (const c of o.users ?? []) (orgsOf[c] ??= []).push(o.code);
  for (const g of src.groups) for (const c of g.users ?? []) (groupsOf[c] ??= []).push(g.code);
  for (const user of src.users) {
    const { customItemValues, ...rest } = user as UserRecord;
    const r: Record<string, unknown> = { ...rest, id: String(user.id), orgs: orgsOf[user.code] ?? [], groups: groupsOf[user.code] ?? [] };
    for (const it of customItemValues ?? []) r[`#${it.code}`] = it.value;
    t.users.push(r);
    t.userCodes[user.code] = r;
    t.userIds[String(user.id)] = user.code;
  }
  for (const o of src.organizations) {
    const r: Record<string, unknown> = { ...o, id: String(o.id), users: [...(o.users ?? [])], children: [] };
    t.organizations.push(r);
    t.orgCodes[o.code] = r;
    t.orgIds[String(o.id)] = o.code;
  }
  for (const o of src.organizations) {
    if (o.parentCode && t.orgCodes[o.parentCode]) (t.orgCodes[o.parentCode].children as string[]).push(o.code);
  }
  for (const g of src.groups) {
    const r: Record<string, unknown> = { ...g, id: String(g.id), users: [...(g.users ?? [])] };
    t.groups.push(r);
    t.groupCodes[g.code] = r;
    t.groupIds[String(g.id)] = g.code;
  }
  return t;
}

export function defaultUsersInfo(): UsersInfoTable {
  return buildUsersInfo(DEFAULT_USERS);
}

/** テストデータの要約（人数・組織数・グループ数と、指定したユーザーが居るか。コードや名前は出さない） */
export function summarizeUsers(src: UsersSource, origin: UsersOrigin, user?: string): string {
  const where = origin.kind === "default" ? "既定のテストデータ（架空）" : origin.file;
  const lines = [`ユーザー情報: ${where}`, `ユーザー ${src.users.length} 人、組織 ${src.organizations.length}、グループ ${src.groups.length}`];
  if (user) lines.push(`--user で指定したユーザー: ${src.users.some((x) => x.code === user) ? "居る" : "居ない"}`);
  return lines.join("\n");
}

export { DEFAULT_USERS };
export type { UsersSource, UserRecord, OrgRecord, GroupRecord } from "./default-users.ts";
