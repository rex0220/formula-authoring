/**
 * kintone/ の下を変える前の許可（tools 2.0.0。print-craft-authoring-mcp の実装案 15.5〜15.7。2026-10-10 Takashi「本番の保護はやめる」）。
 *   - kintone/ の下を変えるのは profile の形（接続のファイルがある）のときだけ。1 接続の形・移行で止まっている形では、いつも断る
 *   - フォルダーの profile が接続のファイルにあること（無ければ denied）、印が今の接続のこのアプリのもの（印が無い・壊れている・別の接続は conflict）、
 *     呼び出しの途中で接続が変わっていないこと（確定の直前に接続のファイルを読み直す。connection-changed）。呼ぶ側は、判定を早めに 1 回（通信や normalize の前）、
 *     実際に書く直前にもう 1 回行う（Codex レビュー BLOCKER 2）
 *   - 操作 × 対象のパス（Codex レビュー MAJOR 3）: 操作ごとに、アプリのフォルダーの中で書いてよい場所を決める
 *       settings（normalize の書き戻し、保存、ボタンの差し替え、edit）… -edit.json と新しい帳票（その他の *.json）
 *       snapshot（pull、take）… 新しい名前のダウンロード / pull（rex0220-print-craft-app<番号>-<日時>.json。既にあれば不可）
 *       fields … fields.json、record … records/ の下の *.json、preview … out/ の下
 *   - フォルダーを作れるのは fields と snapshot（pull / take）だけ。ほかの操作はフォルダーが要る（先に fields か pull）
 *   - . で始まるファイル（アプリのフォルダーの印 .pcraft-app.json）は、どの操作でも書けない（印は workspace.ts の ensureAppFolder だけが置く）
 * kintone/ の外（settings/ fields/ records/ out/ temp/）は形に依らない（書ける場所は操作ごとに safe-path.ts の WRITE_ROOTS が決める）。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { assertSameConnection } from "./connections.ts";
import { PermissionError } from "./permission-error.ts";
import { isInside } from "./safe-path.ts";
import { EDIT_RE, KINTONE_ROOT, SNAPSHOT_RE, appFolderOfFile, assertAppMark, legacyBlockedError, type WorkspaceMode } from "./workspace.ts";

export { PermissionError };

export type ChangeOp = "settings" | "snapshot" | "fields" | "record" | "preview";

/** アプリのフォルダーの中の場所（docs/permission-table.md の P4〜P9） */
export type TargetClass = "snapshot" | "edit" | "report" | "fields" | "record" | "out" | "other";

const ALLOWED_CLASSES: Record<ChangeOp, readonly TargetClass[]> = {
  settings: ["edit", "report"],
  snapshot: ["snapshot"],
  fields: ["fields"],
  record: ["record"],
  preview: ["out"]
};

const OP_LABEL: Record<ChangeOp, string> = {
  settings: "設定（-edit.json と新しい帳票）",
  snapshot: "新しい名前のダウンロード / pull",
  fields: "fields.json",
  record: "records/ の下",
  preview: "out/ の下"
};

/** フォルダーを新しく作ってよい操作（15.5） */
const CREATES_FOLDER: readonly ChangeOp[] = ["fields", "snapshot"];

/** アプリのフォルダーからの相対パスで場所を分ける。. で始まる名前（印など）はどの操作でも書けない other */
export function classOfAppPath(relInFolder: string): TargetClass {
  const rel = relInFolder.replace(/\\/g, "/");
  if (rel.split("/").some((seg) => seg.startsWith("."))) return "other";
  if (rel.startsWith("records/")) return rel.toLowerCase().endsWith(".json") && rel.split("/").length === 2 ? "record" : "other";
  if (rel.startsWith("out/")) return "out";
  if (rel.includes("/")) return "other";
  if (rel === "fields.json") return "fields";
  if (SNAPSHOT_RE.test(rel)) return "snapshot";
  if (EDIT_RE.test(rel)) return "edit";
  if (rel.toLowerCase().endsWith(".json")) return "report";
  return "other";
}

/** kintone/ の下をこの操作で変えてよいか。だめなら PermissionError（denied）か ConnectionError（印・接続の変化は conflict。移行で止まっているのは failed） */
export function assertChangeAllowed(root: string, file: string, op: ChangeOp, mode: WorkspaceMode): void {
  const abs = path.resolve(root, file);
  if (!isInside(abs, path.join(root, KINTONE_ROOT))) return;
  const rel = path.relative(root, abs);
  if (mode.kind !== "profiles") {
    if (mode.kind === "legacy-blocked") throw legacyBlockedError();
    throw new PermissionError("kintone/ の下は、kintone の接続のファイルがあるときだけ変える（今の形では settings/ などを使う）");
  }
  const folder = appFolderOfFile(root, abs);
  if (!folder) throw new PermissionError(`アプリのフォルダー（kintone/<profile>/<番号>-…/）の中でない: ${rel}`);
  const { set, reload } = mode.connections;
  const def = set.profiles.get(folder.profile);
  if (!def) throw new PermissionError(`profile「${folder.profile}」は接続のファイル（${set.fileName}）に無い（使われていないフォルダーは変えない）`);
  const cls = classOfAppPath(path.relative(folder.dir, abs));
  if (cls === "snapshot" && existsSync(abs)) throw new PermissionError(`ダウンロード / pull のファイルは書き換えない: ${rel}。edit で -edit.json に写して直す`);
  if (!ALLOWED_CLASSES[op].includes(cls)) throw new PermissionError(`この操作でアプリのフォルダーに書けるのは ${OP_LABEL[op]} だけ: ${rel}`);
  if (existsSync(folder.dir)) assertAppMark(folder.dir, def, folder.appId);
  else if (!CREATES_FOLDER.includes(op)) throw new PermissionError(`アプリのフォルダーが無い: ${path.relative(root, folder.dir)}（先に fields か pull で作る）`);
  // 呼び出しの初めに読んだ接続と、今の接続のファイルの同じ profile が同じか（途中で変わっていれば connection-changed。15.6）
  assertSameConnection({ set, def }, reload, folder.appId);
}
