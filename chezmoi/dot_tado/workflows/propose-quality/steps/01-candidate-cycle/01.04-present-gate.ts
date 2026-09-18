import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";

export const presentGateStep: HumanGateStepDef = {
  key: "present-gate",
  phase: "候補提示（候補サイクル本体）",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
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
            label: "選択した",
            desc: "起票する候補を選択した",
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "候補をやり直す",
            desc: "judge-present が gateAnswers を読んで loop 先頭（brainstorm）へ巻き戻し、入力した理由を反映して候補を再収集する",
            input: { required: true, placeholder: "やり直す理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "起票せず終了する" },
        ],
      },
    ],
  },
  // human_gate は確認と回答保存のみを行い、巻き戻しは行わない。差し戻しは
  // judge-present が gateAnswers を読んで判定 `continue` で行い、本体先頭の
  // brainstorm へ巻き戻る。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
};
