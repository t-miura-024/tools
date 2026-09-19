import type { CheckCtx, CheckResult, ConditionCtx } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { isLoopExhausted } from "../helper/is-loop-exhausted.ts";

const MARKER_KEY = "review-cycle-exhausted.json";
const LOOP_KEY = "review-cycle";

// -----------------------------------------------------------------
// Step 5c: 上限到達時の人間判断（loop 外）
//   judge が枯渇マーカーを残した反復でのみ condition が true になり提示する。
//   正常 pass 時は提示しない。選択肢は approve/abort のみとし、
//   request_changes は持たせない（loop 外で continue を返すとエンジンが
//   fail-fast するため、巻き戻しの無い request_changes は未配線選択肢になる）。
// -----------------------------------------------------------------
export const reviewExhaustedStep: HumanGateStepDef = {
  key: "review-exhausted",
  phase: "上限到達判断",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  condition: (ctx: ConditionCtx): boolean => isLoopExhausted(ctx.sessionDir, MARKER_KEY, LOOP_KEY),
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
  humanGate: {
    presentArtifacts: ["issue-body.md", "review-body.md", "prepare-decision.json"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        description:
          "レビューサイクルが上限（3 反復）に達しても差し戻しが解消しませんでした。loop は既に終了しているため、このゲートで作業ステップへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。差し戻し内容が未反映のまま作成へ進むか、中断するかを選択してください。承認時は must 残存があっても create-refined の check が警告として記録し作成へ進む",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "差し戻しを残したまま作成へ進む",
            desc: "未反映の指摘を残したまま create-refined へ進む（must 残存は警告として記録される）",
            input: { required: false, maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "Issue を作成せずセッションを終了する" },
        ],
      },
    ],
  },
};
