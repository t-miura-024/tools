import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";

// -----------------------------------------------------------------------
// Phase 3b: 計画承認（plan-approval-cycle 本体。human_gate は確認と回答保存のみを
// 行い、巻き戻しは行わない。差し戻しは judge-plan-approval が gateAnswers を読んで
// 判定 `continue` で行い、本体先頭の phase3-planner へ巻き戻る）
// -----------------------------------------------------------------------
export const phase3bPlanApprovalStep: HumanGateStepDef = {
  key: "phase3b-plan-approval",
  phase: "Phase 3b: 計画承認",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "escalate" },
  humanGate: {
    presentArtifacts: ["plan.md"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "承認",
            desc: "plan.md の内容で調査を開始する",
            // NOTE(plan93): secret masking / sanitization is handled at tado engine/dashboard layer (gate_events.answersJson display escaping), not workflow; maxLength 500 is sufficient per plan 93 unified rule scope.
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "修正が必要",
            desc: "judge-plan-approval が gateAnswers を読んで loop 先頭（phase3-planner）へ巻き戻し、入力した修正理由を反映して計画を立て直す",
            input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
};
