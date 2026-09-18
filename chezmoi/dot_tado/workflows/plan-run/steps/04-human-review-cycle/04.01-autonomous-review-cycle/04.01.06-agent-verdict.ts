import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateFindingsJson } from "../../../../shared/review-helpers/validate-findings-json";
import { FINDINGS_KEY as REVIEW_FINDINGS_KEY } from "../../../../shared/review-helpers/findings-key";
import { REVIEW_ROUND_LIMIT } from "../../../../shared/review-helpers/review-round-limit";
import { buildStepPrompt } from "../../../../shared/prompt/build-step-prompt";

// -------------------------------------------------------------------
// Step 5.5: 自律判定（plan-run 所有 — must>0 なら自律 loop の continue で反復）
//         反復は loop 本体の check が返す判定 `continue` で行い、本体先頭の
//         apply-feedback へ巻き戻る（report の nextAction は repeat）。
//         round は normalize-findings 前にエンジンの反復番号から設定する。
// -------------------------------------------------------------------
export const agentVerdictStep: TaskStepDef = {
  key: "agent-verdict",
  phase: "自律判定",
  type: "task",
  maxRetries: 0,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "normalize-findings が生成した findings.json の must 件数で自律/人相を振り分ける。人への受け渡しは行わない。",
        ],
        criteria: [],
        approach: [
          "1. セッションディレクトリの findings.json を読み、counts.must / counts.should と round を確認する",
          `2. round < ${REVIEW_ROUND_LIMIT} で must>0 なら自律ループを継続し、apply-feedback へ戻る。`,
          `3. round が上限 ${REVIEW_ROUND_LIMIT} に達したら、残 must / should / want を既存 difit 登録経路で提示し、追加確認なしで await-human-review へ渡す。`,
          "4. must==0 の場合も difit 登録後に人間レビューへ進む。",
        ],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    const findingsRaw =
      findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY) ??
      readSessionFile(ctx.sessionDir, "findings.json");
    const findingsResult = validateFindingsJson(findingsRaw);
    if (!findingsResult.valid || !findingsResult.parsed) {
      return {
        status: "error",
        reasons: [findingsResult.error ?? "findings validation failed"],
      };
    }
    const { must, should } = findingsResult.parsed.counts;
    const round = findingsResult.parsed.round;
    if (must > 0) {
      if (round < REVIEW_ROUND_LIMIT) {
        return {
          status: "continue",
          reasons: [
            `must=${must} should=${should} — continue autonomous-review-cycle (${round}/${REVIEW_ROUND_LIMIT})`,
          ],
        };
      }
      return {
        status: "pass",
        reasons: [
          `自律上限 ${round}/${REVIEW_ROUND_LIMIT}。残指摘を既存の start-difit-review で登録し await-human-review へ渡します`,
        ],
      };
    }
    return {
      status: "pass",
      reasons: [`agent verdict passed: round=${round} must=0 -> proceed to human phase`],
    };
  },
};
