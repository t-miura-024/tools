import type { CheckCtx, CheckResult, ConditionCtx } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { readGateDecision } from "../helper/read-gate-decision.ts";
import { EFFORT_KEY } from "../../shared/review-helpers/effort-key";
export const effortExhaustedGateStep: HumanGateStepDef =
  // -------------------------------------------------------------------
  // effort-exhausted-gate: effort-loop 枯渇時の人間判断（loop 外）。
  //   isEffortReworkRequested が request_changes のときだけ提示する
  //   （枯渇時のみ。常時提示しない）。loop 外のため選択肢は approve/abort のみ。
  // -------------------------------------------------------------------
  {
    key: "effort-exhausted-gate",
    phase: "effort 上限判断",
    type: "human_gate",
    maxRetries: 1,
    onFail: { action: "abort" },
    // effort-loop が request_changes のまま枯渇（maxIterations 到達の escalate）したときだけ
    // true になり、人間判断を提示する。approve / abort / 未回答・未知値では提示しない（常時提示しない）。
    condition: (ctx: ConditionCtx): boolean =>
      readGateDecision(ctx.gateAnswers, "resolve-effort") === "request_changes",
    check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
    humanGate: {
      presentArtifacts: [EFFORT_KEY],
      outcomeQuestionKey: "decision",
      questions: [
        {
          key: "decision",
          title: "判定",
          description:
            "effort 解決が上限（3 回）に達しても差し戻し（request_changes）のままです。自律ループは既に終了しているため、このゲートで effort 解決へ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。現在の effort で検証へ進むか、中断するかを選択してください",
          type: "choice_with_input",
          choices: [
            {
              value: "approve",
              label: "現在の effort で検証へ進む",
              desc: "effort を受容しレビューサイクルへ進む",
              input: { required: false, maxLength: 500 },
            },
            { value: "abort", label: "中断" },
          ],
        },
      ],
    },
  };
