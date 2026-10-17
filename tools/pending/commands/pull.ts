/**
 * pull --app N [--preview] [--guest S] [--out settings/<file>] [--force] [--plugin-id <id>]
 * アプリに入っている印刷屋プラグインの今の設定を kintone から取って、設定画面の「設定をダウンロード」と同じ封筒形式で settings/ に保存する
 * （Takashi 2026-10-05「対象は、tools のみで GET だけ。プラグインは対象外」）。
 *   - API は kintone の API ラボ「アプリに追加されているプラグインの設定情報を取得する」（GET /k/v1/app/plugin/config.json、
 *     動作テスト環境は /k/v1/preview/app/plugin/config.json）。使うには cybozu.com 共通管理者がアップデートオプションの「検討中の新機能」で
 *     「アプリに追加されているプラグインの設定情報を取得または更新するREST API」を有効にする。変更の PUT は呼ばない（tools は GET だけ）
 *   - 権限: 運用中の設定はレコード閲覧（API トークンでも可。資料は「閲覧と追加」だが閲覧だけで取れた。2026-10-09 アプリ 3740 で確かめた）、
 *     --preview（動作テスト環境 = 設定画面で保存してまだ反映していないもの）はアプリ管理（閲覧だけのトークンでは 403 GAIA_NO01）
 *   - プラグイン ID は印刷屋の zip の PUBKEY から（plugin-zip.ts の pluginIdOf。5 変種とも同じ）
 *   - 保存値は設定画面と同じ手順で読む: kit の readConfig（圧縮形式など）→ 設定のスキーマで検証（未知のキーと共通項目の更新日時などは落ちる）
 */
import type { RestClient } from "../kintone-rest.ts";
import type { Engine } from "../engine.ts";
import { InputError, PLUGIN_NAME } from "./normalize.ts";
import { safeFileName } from "../safe-path.ts";

export interface PullOptions {
  app: number;
  /** 動作テスト環境の設定（既定は運用中） */
  preview?: boolean;
  guestSpaceId?: number;
  pluginId: string;
  now?: () => Date;
}

export interface PullResult {
  envelope: Record<string, unknown>;
  appName: string;
  revision: string;
  /** 保存値の形式（compressed など。kit の readConfig） */
  format: string;
}

export const PLUGIN_ID_PATTERN = /^[a-p]{32}$/;

export async function pullSettings(client: RestClient, engine: Engine, opt: PullOptions): Promise<PullResult> {
  if (!PLUGIN_ID_PATTERN.test(opt.pluginId)) throw new InputError(`プラグイン ID の形が違う: ${opt.pluginId}（a〜p の 32 文字）`);
  const app = await client.get<{ appId: string; name: string }>("app", { id: opt.app }, opt.guestSpaceId);
  const res = await client.get<{ config?: Record<string, unknown>; revision?: string | number }>(opt.preview ? "preview/app/plugin/config" : "app/plugin/config", { app: opt.app, id: opt.pluginId }, opt.guestSpaceId);
  const stored = res.config && typeof res.config === "object" && !Array.isArray(res.config) ? res.config : {};
  if (Object.keys(stored).length === 0) throw new InputError(`アプリ ${opt.app} の印刷屋の設定が空（${opt.preview ? "動作テスト環境" : "運用中"}。設定画面でまだ保存していないか、${opt.preview ? "" : "保存して運用環境に反映していないか、"}別のプラグイン ID）`);
  for (const [k, v] of Object.entries(stored)) if (typeof v !== "string") throw new InputError(`プラグインの設定の値が文字列でない: ${k}`);
  const api = engine.api;
  const { data, format } = await api.readConfig(stored as Record<string, string>);
  const raw = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const body = api.validate<Record<string, unknown>>(raw, api.CONFIG_SCHEMA, api.CONFIG_LIMITS);
  const envelope = api.buildExportData({ pluginName: PLUGIN_NAME, pluginId: api.pluginId, pluginVersion: engine.source.pluginVersion, appId: opt.app, appName: app.name }, body, (opt.now ?? (() => new Date()))());
  return { envelope, appName: app.name, revision: String(res.revision ?? ""), format };
}

/**
 * 既定の保存先のファイル名 APP<番号>-<アプリ名>.json（ファイル名に使えない文字は _。safe-path.ts の safeFileName）。
 * テンプレートの settings/ の決まり（APP3740-見積書-ご提案書.json）とそろえる（2026-10-06 Takashi「APP3740- がよいのでは？」）
 */
export function defaultPullName(appName: string, appId: number): string {
  const name = safeFileName(appName, "");
  return name ? `APP${appId}-${name}.json` : `APP${appId}.json`;
}
