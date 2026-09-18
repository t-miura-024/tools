import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { readGateDecision } from "../../helper/read-gate-decision.ts";
import { judgeGateContinuation } from "../../helper/judge-gate-continuation.ts";
import { EFFORT_LOOP_KEY } from "../../helper/effort-loop-key.ts";
export const judgeEffortStep: TaskStepDef = // -------------------------------------------------------------------
  // judge-effort: effort-loop 末尾の分岐判定（loop の check）。
  //   gateAnswers["resolve-effort"] を読む唯一の分岐点。request_changes →
  //   判定 continue で effort-loop 先頭（resolve-effort）へ巻き戻る。
  // -------------------------------------------------------------------
  {
    key: "judge-effort",
    phase: "effort 差し戻し判定",
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
          "resolve-effort の人間判断（gateAnswers）を分岐判定の材料として報告する。分岐自体はこのステップの check が行う。",
          "",
          "## 指示",
          "",
          "- 状態を変更しない（read-only）。ファイルの作成・編集、コマンドの実行をしない",
          "- report のみ行い、分岐判定が check に委ねられていることを報告する",
          "",
          "## セッション情報",
          "",
          `- セッションディレクトリ: ${ctx.sessionDir}`,
        ].join("\n"),
    },
    check: (ctx: CheckCtx): CheckResult =>
      judgeGateContinuation(readGateDecision(ctx.gateAnswers, "resolve-effort"), {
        gateKey: "resolve-effort",
        loopKey: EFFORT_LOOP_KEY,
        headKey: "resolve-effort",
        abortHint: "中断のため effort.json の生成は行いません。",
      }),
  };
