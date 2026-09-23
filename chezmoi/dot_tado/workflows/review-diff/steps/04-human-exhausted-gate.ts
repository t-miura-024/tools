import type { CheckCtx, CheckResult, ConditionCtx } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { readGateDecision } from "../helper/read-gate-decision.ts";
import { FINDINGS_KEY } from "../../shared/review-helpers/findings-key";
import { DIFIT_START_KEY } from "../../shared/review-helpers/difit-start-key";
import { DIFIT_COMMENTS_KEY } from "../../shared/review-helpers/difit-comments-key";
export const humanExhaustedGateStep: HumanGateStepDef =
  // -------------------------------------------------------------------
  // human-exhausted-gate: human-review-loop 枯渇時の人間判断（loop 外）。
  //   isHumanReworkRequested が request_changes のときだけ提示する
  //   （枯渇時のみ。常時提示しない）。loop 外のため選択肢は approve/abort のみ。
  // -------------------------------------------------------------------
  {
    key: "human-exhausted-gate",
    phase: "人間レビュー上限判断",
    type: "human_gate",
    maxRetries: 1,
    onFail: { action: "abort" },
    // human-review-loop が request_changes のまま枯渇したときだけ true になり、人間判断を提示する。
    condition: (ctx: ConditionCtx): boolean =>
      readGateDecision(ctx.gateAnswers, "await-human-review") === "request_changes",
    check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    humanGate: {
      presentArtifacts: [FINDINGS_KEY, DIFIT_START_KEY, DIFIT_COMMENTS_KEY],
      outcomeQuestionKey: "decision",
      questions: [
        {
          key: "decision",
          title: "判定",
          description:
            "人間レビューが上限（3 回）に達しても差し戻し（request_changes）のままです。自律ループは既に終了しているため、このゲートでレビューサイクルへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。現在の verdict を受容して終端するか、中断するかを選択してください。中断する場合は、先に `mt difit done`（冪等・exit 0）を手動実行してから選択してください",
          type: "choice_with_input",
          choices: [
            {
              value: "approve",
              label: "現在の verdict を受容して終端する",
              desc: "レビュー結果を受容しワークフローを終端する",
              input: { required: false, maxLength: 500 },
            },
            { value: "abort", label: "中断" },
          ],
        },
      ],
    },
  };
