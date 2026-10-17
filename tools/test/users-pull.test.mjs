import { test } from "node:test";
import assert from "node:assert/strict";
import { pullReferencedUsers, pullUsers, referencedCodesOf, usersFileNameOf } from "../src/commands/users.ts";
import { buildUsersInfo } from "../src/users/index.ts";

function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    baseUrl: "https://example.cybozu.com",
    async get() { throw new Error("not used"); },
    async getUser(api, params) {
      calls.push([api, params.code ?? "", params.offset]);
      const key = api === "organization/users" ? "userTitles" : api === "group/users" ? "users" : api;
      const all = pages[api + (params.code ? ":" + params.code : "")] ?? [];
      return { [key]: all.slice(params.offset, params.offset + params.size) };
    }
  };
}

test("users --pull: ページング、所属、無効なユーザーを除く、呼び出し回数", async () => {
  const users = Array.from({ length: 150 }, (_, i) => ({ id: String(i + 1), code: `u${i + 1}`, name: `User ${i + 1}`, valid: i !== 2, customItemValues: [{ code: "boss", value: i ? "u1" : "" }] }));
  const client = fakeClient({
    users,
    organizations: [{ id: "10", code: "hq", name: "HQ", parentCode: null }, { id: "11", code: "dev", name: "Dev", parentCode: "hq" }],
    groups: [{ id: "20", code: "g1", name: "G1" }],
    "organization/users:hq": [{ user: { code: "u1" } }],
    "organization/users:dev": [{ user: { code: "u2" } }, { user: { code: "u3" } }],
    "group/users:g1": [{ code: "u1" }, { code: "u3" }, { code: "zz" }]
  });
  const r = await pullUsers(client, { log: () => {} });
  assert.equal(r.source.users.length, 149, "無効な u3 を除く");
  assert.deepEqual(r.source.organizations.map((o) => [o.code, o.users]), [["hq", ["u1"]], ["dev", ["u2"]]], "無効なユーザーは所属からも除く");
  assert.deepEqual(r.source.groups[0].users, ["u1"]);
  assert.equal(r.calls, 2 + 1 + 1 + 2 + 1, "users 2 ページ + orgs + groups + 組織 2 + グループ 1");
  const t = buildUsersInfo(r.source);
  assert.equal(t.userCodes.u2["#boss"], "u1");
  assert.deepEqual(t.userCodes.u2.orgs, ["dev"]);
  await assert.rejects(pullUsers(client, { maxCalls: 3, log: () => {} }), /呼び出しが 3 回を超えた/);
});

test("usersFileNameOf", () => {
  assert.equal(usersFileNameOf("https://example.cybozu.com"), "example.cybozu.com.json");
});

// ---- --only-referenced（工程 1 の後半。Codex #11） ----

const strip = (f) => f.replace(/\/\/.*$/gm, "");

test("referencedCodesOf: UINFO / OINFO / GINFO / OUSERS / GUSERS の 1 つ目の引数の文字列（カンマ区切り）を集める。引数なし・項目・式・空文字は dynamic", () => {
  const settings = {
    pluginInfos: [
      { fieldcode: "a", formulaSet: 'UINFO("u1", "name") & OUSERS("dev") // UINFO("comment")' },
      { fieldcode: "b", formulaSet: 'GINFO("g1, g2") & GUSERS("g1") & OINFO("hq", "#boss")' },
      { fieldcode: "c", formulaSet: "SUM(金額)" },
      { fieldcode: "d", formulaSet: "" }
    ]
  };
  const r = referencedCodesOf(settings, strip);
  assert.deepEqual({ users: r.users, orgs: r.orgs, groups: r.groups, dynamic: r.dynamic, fields: r.fields }, { users: ["u1"], orgs: ["dev", "hq"], groups: ["g1", "g2"], dynamic: [], fields: 3 });
  const dyn = referencedCodesOf({ pluginInfos: [
    { fieldcode: "e", formulaSet: "UINFO()" },
    { fieldcode: "f", formulaSet: "UINFO(LOGIN_CODE(), \"name\")" },
    { fieldcode: "g", formulaSet: "OINFO(組織)" },
    { fieldcode: "h", formulaSet: 'UINFO("", "name")' },
    { fieldcode: "i", formulaSet: 'MYUINFO("x")' }
  ] }, strip);
  assert.deepEqual(dyn.dynamic, ["e: UINFO(引数なし = ログインユーザー)", "f: UINFO(式)", "g: OINFO(式)", 'h: UINFO("") = ログインユーザー']);
  assert.deepEqual(dyn.users, [], "MYUINFO は対象外");
});

function fakeClient2(data) {
  const calls = [];
  const page = (items, params) => items.slice(params.offset ?? 0, (params.offset ?? 0) + (params.size ?? 100));
  return {
    calls,
    baseUrl: "https://example.cybozu.com",
    async get() { throw new Error("not used"); },
    async getUser(api, params) {
      calls.push([api, params.code ?? (params.codes ? params.codes.join("|") : "")]);
      switch (api) {
        case "users": return { users: data.users.filter((u) => !params.codes || params.codes.includes(u.code)) };
        case "organizations": return { organizations: data.orgs.filter((o) => !params.codes || params.codes.includes(o.code)) };
        case "groups": return { groups: data.groups.filter((g) => !params.codes || params.codes.includes(g.code)) };
        case "organization/users": return { userTitles: page(data.orgUsers[params.code] ?? [], params).map((c) => ({ user: { code: c } })) };
        case "group/users": return { users: page(data.groupUsers[params.code] ?? [], params).map((c) => ({ code: c })) };
        case "user/organizations": return { organizationTitles: data.orgs.filter((o) => (data.orgUsers[o.code] ?? []).includes(params.code)).map((o) => ({ organization: o })) };
        case "user/groups": return { groups: data.groups.filter((g) => (data.groupUsers[g.code] ?? []).includes(params.code)) };
        default: throw new Error(`unexpected ${api}`);
      }
    }
  };
}

test("pullReferencedUsers: 参照したコードと、組織・グループの所属、ユーザーの所属、組織の親だけ。無効なユーザーは除く。呼び出しは参照の数に比例", async () => {
  const data = {
    users: [
      { id: "1", code: "u1", name: "U1", valid: true, customItemValues: [{ code: "boss", value: "" }] },
      { id: "2", code: "u2", name: "U2", valid: true, customItemValues: [{ code: "boss", value: "u1" }] },
      { id: "3", code: "u3", name: "U3", valid: false },
      { id: "9", code: "u9", name: "U9", valid: true }
    ],
    orgs: [{ id: "10", code: "hq", name: "HQ", parentCode: null }, { id: "11", code: "dev", name: "Dev", parentCode: "hq" }, { id: "12", code: "sales", name: "Sales", parentCode: "hq" }],
    groups: [{ id: "20", code: "g1", name: "G1" }, { id: "21", code: "g2", name: "G2" }],
    orgUsers: { hq: [], dev: ["u2", "u3"], sales: ["u9"] },
    groupUsers: { g1: ["u1", "u2"], g2: ["u9"] }
  };
  const client = fakeClient2(data);
  const r = await pullReferencedUsers(client, { users: ["u1"], orgs: ["dev"], groups: ["g1"], dynamic: [], fields: 2 }, { log: () => {} });
  assert.deepEqual(r.source.users.map((u) => u.code), ["u1", "u2"], "u3 は無効、u9 は参照していない");
  assert.deepEqual(r.source.organizations.map((o) => [o.code, o.parentCode, o.users]), [["hq", null, []], ["dev", "hq", ["u2"]]], "参照した dev とその親 hq。sales は取らない");
  assert.deepEqual(r.source.groups.map((g) => [g.code, g.users]), [["g1", ["u1", "u2"]]]);
  assert.equal(r.calls, 1 + 1 + 1 + 2 * 2 + 1, "組織の所属 1 + グループの所属 1 + users 1 + ユーザーごとの所属 2 × 2 + 親の組織 1");
  assert.deepEqual(client.calls.filter((c) => c[0] === "organizations"), [["organizations", "hq"]], "dev は user/organizations で取れたので hq だけ");
  await assert.rejects(pullReferencedUsers(fakeClient2(data), { users: ["zz"], orgs: [], groups: [], dynamic: [], fields: 1 }, { log: () => {} }), /ユーザーが無い: zz/);
  await assert.rejects(pullReferencedUsers(fakeClient2(data), { users: [], orgs: ["nope"], groups: [], dynamic: [], fields: 1 }, { log: () => {} }), /組織が無い: nope/);
  await assert.rejects(pullReferencedUsers(fakeClient2(data), { users: ["u1"], orgs: [], groups: [], dynamic: [], fields: 1 }, { maxCalls: 2, log: () => {} }), /2 回を超えた/);
});
