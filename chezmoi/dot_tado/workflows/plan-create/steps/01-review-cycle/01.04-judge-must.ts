import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { readPlanReviewFindings } from "../../helper/review-findings.ts";
import { REVIEW_FIX_MAX_ITERATIONS } from "../../helper/review-limits.ts";

const LOOP_KEY = "review-fix-cycle";
const EXHAUSTED_GATE_KEY = "review-fix-exhausted";

// -----------------------------------------------------------------
// Step 4: must 判定（内側 loop 末尾）
//   review-findings.json の must 件数だけを見て、内側 loop の継続を決める。
//   must>0 かつ上限前 → continue で grill へ巻き戻す。
//   must>0 かつ上限到達 → pass で抜け、review-fix-exhausted で人間が判断する。
//   must=0 → pass で最終レビューへ進む。
// -----------------------------------------------------------------
export const judgeMustStep: TaskStepDef = {
  key: "judge-must",
  phase: "must 判定",
  type: "task",
  maxRetries: 0,
  onFail: { action: "abort" },
  task: {
    action: "orchestrate",
    readonly: true,
    buildPrompt: (ctx: PromptCtx) =>
      buildStepPrompt({
        purpose: [
          "review-findings.json の must 件数を読み、内側レビュー修正ループの継続可否を報告する。分岐は check が決定論的に行う。",
        ],
        criteria: [],
        approach: ["- must 件数の判定と loop の継続判定は check が行う。agent は report のみ行う"],
        policy: ["- agent は read-only。review-findings.json を含むファイルを作成・編集しない"],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      }),
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (ctx.loop?.key !== LOOP_KEY) {
      return {
        status: "error",
        reasons: [
          `must 判定は ${LOOP_KEY} 内でのみ実行される（loop 文脈: ${ctx.loop?.key ?? "なし"}）`,
        ],
      };
    }
    if (ctx.loop.maxIterations !== REVIEW_FIX_MAX_ITERATIONS) {
      return {
        status: "error",
        reasons: [
          `${LOOP_KEY} の maxIterations=${ctx.loop.maxIterations} が定義値 ${REVIEW_FIX_MAX_ITERATIONS} と一致しません`,
        ],
      };
    }
    const findings = readPlanReviewFindings(ctx.sessionDir, ctx.artifacts);
    if (!findings.valid || !findings.parsed) {
      return {
        status: "error",
        reasons: [`review-findings.json を検証できません: ${findings.error ?? "invalid findings"}`],
      };
    }
    if (findings.parsed.cycleRound !== ctx.loop.iteration) {
      return {
        status: "error",
        reasons: [
          `review-findings.json の cycleRound=${findings.parsed.cycleRound} が内側ループ iteration=${ctx.loop.iteration} と一致しません`,
        ],
      };
    }
    const must = findings.parsed.counts.must;
    if (must === 0) {
      return { status: "pass", reasons: ["must=0 — 最終レビューへ進む"] };
    }
    if (ctx.loop.iteration < ctx.loop.maxIterations) {
      return {
        status: "continue",
        reasons: [
          `must=${must} — ${LOOP_KEY} を grill へ巻き戻す (${ctx.loop.iteration}/${ctx.loop.maxIterations})`,
        ],
      };
    }
    return {
      status: "pass",
      reasons: [
        `must=${must} (${ctx.loop.iteration}/${ctx.loop.maxIterations} で上限到達) — ${EXHAUSTED_GATE_KEY} で人間が判断します`,
      ],
    };
  },
};
