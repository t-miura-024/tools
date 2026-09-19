import type { WorkflowDef } from "tado";
import { candidateCycleStep } from "./steps/01-candidate-cycle/index.ts";
import { presentExhaustedGateStep } from "./steps/02-present-exhausted-gate.ts";
import { createDraftsStep } from "./steps/03-create-drafts.ts";
import { confirmDoneStep } from "./steps/04-confirm-done.ts";

const def: WorkflowDef = {
  id: "propose-quality",
  description:
    "対象リポジトリのコード品質を分析しQuality軸の改善候補を発掘するワークフロー。コード健全性・テスト充実などの視点で15案を収集しdraft Issue化する。",

  steps: [candidateCycleStep, presentExhaustedGateStep, createDraftsStep, confirmDoneStep],
};

export default def;
