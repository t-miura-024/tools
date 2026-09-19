import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { isPlanApprovalExhausted } from "../helper/is-plan-approval-exhausted.ts";

// -------------------------------------------------------------------
// 承認上限判断（loop 外・枯渇時のみ提示）
//   plan-approval-cycle が上限（3 反復）に達しても request_changes のままの
//   場合のみ condition が true になり、人間が受容して後続へ進むか中断するかを選ぶ。
//   human_gate は確認と回答保存のみを行い、巻き戻しは行わない。
//   loop 外のため選択肢は approve/abort のみとし、request_changes は
//   持たせない（巻き戻しが起きず記録上通過するだけの未配線選択肢になるため）。
//   上限未達（approve 脱出）では skipped となり、Phase 4 へ進む。
// -------------------------------------------------------------------
export const planApprovalExhaustedGateStep: HumanGateStepDef = {
  key: "plan-approval-exhausted-gate",
  phase: "承認上限判断",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  condition: isPlanApprovalExhausted,
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない
  // （回答は confirm が記録する）。次ステップへの通過判定は condition が担う。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
  humanGate: {
    presentArtifacts: ["plan.md"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        description:
          "計画承認が上限（3 反復）に達しても修正要求（request_changes）のままです。loop は既に終了しているため、このゲートで計画立案へ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。未反映の差し戻し内容はセッション内の plan-approval-exhausted.json（request_changes 追加入力の永続化）と gate の回答履歴（phase3b-plan-approval）で確認してください。指摘を受容して調査へ進むか、中断するかを選択してください",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "受容して調査へ進む",
            desc: "未反映の指摘を残したまま Phase 4: 調査へ進む",
            input: { required: false, maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "中断する" },
        ],
      },
    ],
  },
};
