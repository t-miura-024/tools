import type { WorkflowDef, InitCtx, AfterInitResult } from "tado";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { SCRIPTS_DIR } from "./helper/scripts-dir.ts";
import { phase1HearingStep } from "./steps/01-phase1-hearing.ts";
import { planApprovalCycleStep } from "./steps/02-plan-approval-cycle/index.ts";
import { planApprovalExhaustedGateStep } from "./steps/03-plan-approval-exhausted-gate.ts";
import { phase4ResearcherStep } from "./steps/04-phase4-researcher.ts";
import { phase5ResearchCycleAuditStep } from "./steps/05-phase5-research-cycle-audit.ts";
import { phase6CheckpointStep } from "./steps/06-phase6-checkpoint.ts";
import { phase7WriterStep } from "./steps/07-phase7-writer.ts";
import { phase8ReviewerStep } from "./steps/08-phase8-reviewer.ts";
import { phase9WriterReviewerCycleStep } from "./steps/09-phase9-writer-reviewer-cycle.ts";
import { phase10FinalizeStep } from "./steps/10-phase10-finalize.ts";
import { phase11CompletionStep } from "./steps/11-phase11-completion.ts";

const def: WorkflowDef = {
  id: "deep-research",
  description:
    "ローカルSearXNGとSubAgentオーケストレーションで自律的な多段探索を行うワークフロー。Planner/Researcher/Writer/Reviewer/Auditorが連携し成果物を生成する。",

  beforeInit: async (_ctx: InitCtx) => {
    const checks: string[] = [];

    try {
      const searx =
        await $`curl -s -o /dev/null -w "%{http_code}" "http://localhost:8080/search?q=test&format=json"`
          .nothrow()
          .quiet();
      if (searx.stdout.toString().trim() !== "200") {
        checks.push("SearXNG is not responding (http://localhost:8080)");
      }
    } catch {
      checks.push("SearXNG check failed");
    }

    try {
      await $`command -v jq`.nothrow().quiet();
    } catch {
      checks.push("jq is not installed");
    }

    try {
      await $`command -v pandoc`.nothrow().quiet();
    } catch {
      checks.push("pandoc is not installed");
    }

    try {
      await $`command -v bun`.nothrow().quiet();
    } catch {
      checks.push("bun is not installed");
    }

    if (!existsSync(join(SCRIPTS_DIR, "node_modules"))) {
      const install = await $`cd ${SCRIPTS_DIR} && bun install`.nothrow().quiet();
      if (install.exitCode !== 0) {
        checks.push(`bun install failed in ${SCRIPTS_DIR}`);
      }
    }

    if (checks.length > 0) {
      throw new Error(`Prerequisites check failed:\n${checks.map((c) => `  - ${c}`).join("\n")}`);
    }
  },

  afterInit: async (ctx: InitCtx): Promise<AfterInitResult> => {
    const dbPath = join(ctx.sessionDir, "research.db");
    const result = await $`bun run ${join(SCRIPTS_DIR, "db.ts")} init --db-path ${dbPath}`
      .nothrow()
      .quiet();
    if (result.exitCode !== 0) {
      throw new Error(`DB init failed: ${result.stderr.toString()}`);
    }
    return { artifactDbPath: dbPath };
  },

  steps: [
    phase1HearingStep,
    planApprovalCycleStep,
    planApprovalExhaustedGateStep,
    phase4ResearcherStep,
    phase5ResearchCycleAuditStep,
    phase6CheckpointStep,
    phase7WriterStep,
    phase8ReviewerStep,
    phase9WriterReviewerCycleStep,
    phase10FinalizeStep,
    phase11CompletionStep,
  ],
};

export default def;
