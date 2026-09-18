import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { auditWriter } from "../scripts/audit";
import { SCRIPTS_DIR } from "../helper/scripts-dir.ts";
import { openResearchDb } from "../helper/open-research-db.ts";
import { toCheckResult } from "../helper/to-check-result.ts";

// -----------------------------------------------------------------------
// Phase 7: レポート作成 (Writer)
// -----------------------------------------------------------------------
export const phase7WriterStep: TaskStepDef = {
  key: "phase7-writer",
  phase: "Phase 7: レポート作成",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "run_subagent",
    subagentType: "mt-deep-research-writer",
    readonly: false,
    buildPrompt: (ctx: PromptCtx) => {
      const reportPath = join(ctx.sessionDir, "report.md");
      const reportTemplate = join(import.meta.dir, "../templates", "report.md");
      return buildStepPrompt({
        purpose: ["収集された調査結果をもとに report.md を作成・更新する。"],
        criteria: [
          "auditWriter が pass（report_md_exists / report_md_required_sections / report_md_has_citations / report_md_has_mermaid）",
        ],
        approach: [
          {
            title: "担当範囲",
            content: [
              "- report.md の作成・更新（`" + reportTemplate + "` の構成に従う、mermaid 必須）",
              "- 番号引用 `[N]` は sources.source_number と一致させる",
              "- 情報源は `## 情報源の一覧` に含める",
              "",
            ],
          },
          {
            title: "入力の取得",
            content: [
              "`db.ts snapshot --cycle writer-reviewer` の出力を使用する。",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} snapshot --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
              "```",
            ],
          },
        ],
        output: [`report.md を ${reportPath} に書き出す。`],
        policy: [
          "- ファイルを直接編集しない（report.md は書き込み可）",
          "- 未解決の問い・次のアクション・中間まとめを含めない",
          "- SearXNG 信頼性注意書きを含めない",
          "- レポートの全文をセッションに出力しない（完了報告は簡潔に）",
        ],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
          `report.md 出力先: ${reportPath}`,
          `report テンプレート: ${reportTemplate}`,
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
    const db = openResearchDb(ctx.artifactDbPath);
    try {
      const reportPath = join(ctx.sessionDir, "report.md");
      const checks = auditWriter(db, reportPath);
      return toCheckResult(checks);
    } finally {
      db.close();
    }
  },
};
