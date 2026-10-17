import { readFileSync } from "node:fs";
import path from "node:path";
const DIR = path.join(import.meta.dirname, "fixtures", "formula");
const read = (name) => JSON.parse(readFileSync(path.join(DIR, name), "utf8").replace(/^﻿/, ""));
export const EXPORT = () => read("export.json");
export const APP = () => read("app.json");
/** fields コマンドの出力の形に組む */
export const FIELDS_FILE = () => ({
  tool: "formula-authoring fields", fetchedAt: "2026-10-17T00:00:00.000Z", baseUrl: "https://example.cybozu.com", appId: APP().appId, appName: APP().name,
  preview: true, lang: "ja", revision: "1", properties: read("fields.json").properties, layout: read("layout.json").layout, views: read("views.json").views
});
