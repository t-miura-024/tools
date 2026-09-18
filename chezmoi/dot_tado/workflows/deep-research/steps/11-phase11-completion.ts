import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";

// -----------------------------------------------------------------------
// Phase 11: 完了報告
// -----------------------------------------------------------------------
export const phase11CompletionStep: TaskStepDef = {
  key: "phase11-completion",
  phase: "Phase 11: 完了報告",
  type: "task",
  maxRetries: 1,
  onFail: { action: "escalate" },
  task: {
    action: "run_command",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: ["調査が完了したことを簡潔に報告する。report.md の全文は出力しない。"],
        criteria: [],
        approach: [
          "以下の形式で完了メッセージを出力する:",
          "",
          `調査が完了しました。N 件の情報源を確認しました。レポートは ${join(ctx.sessionDir, "report.md")} に保存しました。`,
        ],
        output: ["調査完了の報告メッセージ。"],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
          `report.md: ${join(ctx.sessionDir, "report.md")}`,
        ],
      });
    },
  },
  check: (_ctx: CheckCtx): CheckResult => {
    return { status: "pass", reasons: ["completion acknowledged"] };
  },
};
