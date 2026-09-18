import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import fs from "node:fs";
import { normalizeFindingsStep } from "../../../../review-diff/steps/03-human-review-loop/03.03-normalize-findings.ts";
import { EFFORT_KEY as REVIEW_EFFORT_KEY } from "../../../../shared/review-helpers/effort-key";

// -------------------------------------------------------------------
// Step 5: findings 正規化（review-diff から import — difit に触らない純粋処理）
// -------------------------------------------------------------------
export const normalizeFindingsPlanStep: TaskStepDef = {
  ...normalizeFindingsStep,
  phase: "findings 正規化",
  beforeStep: async (ctx) => {
    const effortPath = join(ctx.sessionDir, REVIEW_EFFORT_KEY);
    const effort = JSON.parse(fs.readFileSync(effortPath, "utf-8"));
    effort.round = ctx.loop!.iteration;
    fs.writeFileSync(effortPath, `${JSON.stringify(effort, null, 2)}\n`, "utf-8");
    return [];
  },
};
