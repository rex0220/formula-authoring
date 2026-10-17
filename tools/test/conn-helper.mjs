/**
 * 試験の共通（tools 2.0.0）: kintone の接続のファイル（作業フォルダーの外）と、profile の形の作業フォルダー。
 * 接続のファイルは base/connections.json、作業フォルダーは base/ws（実際のパス。macOS の /var → /private/var をそろえる）
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { realResolve } from "../src/safe-path.ts";
import { ensureAppFolder, modeOf } from "../src/workspace.ts";
import { pickProfile } from "../src/connections.ts";

/** 開発（dev-x）と本番（x）の 2 つの profile。トークンは直接書いた試験の値 */
export const CONN = {
  defaultProfile: "dev",
  profiles: {
    dev: { baseUrl: "https://dev-x.cybozu.com", tokenMap: { APP101: "dev-token-101", APP3740: "dev-token-3740" } },
    prod: { baseUrl: "https://x.cybozu.com", tokenMap: { APP3740: "prod-token-3740" } }
  }
};

export function makeConnWorkspace(conn = CONN, prefix = "pcraft-conn-ws-") {
  const base = realResolve(".", mkdtempSync(path.join(os.tmpdir(), prefix)));
  const root = path.join(base, "ws");
  mkdirSync(root);
  const connFile = path.join(base, "connections.json");
  const writeConn = (data) => writeFileSync(connFile, JSON.stringify(data), { mode: 0o600 });
  writeConn(conn);
  /** 接続のファイルを読んだ動く形（CLI と同じ） */
  const mode = (env = {}) => modeOf(root, { configFile: connFile, workspaceRoots: [root], env, surface: "cli" });
  /** profile のアプリのフォルダーを印付きで作る（fields を渡せば fields.json も置く）。フォルダーのパスを返す */
  const appFolder = (profile, appId, name, fields) => {
    const m = mode();
    const def = pickProfile(m.connections.set, profile);
    const dir = path.join(root, "kintone", profile, `${appId}-${name}`);
    ensureAppFolder(dir, def, appId);
    if (fields) writeFileSync(path.join(dir, "fields.json"), JSON.stringify(fields));
    return dir;
  };
  return { base, root, connFile, writeConn, mode, appFolder, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
