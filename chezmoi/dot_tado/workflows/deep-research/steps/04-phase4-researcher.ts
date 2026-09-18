import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { auditResearcher } from "../scripts/audit";
import { SCRIPTS_DIR } from "../helper/scripts-dir.ts";
import { openResearchDb } from "../helper/open-research-db.ts";
import { toCheckResult } from "../helper/to-check-result.ts";
import { readPlanApprovalExhaustedMarker } from "../helper/read-plan-approval-exhausted-marker.ts";

// -----------------------------------------------------------------------
// Phase 4: 調査 (Researcher, orchestrate)
// -----------------------------------------------------------------------
export const phase4ResearcherStep: TaskStepDef = {
  key: "phase4-researcher",
  phase: "Phase 4: 調査",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "承認されたすべての問いについて、Researcher SubAgent を並列起動し、調査を実行する。",
        ],
        criteria: ["auditResearcher が pass（evidence_rounds_exist / sources_present）"],
        approach: [
          {
            title: "事前準備",
            content: [
              "plan.md で承認された問い（draft 状態）を approved に更新する:",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} question list --db-path ${ctx.artifactDbPath}\n# 表示された draft の問いをすべて approved に更新`,
              `bun run ${join(SCRIPTS_DIR, "db.ts")} question update --id <ID> --status approved --db-path ${ctx.artifactDbPath}`,
              "```",
              "",
            ],
          },
          {
            title: "手順",
            content: [
              "1. research.db から approved 状態の questions を取得する",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "db.ts")} question list --status approved --db-path ${ctx.artifactDbPath}`,
              "```",
              "",
              "2. 各 question_id に対して `mt-deep-research-researcher` SubAgent を並列起動する（最大 5 同時）",
              "   - 各 SubAgent には question_id、round_number、`db.ts snapshot --cycle research` の出力を渡す",
              "   - 期待する成果物: evidence_rounds / sources / facts / off_topic_questions の一括保存",
              "   - 保存は SubAgent が `db.ts evidence save --data '...'` で行う",
              "   - 各 Researcher のループは最大 5 ラウンド",
              "   - 担当する question_id 以外の調査結果を参照しない",
              "",
              "3. 各 Researcher 完了後、機械監査を実行する",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "audit.ts")} phase --phase researcher --db-path ${ctx.artifactDbPath} --question-id <ID>`,
              "```",
              "",
              "4. 監査 NG の場合は該当 Researcher にフィードバック（最大 3 回まで再委譲）",
              "5. 3 回を超えても NG の場合は人間に「範囲を狭める」「このまま進める」「中断する」を提示",
            ],
          },
        ],
        policy: [
          "- 全問いの調査が完了する前に次のフェーズに進まない",
          "- SubAgent に他の問いの調査結果を混入させない",
        ],
        output: [
          "外部通信（外部 URL 取得・SearXNG クエリ）の前に、送信先・データ・目的を宣言する（Researcher SubAgent にも遵守させる）",
        ],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
          `未反映の差し戻し（枯渇時・plan-approval-exhausted.json の永続化。なければなし）: ${(() => {
            let marker: { input: string } | null = null;
            try {
              marker = readPlanApprovalExhaustedMarker(ctx.sessionDir);
            } catch (error) {
              return (
                "(⚠️ 枯渇マーカーの検証に失敗: " +
                (error instanceof Error ? error.message : String(error)) +
                ")"
              );
            }
            if (marker === null) return "- (なし。枯渇なし)";
            return "- phase3b-plan-approval: " + marker.input;
          })()}`,
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
    const db = openResearchDb(ctx.artifactDbPath);
    try {
      return toCheckResult(auditResearcher(db));
    } finally {
      db.close();
    }
  },
};
