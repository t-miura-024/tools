import type { CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText, readSessionFile } from "tado/artifacts";

// -----------------------------------------------------------------
// Step 1b: 分析サマリの人間確認（第一ゲート）
// -----------------------------------------------------------------
export const confirmAnalysisStep: HumanGateStepDef = {
  key: "confirm-analysis",
  phase: "分析確認",
  type: "human_gate",
  maxRetries: 1,
  onFail: { action: "abort" },
  humanGate: {
    presentArtifacts: ["grill-map.md", "analysis.md", "evidence.json"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "decision",
        title: "判定",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "分析を承認してgrillへ進む",
            desc: "走査結果が妥当。grill質問へ進む",
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "走査をやり直す",
            desc: "スコープが的外れ。grillに戻って再走査する（loop が grill 先頭へ巻き戻る）",
            input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
  check: (ctx: CheckCtx): CheckResult => {
    try {
      const grillMap =
        readSessionFile(ctx.sessionDir, "grill-map.md") ??
        findArtifactText(ctx.artifacts, "grill-map.md", ctx.sessionDir);
      const analysis =
        readSessionFile(ctx.sessionDir, "analysis.md") ??
        findArtifactText(ctx.artifacts, "analysis.md", ctx.sessionDir);
      const evidence =
        readSessionFile(ctx.sessionDir, "evidence.json") ??
        findArtifactText(ctx.artifacts, "evidence.json", ctx.sessionDir);
      if (!grillMap || !analysis || !evidence)
        return {
          status: "fail",
          reasons: ["confirm-analysis: required artifacts missing"],
        };
      return { status: "pass", reasons: [] };
    } catch (e) {
      return { status: "fail", reasons: [String(e)] };
    }
  },
};
