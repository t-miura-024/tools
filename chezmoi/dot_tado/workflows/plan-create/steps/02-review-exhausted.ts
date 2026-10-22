import type { CheckCtx, CheckResult, ConditionCtx } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { isLoopExhausted } from "../helper/is-loop-exhausted.ts";
import {
  REVIEW_CYCLE_EXHAUSTED_MARKER,
  REVIEW_CYCLE_MAX_ITERATIONS,
} from "../helper/review-limits.ts";

const MARKER_KEY = REVIEW_CYCLE_EXHAUSTED_MARKER;
const LOOP_KEY = "review-cycle";
const GATE_KEY = "review-gate";

// -----------------------------------------------------------------
// Step 5c: 外側上限到達時の人間判断（loop 外）
//   judge-review が枯渇マーカーを残した反復でのみ condition が true になり提示する。
//   この時点で must はゼロ（内側 loop が must=0 を保証）。未反映なのは人間の
//   request_changes フィードバック。選択肢は approve/abort のみとし、
//   request_changes は持たせない（loop 外で continue を返すとエンジンが
//   fail-fast するため、巻き戻しの無い request_changes は未配線選択肢になる）。
// -----------------------------------------------------------------
export const reviewExhaustedStep: HumanGateStepDef = {
  key: "review-exhausted",
  phase: "上限到達判断",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  condition: (ctx: ConditionCtx): boolean =>
    isLoopExhausted(ctx.sessionDir, MARKER_KEY, LOOP_KEY, GATE_KEY, REVIEW_CYCLE_MAX_ITERATIONS),
  // StepDef 型を満たすための no-op。現行 engine は human_gate の check を実行しない。
  check: (_ctx: CheckCtx): CheckResult => ({ status: "pass", reasons: [] }),
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
        description:
          "レビューサイクルが上限（3 反復）に達しても人間の差し戻しが解消しませんでした。この時点で must はゼロです（内側レビューで保証）。loop は既に終了しているため、このゲートで作業ステップへ戻ることはできません（loop 外の continue はエンジンが fail-fast します）。未反映のフィードバックが残ったまま最新の計画で作成するか、中断するかを選択してください。",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "最新の計画で作成へ進む",
            desc: "未反映の人間フィードバックは警告として記録される。must はゼロ",
            input: { required: false, maxLength: 500 },
          },
          { value: "abort", label: "中断", desc: "Issue を作成せずセッションを終了する" },
        ],
      },
    ],
  },
};
