import type { WorkflowDef } from "tado";
import { beforeInit } from "./helper/before-init.ts";
import { afterInit } from "./helper/after-init.ts";
import { reviewCycleStep } from "./steps/01-review-cycle/index.ts";
import { reviewExhaustedStep } from "./steps/02-review-exhausted.ts";
import { createRefinedStep } from "./steps/03-create-refined.ts";
import { finalizeStep } from "./steps/04-finalize.ts";

const def: WorkflowDef = {
  id: "plan-create",
  description:
    "GitHub Issueとして計画を新規作成・リファインメントするワークフロー。from-Issue取り込みとGrillヒアリングを経て本文レビューを行い、承認後にRefined Issueを直接作成する。",

  beforeInit,
  afterInit,

  steps: [reviewCycleStep, reviewExhaustedStep, createRefinedStep, finalizeStep],
};

export default def;
