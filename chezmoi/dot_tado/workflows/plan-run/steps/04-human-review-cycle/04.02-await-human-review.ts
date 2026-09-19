import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { awaitHumanReviewStep } from "../../../review-diff/steps/03-human-review-loop/03.05-await-human-review.ts";
import { REVIEW_ROUND_LIMIT } from "../../../shared/review-helpers/review-round-limit";
import { isHumanReviewPhase } from "../../helper/is-human-review-phase.ts";

// -------------------------------------------------------------------
// 自律上限または must=0 で既存 difit セッションを人間に提示する。
// 差し戻しは judge-human が外側 loop の continue に変換する。
// -------------------------------------------------------------------
export const awaitHumanReviewPlanStep: HumanGateStepDef = {
  ...awaitHumanReviewStep,
  phase: "人間レビュー待機",
  condition: isHumanReviewPhase,
  // review-diff 単独では入力した修正理由の消費先が存在しない（確認と回答保存のみ）。
  // plan-run ではループ所有者として、入力した修正理由が gateAnswers
  // （await-human-review.decision の input）に記録され、apply-feedback が
  // feedback.json へ統合して execute-work の修正指示として参照することを案内する。
  humanGate: {
    ...awaitHumanReviewStep.humanGate!,
    questions: awaitHumanReviewStep.humanGate!.questions.map((question) => {
      if (question.key !== "decision") return question;
      return {
        ...question,
        description: `自律レビューは must=0 または上限 ${REVIEW_ROUND_LIMIT} 回で終了します。findings.json の round が ${REVIEW_ROUND_LIMIT} なら自律上限到達です。残 must / should / want は重要度を変えず difit に登録済みです。difit-start.json の URL を開き、修正結果を確認してください。承認には difit 上の未解決 must=0 が必須です。未修正受容や別Issue引き継ぎでは完了できません。差し戻すと自律レビュー最大 ${REVIEW_ROUND_LIMIT} 回の予算を再付与します。`,
        choices: question.choices?.map((choice) =>
          choice.value === "request_changes"
            ? {
                ...choice,
                desc: "judge-human が gateAnswers を読んで人間ループ先頭（自律ループ）へ巻き戻す。入力した修正理由は apply-feedback が feedback.json へ統合し、execute-work の修正指示として参照される",
              }
            : choice,
        ),
      };
    }),
  },
};
