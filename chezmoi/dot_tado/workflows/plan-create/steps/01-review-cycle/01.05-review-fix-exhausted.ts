import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { isReviewFixExhausted } from "../../helper/is-review-fix-exhausted.ts";

// -----------------------------------------------------------------
// Step 5: 自動レビュー上限判断（人間ゲート）
//   内側 review-fix-cycle が上限（3 回）に達し、must が残っている場合のみ表示する。
//   「追加で 1 ラウンド（外側の人間差し戻し枠を 1 回消費）/ 中断」を選ぶ。
//   must 残存のまま承認する選択肢は置かない。
// -----------------------------------------------------------------
export const reviewFixExhaustedStep: HumanGateStepDef = {
  key: "review-fix-exhausted",
  phase: "自動レビュー上限判断",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  condition: isReviewFixExhausted,
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
  humanGate: {
    presentArtifacts: [
      "issue-body.md",
      "review-body.md",
      "review-findings.json",
      "review-decisions.md",
    ],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        description:
          "自動レビュー修正サイクルが上限（3 回）に達しましたが、must 指摘が残っています。追加で 1 ラウンド回すか、中断するかを選んでください。追加ラウンドは外側の人間差し戻し枠を 1 回消費します。外側の残り枠がない場合は中断を選んでください。must 残存のまま承認することはできません。",
        type: "choice_with_input",
        choices: [
          {
            value: "retry",
            label: "もう1ラウンド回す",
            desc: "grill が残 must を再確認する。外側の人間差し戻し枠を1回消費する",
            input: { required: false, placeholder: "追加の指示があれば入力", maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "Issue を作成せずセッションを終了する" },
        ],
      },
    ],
  },
};
