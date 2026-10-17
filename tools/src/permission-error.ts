/** kintone/ の下を変える・読むのを断るときの誤り（決まった文。permission.ts と workspace.ts が使う。お互いを読み込まないように別のモジュールにした） */
export class PermissionError extends Error {}
