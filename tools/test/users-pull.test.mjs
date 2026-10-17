import { test } from "node:test";
import assert from "node:assert/strict";
import { pullUsers, usersFileNameOf } from "../src/commands/users.ts";
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
