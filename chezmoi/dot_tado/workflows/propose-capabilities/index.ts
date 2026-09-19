import type { WorkflowDef } from "tado";
import { candidateCycleStep } from "./steps/01-candidate-cycle/index.ts";
import { presentExhaustedGateStep } from "./steps/02-present-exhausted-gate.ts";
import { createDraftsStep } from "./steps/03-create-drafts.ts";
import { confirmDoneStep } from "./steps/04-confirm-done.ts";

const def: WorkflowDef = {
  id: "propose-capabilities",
  description:
    "対象リポジトリを軽量走査しCapability軸の企画候補を発掘するワークフロー。3視点の並列ブレストで15案を収集しdraft Issueとして起票する。",

  steps: [candidateCycleStep, presentExhaustedGateStep, createDraftsStep, confirmDoneStep],
};

export default def;
