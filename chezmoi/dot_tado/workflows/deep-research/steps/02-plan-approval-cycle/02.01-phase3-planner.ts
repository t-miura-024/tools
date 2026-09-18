import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { auditPlanner } from "../../scripts/audit";
import { SCRIPTS_DIR } from "../../helper/scripts-dir.ts";
import { openResearchDb } from "../../helper/open-research-db.ts";
import { toCheckResult } from "../../helper/to-check-result.ts";
import { GATE_SKIP_CONDITIONS } from "../../helper/gate-skip-conditions.ts";
import { currentGateDecision } from "../../helper/current-gate-decision.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";

// -----------------------------------------------------------------------
// Phase 3: 計画立案 (Planner。plan-approval-cycle の先頭)
//   前反復で phase3b-plan-approval が request_changes を返した場合は、
//   その追加入力を gateAnswers から注入して再作業する（revise 相当）。
// -----------------------------------------------------------------------
export const phase3PlannerStep: TaskStepDef = {
  key: "phase3-planner",
  phase: "Phase 3: 計画立案",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "run_subagent",
    subagentType: "mt-deep-research-planner",
    readonly: false,
    buildPrompt: (ctx: PromptCtx) => {
      const planPath = join(ctx.sessionDir, "plan.md");
      const planTemplate = join(import.meta.dir, "../../templates", "plan.md");
      return buildStepPrompt({
        purpose: [
          "plan.md を作成し、questions テーブルに 3〜7 個（推奨 5 個）の主要な問いを登録する。",
        ],
        criteria: [],
        approach: [
          {
            title: "担当範囲",
            content: [
              "- plan.md の作成（`templates/plan.md` の構成に従う、mermaid 必須）",
              "- questions テーブルへの問い登録（`db.ts question create` を使用）",
              "- hearing.md（事前ヒアリング結果）を読み、背景・目的・前提知識・制約を plan.md に反映する",
              "",
            ],
          },
          {
            title: "実行コマンド",
            content: [
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} question create --content "..." --order 1 --db-path ${ctx.artifactDbPath}`,
              "```",
            ],
          },
        ],
        output: [
          `plan.md を ${planPath} に書き出す。`,
          "questions テーブルに 3〜7 個の主要な問いを登録する。",
        ],
        policy: [
          "- ファイルを直接編集しない（plan.md は書き込み可）",
          "- Human Gate を代行しない",
          "- 制約・スコープも Planner が提案する",
        ],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
          `plan.md 出力先: ${planPath}`,
          `plan テンプレート: ${planTemplate}`,
          `hearing.md（事前ヒアリング結果）: ${join(ctx.sessionDir, "hearing.md")}`,
          `反復: ${ctx.loop?.iteration ?? 1}/${ctx.loop?.maxIterations ?? 3}（上限到達時は loop 外の人間判断へ渡る）`,
          `前回差し戻し（gate:phase3b-plan-approval。request_changes の追加入力。原文のまま反映する）: ${(() => {
            const stepKey = "phase3b-plan-approval";
            const value = currentGateDecision(ctx.gateAnswers, ctx, stepKey);
            if (value !== "request_changes") return "- (なし。初回実行または前回 approve)";
            const skipWhen = GATE_SKIP_CONDITIONS[stepKey];
            const input =
              skipWhen && !skipWhen(ctx) ? undefined : gateDecisionInput(ctx.gateAnswers, stepKey);
            if (input === undefined || input.trim() === "") {
              return (
                "- " +
                stepKey +
                ": (⚠️ request_changes の追加入力がありません。gateAnswers の記録不備の可能性があり、judge の check が fail で停止する)"
              );
            }
            return "- " + stepKey + ": " + input;
          })()}`,
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
    const db = openResearchDb(ctx.artifactDbPath);
    try {
      const planPath = join(ctx.sessionDir, "plan.md");
      const checks = auditPlanner(db, planPath);
      return toCheckResult(checks);
    } finally {
      db.close();
    }
  },
};
