import type { CheckCtx, CheckResult, ConditionCtx } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { isLoopExhausted } from "../helper/is-loop-exhausted.ts";

// -----------------------------------------------------------------
// Step 1d: 分析上限到達時の人間判断（loop 外）
//   judge が枯渇マーカーを残した反復でのみ condition が true になり提示する。
//   正常 pass 時は提示しない。選択肢は approve/abort のみとし、
//   request_changes は持たせない（loop 外で continue を返すとエンジンが
//   fail-fast するため、巻き戻しの無い request_changes は未配線選択肢になる）。
// -----------------------------------------------------------------
export const analysisExhaustedGateStep: HumanGateStepDef = {
  key: "analysis-exhausted",
  phase: "分析上限到達判断",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  condition: (ctx: ConditionCtx): boolean =>
    isLoopExhausted(ctx.sessionDir, "analysis-cycle-exhausted.json", "analysis-cycle"),
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
  humanGate: {
    presentArtifacts: ["analysis.md", "evidence.json"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        description:
          "分析サイクルが上限（3 反復）に達しても差し戻しが解消しませんでした。loop は既に終了しているため、このゲートで作業ステップへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。差し戻し内容が未反映のまま本文マッピングへ進むか、中断するかを選択してください",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "差し戻しを残したまま次へ進む",
            desc: "未反映の指摘を残したまま draft-body へ進む",
            input: { required: false, maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
};
