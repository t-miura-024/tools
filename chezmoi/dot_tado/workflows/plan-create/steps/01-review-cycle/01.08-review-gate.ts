import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";

// -----------------------------------------------------------------
// Step 8: 最終レビューゲート
// -----------------------------------------------------------------
// must=0 は独立レビューと judge-must / prepare の check で機械検証済み。
// このゲートに到達する時点で must は残っていない（must 残存時は
// review-fix-exhausted で追加ラウンド/中断を選ぶ）。
// Note: 分解モードの子 body（issue-body-<n>.md）は件数が動的なため
// presentArtifacts に列挙できない。子の品質担保は review-findings.json の
// reviewedTargets（check で機械検証）と create-refined の子未レビュー時
// escalate ガードで行う。
// width/depth 質問は置かない（draft-body が書き出す effort コメント初期値に一本化）。
export const reviewGateStep: HumanGateStepDef = {
  key: "review-gate",
  phase: "レビュー",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  humanGate: {
    presentArtifacts: [
      "issue-body.md",
      "review-body.md",
      "review-findings.json",
      "review-decisions.md",
      "prepare-decision.json",
    ],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "refined で作成する",
            desc: "must は独立レビューと must 判定でゼロが機械検証済み。review-body.md に should/want が残る場合は内容を確認し、対応不要と判断した場合のみ選択する",
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "修正する",
            desc: "Grill Phase に戻って内容を再検討する（外側ループの残り枠を1回消費。Issue は未作成のため残留物なし）。should/want の対応や方針変更を求める場合はこちらを選ぶ",
            input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "Issue を作成せずセッションを終了する" },
        ],
      },
    ],
  },
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
};
