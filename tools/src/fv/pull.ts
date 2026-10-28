/**
 * fv pull --app N [--preview] [--guest S] [--out settings/<f>.json] [--force]
 * アプリに入っている項目検証の今の設定を kintone から取り、元の値だけの封筒にする（計算式の pull と同じ API ラボの GET。tools は GET だけ）。
 * 保存値は計算式の zip の kit の readConfig で読む（項目検証の保存の形 compress "2" と同じ）。封筒の PluginVersion は tools が知る項目検証の最新の版
 * （インストールされている版は、この API では分からない。tools が扱うのは Ver.72 からで、保存値の形は Ver.71 と同じ）
 */
import type { RestClient } from "../kintone-rest.ts";
import type { Engine } from "../engine.ts";
import { InputError } from "../input.ts";
import { safeFileName } from "../safe-path.ts";
import { FV_CONFIG_PLUGIN_ID, FV_ENGINES, FV_PLUGIN_ID } from "./meta.ts";
import { fvSourceOf } from "./model.ts";
import { FV_PLUGIN_NAME } from "./normalize.ts";

export interface FvPullOptions {
  app: number;
  preview?: boolean;
  guestSpaceId?: number;
  now?: () => Date;
}

export async function fvPullSettings(client: RestClient, engine: Engine, opt: FvPullOptions): Promise<{ envelope: Record<string, unknown>; appName: string; revision: string; format: string }> {
  const app = await client.get<{ appId: string; name: string }>("app", { id: opt.app }, opt.guestSpaceId);
  const res = await client.get<{ config?: Record<string, unknown>; revision?: string | number }>(opt.preview ? "preview/app/plugin/config" : "app/plugin/config", { app: opt.app, id: FV_PLUGIN_ID }, opt.guestSpaceId);
  const stored = res.config && typeof res.config === "object" && !Array.isArray(res.config) ? res.config : {};
  if (Object.keys(stored).length === 0) throw new InputError(`アプリ ${opt.app} の項目検証プラグインの設定が空（${opt.preview ? "動作テスト環境" : "運用中"}。設定画面でまだ保存していないか、${opt.preview ? "" : "保存して運用環境に反映していないか、"}プラグインを追加していない）`);
  for (const [k, v] of Object.entries(stored)) if (typeof v !== "string") throw new InputError(`プラグインの設定の値が文字列でない: ${k}`);
  const { data, format } = await engine.api.readConfig(stored as Record<string, string>);
  const body = fvSourceOf(data) as unknown as Record<string, unknown>;
  const meta = { pluginName: FV_PLUGIN_NAME, pluginId: FV_CONFIG_PLUGIN_ID, pluginVersion: String(FV_ENGINES[FV_ENGINES.length - 1].fvVersion), appId: opt.app, appName: app.name };
  const envelope = engine.api.buildExportData(meta, body, (opt.now ?? (() => new Date()))()) as unknown as Record<string, unknown>;
  return { envelope, appName: app.name, revision: String(res.revision ?? ""), format };
}

/** 1 接続の形の既定の保存先（計算式の pull の APP<番号>-<アプリ名>.json と重ならないよう FV- を付ける） */
export function fvDefaultPullName(appName: string, appId: number): string {
  const name = safeFileName(appName, "");
  return name ? `FV-APP${appId}-${name}.json` : `FV-APP${appId}.json`;
}
