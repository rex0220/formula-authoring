/**
 * fields/<app>.json（fields コマンドの出力）から、設定画面と同じ項目の模型を作る（docs/authoring-plan.md 12.2）。印刷屋のコードは API（engine.api）から使う。
 *   pp     … properties + $id / $revision / $html → createCheckRecord（テーブルの子を ptcode 付きで平らに足す）。設定画面の load.ts と同じ作り方
 *   crec   … 計算式の検証用レコード（空の値）
 *   ppRun  … 実行用（preview）。デスクトップと同じ expandFields
 *   calcCandidates … 更新項目にできる項目（createFieldsInfo。テーブルの子を除く）
 * 印刷屋 Ver.8（authoring API 3）: fields の related（関連レコード一覧の参照先の項目定義）があれば、印刷屋の zip の expandRelatedFields で仮のテーブル
 * `親$子` を入れてから pp / ppRun を作る（設定画面と同じ。子は全項目）。relatedParents は 1 行目・一覧用・書き込みの検査（checks.ts）に、
 * relatedMissing は「fields を取り直す」のエラーに使う
 */
import type { PrintCraftAuthoringApi } from "print-craft/src/authoring/api.ts";
import type { FieldInfo, FieldProp } from "print-craft/src/config/load.ts";
import type { RelatedDefs } from "print-craft/src/shared/related.ts";
import type { FieldsFile } from "../commands/fields.ts";
import { isKintoneBaseUrl, normalizeKintoneBaseUrl } from "../kintone-url.ts";

export const PSEUDO_FIELDS = new Set(["$id", "$revision", "$out", "$html", "$rseq"]);
/** UINFO / OINFO / GINFO を使った印（項目ではない。lib 26 行） */
export const UOG_MARK = "$UGO$";
export const EXEC_CONDITION_LABEL = "実行条件";

export interface Model {
  api: PrintCraftAuthoringApi;
  file: FieldsFile;
  /** .env の KINTONE_BASE_URL（検証済み）。無ければ ""（iframe は使えない） */
  baseUrl: string;
  /** fields の baseUrl（kintone のドメインなら正規化、違えば ""）。表示と警告だけに使う */
  fieldsBaseUrl: string;
  appId: number;
  pp: Record<string, FieldProp>;
  crec: Record<string, unknown>;
  ppRun: Record<string, FieldProp>;
  calcCandidates: FieldInfo[];
  calcByCode: Map<string, FieldInfo>;
  /** 関連レコード一覧の親コード（参照先を取れなかったものも含む。API 3 より前の zip では空） */
  relatedParents: string[];
  /** 親コードのうち fields の related に無いもの（旧版の fields、権限無し、取得の失敗） */
  relatedMissing: string[];
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** zip の API が関連レコード一覧の関数を持つか（authoring API 3 = 印刷屋 Ver.8） */
export function supportsRelated(api: PrintCraftAuthoringApi): boolean {
  return typeof api.expandRelatedFields === "function" && typeof api.relatedParentsOf === "function" && typeof api.relatedUsageErrors === "function";
}

/** fields の related から展開の入力を作る（子は全項目。設定画面と同じ） */
export function relatedDefsOf(file: FieldsFile): RelatedDefs {
  const defs: RelatedDefs = {};
  for (const [parent, r] of Object.entries(file.related ?? {})) {
    if (!r || typeof r !== "object" || !r.properties) continue;
    defs[parent] = { app: String(r.app), properties: r.properties as unknown as Record<string, FieldProp>, children: "all" };
  }
  return defs;
}

/**
 * @param trustedBaseUrl .env の KINTONE_BASE_URL（検証済み）。iframe の同一オリジンの判定はこれだけを使う（無ければ iframe は使えない）
 */
export function buildModel(file: FieldsFile, api: PrintCraftAuthoringApi, trustedBaseUrl?: string): Model {
  const properties = file.properties as unknown as Record<string, FieldProp>;
  const related = supportsRelated(api);
  const relatedDefs = related ? relatedDefsOf(file) : {};
  // 仮のテーブル（親$子）を先に入れる。expandRelatedFields は入力を変えず新しいオブジェクトを返す。参照先のアプリが設定と合わない fields は例外（取り直す）
  const base: Record<string, FieldProp> = related && Object.keys(relatedDefs).length ? api.expandRelatedFields(properties, relatedDefs) : clone(properties);
  // 検証用の pp は設定画面と同じ作り方。expandFields を先に通すと createCheckRecord が子の ptcode を "" に戻す（キーの順で上書き）ので使わない
  const pp: Record<string, FieldProp> = { ...base };
  pp["$id"] = { type: "RECORD_NUMBER", code: "$id", label: "$id" };
  pp["$revision"] = { type: "__REVISION__", code: "$revision", label: "$revision" };
  pp["$html"] = { type: "MULTI_LINE_TEXT", code: "$html", label: "$html" };
  const crec = api.createCheckRecord(pp);
  const ppRun = related && Object.keys(relatedDefs).length ? api.makeReportPp(properties, relatedDefs, EXEC_CONDITION_LABEL) : api.expandFields(clone(properties), EXEC_CONDITION_LABEL);
  // createFieldsInfo はテーブルの子を ptcode 付きで出すので、設定画面の dialog と同じく除く（dialogs.ts 753 行）
  const calcCandidates = api.createFieldsInfo(pp, clone(file.layout) as Parameters<PrintCraftAuthoringApi["createFieldsInfo"]>[1]).filter((c) => !c.ptcode && c.type !== "SUBTABLE");
  const calcByCode = new Map<string, FieldInfo>();
  for (const c of calcCandidates) calcByCode.set(c.fieldcode, c);
  // iframe の同一オリジンの判定に使う接続先は .env の KINTONE_BASE_URL（検証済み）だけ。fields の baseUrl は AI が書き換えられるファイルの値なので
  // 判定には使わない（無ければ "" = iframe は使えない。1-10 レビュー BLOCKER 5、再レビュー BLOCKER 4）。fields の値は表示と警告（fieldsBaseUrl）だけ
  const baseUrl = trustedBaseUrl ?? "";
  const fieldsBaseUrl = typeof file.baseUrl === "string" && isKintoneBaseUrl(file.baseUrl) ? normalizeKintoneBaseUrl(file.baseUrl) : "";
  const relatedParents = related ? api.relatedParentsOf(properties) : [];
  const relatedMissing = relatedParents.filter((p) => !relatedDefs[p]);
  return { api, file, baseUrl, fieldsBaseUrl, appId: file.appId, pp, crec, ppRun, calcCandidates, calcByCode, relatedParents, relatedMissing };
}

/** 項目コードが使えるか（usedFields の実在チェック。12.3） */
export function fieldExists(model: Model, code: string): boolean {
  if (PSEUDO_FIELDS.has(code)) return true;
  const p = model.pp[code];
  if (!p) return false;
  if (p.ptcode) return !!model.pp[p.ptcode];
  return true;
}

/** 更新項目にできない理由（できれば null） */
export function calcIneligibleReason(model: Model, code: string): string | null {
  if (model.calcByCode.has(code)) return null;
  const p = model.pp[code];
  if (!p) return "fields に無い";
  if (p.ptcode) return p.related || model.pp[p.ptcode]?.related ? `関連レコード一覧 ${p.ptcode} の中（読み取り専用）` : `テーブル ${p.ptcode} の中`;
  if (!model.api.isTargetType(p.type)) return `更新できない型（${p.type}）`;
  if (p.expression) return "計算項目";
  if (p.copyfield) return "ルックアップのコピー先";
  return "レイアウトに無い";
}
