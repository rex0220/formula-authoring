/** normalize の検査結果（docs/authoring-plan.md 12.3。エラー / 警告 / 情報） */

export type Level = "error" | "warning" | "info";

export interface Finding {
  level: Level;
  /** 規則の名前（機械可読。例 html.script、field.filecode） */
  rule: string;
  /** 場所（例 「見積書 / HTML 設定 3 行目 (本文)」） */
  where: string;
  message: string;
}

export class Findings {
  readonly items: Finding[] = [];

  add(level: Level, rule: string, where: string, message: string): void {
    this.items.push({ level, rule, where, message });
  }

  error(rule: string, where: string, message: string): void {
    this.add("error", rule, where, message);
  }

  warning(rule: string, where: string, message: string): void {
    this.add("warning", rule, where, message);
  }

  info(rule: string, where: string, message: string): void {
    this.add("info", rule, where, message);
  }

  count(level: Level): number {
    return this.items.filter((f) => f.level === level).length;
  }

  get hasErrors(): boolean {
    return this.count("error") > 0;
  }

  /** 画面に出す表（レベル → 場所 → 文言） */
  format(): string {
    const label: Record<Level, string> = { error: "エラー", warning: "警告", info: "情報" };
    const lines = [`エラー ${this.count("error")} / 警告 ${this.count("warning")} / 情報 ${this.count("info")}`];
    for (const level of ["error", "warning", "info"] as Level[]) {
      for (const f of this.items.filter((x) => x.level === level)) lines.push(`[${label[level]}] ${f.where}: ${f.message}（${f.rule}）`);
    }
    return lines.join("\n");
  }
}
