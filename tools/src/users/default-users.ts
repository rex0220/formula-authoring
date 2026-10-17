/**
 * 既定のテストデータ（架空のユーザー・組織・グループ。2026-10-17 Takashi「既定でテストデータを持ち、オプションでファイル指定で与える」「10 人。kintone の最低契約ユーザー数が 10」
 * 「ユーザーカスタム情報で boss で上司を追加」）。UINFO 系の関数（UINFO / OINFO / GINFO / OUSERS / GUSERS）の calc に使う。
 * 実在しない人・組織・メール（example.com）。コードと名前は架空と分かる形（demo_user01 / 架空ユーザー01）。
 * 形は kintone の User API（/v1/users、/v1/organizations、/v1/groups）の返り値に寄せ、所属は organizations[].users / groups[].users に持つ（--users のファイルも同じ形）。
 * カスタマイズ項目は customItemValues: [{ code, value }]（rex0220_users_info と同じく "#コード" に平らにする。users/index.ts）。
 */
export interface UserRecord {
  id: string;
  code: string;
  name: string;
  surName?: string;
  givenName?: string;
  surNameReading?: string;
  givenNameReading?: string;
  localName?: string;
  localNameLocale?: string;
  email?: string;
  timezone?: string;
  locale?: string;
  valid?: boolean;
  description?: string;
  phone?: string;
  mobilePhone?: string;
  extensionNumber?: string;
  callto?: string;
  url?: string;
  employeeNumber?: string;
  birthDate?: string;
  joinDate?: string;
  sortOrder?: number;
  primaryOrganization?: string | null;
  ctime?: string;
  mtime?: string;
  customItemValues?: Array<{ code: string; value: string }>;
}

export interface OrgRecord {
  id: string;
  code: string;
  name: string;
  localName?: string;
  localNameLocale?: string;
  parentCode?: string | null;
  description?: string;
  /** 所属ユーザーのコード（/v1/organization/users の結果を平らにしたもの） */
  users: string[];
}

export interface GroupRecord {
  id: string;
  code: string;
  name: string;
  description?: string;
  users: string[];
}

export interface UsersSource {
  users: UserRecord[];
  organizations: OrgRecord[];
  groups: GroupRecord[];
}

const u = (id: number, code: string, name: string, surName: string, givenName: string, boss: string, opt: Partial<UserRecord> = {}): UserRecord => ({
  id: String(id), code, name, surName, givenName,
  surNameReading: opt.surNameReading ?? "", givenNameReading: opt.givenNameReading ?? "",
  localName: opt.localName ?? "", localNameLocale: opt.localNameLocale ?? "en",
  email: `${code}@example.com`, timezone: opt.timezone ?? "Asia/Tokyo", locale: opt.locale ?? "ja", valid: true,
  description: opt.description ?? "既定のテストデータ（架空）", phone: "", mobilePhone: "", extensionNumber: String(1000 + id), callto: "", url: "",
  employeeNumber: `E${String(id).padStart(4, "0")}`, birthDate: "", joinDate: `20${String(10 + (id % 10)).padStart(2, "0")}-04-01`, sortOrder: id,
  primaryOrganization: opt.primaryOrganization ?? null,
  ctime: "2026-01-01T00:00:00Z", mtime: "2026-01-01T00:00:00Z",
  customItemValues: [{ code: "boss", value: boss }]
});

/** 既定のテストデータ（10 人。authoring を含む。boss は上司のログイン名。社長（demo_user01）だけ空） */
export const DEFAULT_USERS: UsersSource = {
  users: [
    u(1, "demo_user01", "架空 社長", "架空", "社長", "", { surNameReading: "かくう", givenNameReading: "しゃちょう", primaryOrganization: "100" }),
    u(2, "demo_user02", "架空 営業部長", "架空", "営業部長", "demo_user01", { primaryOrganization: "110" }),
    u(3, "demo_user03", "架空 開発部長", "架空", "開発部長", "demo_user01", { primaryOrganization: "120" }),
    u(4, "demo_user04", "架空 営業一郎", "架空", "営業一郎", "demo_user02", { primaryOrganization: "110" }),
    u(5, "demo_user05", "架空 営業二郎", "架空", "営業二郎", "demo_user02", { primaryOrganization: "110", locale: "en", timezone: "America/Los_Angeles", localName: "Demo Sales 2" }),
    u(6, "demo_user06", "架空 開発花子", "架空", "開発花子", "demo_user03", { primaryOrganization: "121" }),
    u(7, "demo_user07", "架空 開発太郎", "架空", "開発太郎", "demo_user03", { primaryOrganization: "121", locale: "en", timezone: "Asia/Singapore" }),
    u(8, "demo_user08", "架空 総務一子", "架空", "総務一子", "demo_user01", { primaryOrganization: "100" }),
    u(9, "demo_user09", "架空 派遣次郎", "架空", "派遣次郎", "demo_user02", { primaryOrganization: "110", description: "既定のテストデータ（架空）。グループには入っていない" }),
    u(10, "authoring", "架空 オーサリング", "架空", "オーサリング", "demo_user03", { primaryOrganization: "121", description: "既定のテストデータ（架空）。calc の既定のログインユーザー" })
  ],
  organizations: [
    { id: "100", code: "demo_hq", name: "架空本社", parentCode: null, users: ["demo_user01", "demo_user08"] },
    { id: "110", code: "demo_sales", name: "架空営業部", parentCode: "demo_hq", users: ["demo_user02", "demo_user04", "demo_user05", "demo_user09"] },
    { id: "120", code: "demo_dev", name: "架空開発部", parentCode: "demo_hq", users: ["demo_user03"] },
    { id: "121", code: "demo_dev1", name: "架空開発1課", parentCode: "demo_dev", users: ["demo_user06", "demo_user07", "authoring"] }
  ],
  groups: [
    { id: "200", code: "demo_managers", name: "架空管理職", users: ["demo_user01", "demo_user02", "demo_user03"] },
    { id: "201", code: "demo_approvers", name: "架空承認者", users: ["demo_user02", "demo_user03", "demo_user08"] }
  ]
};
