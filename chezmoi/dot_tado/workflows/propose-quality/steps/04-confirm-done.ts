import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";

export const confirmDoneStep: HumanGateStepDef = {
  key: "confirm-done",
  phase: "完了確認",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "escalate" },
  humanGate: {
    presentArtifacts: [],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "Done",
            desc: "完了として終了する",
            input: { required: false, maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
};
