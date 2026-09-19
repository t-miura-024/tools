import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";

// -------------------------------------------------------------------
// Step 1: 計画の特定
// -------------------------------------------------------------------
export const identifyPlanStep: HumanGateStepDef = {
  key: "identify-plan",
  phase: "計画の特定",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  humanGate: {
    presentArtifacts: [],
    outcomeQuestionKey: "decision",
    // loop 外ゲートのため選択肢は approve/abort のみとし、request_changes は持たせない。
    // request_changes を選んでも巻き戻しは起きず記録上通過するだけの未配線選択肢になるため、
    // 計画の特定をやり直す場合は abort＋再実行へ誘導する（loop 外の continue は fail-fast）。
    questions: [
      {
        key: "decision",
        title: "判定",
        description:
          "計画の特定をやり直す場合は「中断」を選び、中断後に正しい計画番号で再実行してください。このゲートは loop 外のため request_changes による巻き戻しはできません",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "計画を特定した",
            desc: "Issue番号を確認し次へ進む",
            input: { required: false, maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
};
