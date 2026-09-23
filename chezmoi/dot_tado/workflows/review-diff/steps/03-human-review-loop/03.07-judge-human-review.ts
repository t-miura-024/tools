import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { readGateDecision } from "../../helper/read-gate-decision.ts";
import { judgeGateContinuation } from "../../helper/judge-gate-continuation.ts";
import { HUMAN_REVIEW_LOOP_KEY } from "../../helper/human-review-loop-key.ts";
export const judgeHumanReviewStep: TaskStepDef =
  // -------------------------------------------------------------------
  // judge-human-review: human-review-loop 末尾の分岐判定（loop の check）。
  //   gateAnswers["await-human-review"] を読む唯一の分岐点。request_changes →
  //   判定 continue で human-review-loop 先頭（verify-fix）へ巻き戻る。
  //   round は人間 loop の反復に写像しないため前進させない。
  // -------------------------------------------------------------------
  {
    key: "judge-human-review",
    phase: "人間差し戻し判定",
    type: "task",
    maxRetries: 0,
    onFail: { action: "abort" },
    task: {
      action: "orchestrate",
      readonly: true,
      buildPrompt: (ctx: PromptCtx) =>
        [
          "## 目的",
          "",
          "await-human-review の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
          "",
          "## 指示",
          "",
          "- 状態を変更しない（read-only）。ファイルの作成・編集、`mt difit` コマンドの実行をしない",
          "- report のみ行い、分岐判定が check に委ねられていることを報告する",
          "",
          "## セッション情報",
          "",
          `- セッションディレクトリ: ${ctx.sessionDir}`,
        ].join("\n"),
    },
    check: (ctx: CheckCtx): CheckResult =>
      judgeGateContinuation(readGateDecision(ctx.gateAnswers, "await-human-review"), {
        gateKey: "await-human-review",
        loopKey: HUMAN_REVIEW_LOOP_KEY,
        headKey: "verify-fix",
        abortHint:
          "difit セッションの後始末が必要な場合は `mt difit done`（冪等・exit 0）を手動実行してください",
      }),
  };
