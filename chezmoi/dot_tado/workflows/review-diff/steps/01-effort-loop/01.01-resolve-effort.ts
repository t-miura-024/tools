import type { ArtifactRecord, CheckCtx, CheckResult } from "tado";
import type { HumanGateStepDef } from "tado/types/workflow-def.ts";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { parseJson } from "../../../shared/review-helpers/parse-json";
import { validateEffort } from "../../../shared/review-helpers/validate-effort";
import { EFFORT_KEY } from "../../../shared/review-helpers/effort-key";
export const resolveEffortStep: HumanGateStepDef = {
  key: "resolve-effort",
  phase: "effort 解決",
  type: "human_gate",
  maxRetries: 3,
  onFail: { action: "abort" },
  humanGate: {
    // presentArtifacts wiring: effort.json is optional at gate time; missing is pass with defaults (generated in collect-context). See check below.
    // NOTE(plan93): width/depth choices duplicated with plan-create/review_gate — future extraction to shared/effort.ts
    presentArtifacts: ["effort.json"],
    outcomeQuestionKey: "decision",
    questions: [
      {
        key: "width",
        title: "width",
        description: "検証広さ: 累積ティアで採用観点数を決定 (low=4 → max=15)",
        type: "single_choice",
        required: true,
        choices: [
          { value: "low", label: "low", desc: "4観点 (Tier1)" },
          { value: "medium", label: "medium", desc: "8観点 (Tier1-2)" },
          { value: "high", label: "high", desc: "12観点 (Tier1-3)" },
          { value: "xhigh", label: "xhigh", desc: "14観点 (Tier1-4)" },
          { value: "max", label: "max", desc: "15観点 (全観点)" },
        ],
      },
      {
        key: "depth",
        title: "depth",
        description: "検証深さ: 担当観点数で深さを制御 (max=1:1 → low=1:all)",
        type: "single_choice",
        required: true,
        choices: [
          { value: "low", label: "low", desc: "全観点/レビュアー (最浅)" },
          { value: "medium", label: "medium", desc: "4観点/レビュアー" },
          { value: "high", label: "high", desc: "3観点/レビュアー" },
          { value: "xhigh", label: "xhigh", desc: "2観点/レビュアー" },
          { value: "max", label: "max", desc: "1観点/レビュアー (最深)" },
        ],
      },
      {
        key: "decision",
        title: "判定",
        type: "choice_with_input",
        choices: [
          {
            value: "approve",
            label: "effort を確定して次へ",
            desc: "width/depth/base を確認し検証を開始する",
            input: { required: false, maxLength: 500 },
          },
          {
            value: "request_changes",
            label: "修正する",
            desc: "effort を修正する",
            input: { required: true, placeholder: "修正理由を入力", maxLength: 500 },
          },
          { value: "abort", label: "中断" },
        ],
      },
    ],
  },
  check: (ctx: CheckCtx): CheckResult => {
    // wiring: presentArtifacts effort.json may be absent at resolve-effort — pass with defaults, collect-context generates it
    const raw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], EFFORT_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, EFFORT_KEY);
    if (!raw) {
      return {
        status: "pass",
        reasons: [
          "effort.json not found — will be generated with defaults width=medium depth=medium base=origin/main in collect-context",
        ],
      };
    }
    const parsed = parseJson(raw);
    const validation = validateEffort(parsed);
    if (validation.status === "error") {
      return { status: "error", reasons: validation.reasons };
    }
    if (validation.status === "fail") {
      return { status: "fail", reasons: validation.reasons };
    }
    return {
      status: "pass",
      reasons: [
        `effort: width=${validation.width} depth=${validation.depth} round=${validation.round}`,
      ],
    };
  },
};
