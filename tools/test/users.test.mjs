import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_USERS, buildUsersInfo, validateUsersSource, summarizeUsers } from "../src/users/index.ts";

test("既定のテストデータ: 10 人、authoring を含む、boss は社長だけ空、所属が組織・グループから組まれる、#boss に平ら", () => {
  assert.equal(DEFAULT_USERS.users.length, 10);
  const t = buildUsersInfo(DEFAULT_USERS);
  assert.equal(t.users.length, 10);
  assert.ok(t.userCodes.authoring);
  assert.equal(t.userCodes.demo_user01["#boss"], "");
  assert.equal(t.userCodes.authoring["#boss"], "demo_user03");
  assert.deepEqual(t.userCodes.authoring.orgs, ["demo_dev1"]);
  assert.deepEqual(t.userCodes.demo_user02.groups, ["demo_managers", "demo_approvers"]);
  assert.equal(t.userIds["10"], "authoring");
  assert.equal(t.orgIds["121"], "demo_dev1");
  assert.deepEqual(t.orgCodes.demo_hq.children, ["demo_sales", "demo_dev"]);
  assert.ok(t.users.every((u) => String(u.email).endsWith("@example.com")), "実在しないメール");
  assert.ok(!("customItemValues" in t.userCodes.authoring));
});

test("--users のファイルの検査: 形の誤りを名指しで止める", () => {
  assert.throws(() => validateUsersSource([], "x.json"), /オブジェクトではない/);
  assert.throws(() => validateUsersSource({ users: [], organizations: [] }, "x.json"), /groups が配列ではない/);
  assert.throws(() => validateUsersSource({ users: [{ id: "1" }], organizations: [], groups: [] }, "x.json"), /users\[0\] に code/);
  assert.throws(() => validateUsersSource({ users: [{ id: "1", code: "a" }, { id: "2", code: "a" }], organizations: [], groups: [] }, "x.json"), /重複/);
  assert.throws(() => validateUsersSource({ users: [{ id: "1", code: "a" }], organizations: [{ id: "1", code: "o", users: ["zz"] }], groups: [] }, "x.json"), /zz が users に無い/);
  const ok = validateUsersSource({ users: [{ id: "1", code: "a", name: "A", customItemValues: [{ code: "boss", value: "" }] }], organizations: [], groups: [] }, "x.json");
  assert.equal(buildUsersInfo(ok).userCodes.a["#boss"], "");
});

test("summary はコードや名前を出さない", () => {
  const s = summarizeUsers(DEFAULT_USERS, { kind: "default" }, "authoring");
  assert.match(s, /既定のテストデータ（架空）/);
  assert.match(s, /10 人、組織 4、グループ 2/);
  assert.match(s, /--user で指定したユーザー: 居る/);
  assert.ok(!/authoring/.test(s), "コードを出さない");
  assert.ok(!/demo_user01|架空 社長/.test(s));
});
