import type { WorkflowDef, InitCtx } from "tado";
import { join } from "node:path";
import fs from "node:fs";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import os from "node:os";
import type { RepoInfo } from "./types.ts";
import { analysisCycleStep } from "./steps/01-analysis-cycle/index.ts";
import { analysisExhaustedGateStep } from "./steps/02-analysis-exhausted-gate.ts";
import { updateCycleStep } from "./steps/03-update-cycle/index.ts";
import { updateExhaustedGateStep } from "./steps/04-update-exhausted-gate.ts";
import { updateIssueStep } from "./steps/05-update-issue.ts";
import { reportStep } from "./steps/06-report.ts";
import { loadConfig } from "../shared/plan-init-config/load-config";

const def: WorkflowDef = {
  id: "plan-update",
  description:
    "既存Plan Issueを実行断面の事実走査で再検証し、grillで合意して更新するワークフロー。",

  beforeInit: async (_ctx: InitCtx) => {
    try {
      loadConfig();
    } catch (error) {
      throw new Error(
        `mt-plan config not found: ${error instanceof Error ? error.message : String(error)}. Run 'mt-plan init' first.`,
      );
    }
    const grillSkill = join(os.homedir(), ".cursor", "skills", "mt-grill", "SKILL.md");
    if (!fs.existsSync(grillSkill)) {
      throw new Error(`mt-grill SKILL.md not found: ${grillSkill}`);
    }
  },

  afterInit: async (ctx: InitCtx) => {
    let stdout: string;
    try {
      stdout = execSync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
        encoding: "utf-8",
      }).trim();
    } catch (error) {
      throw new Error(
        `gh repo view failed: ${error instanceof Error ? error.message : String(error)}. gh auth login と git リポジトリを確認してください。`,
      );
    }
    if (!stdout || !stdout.includes("/")) {
      throw new Error(`gh repo view の出力が不正です: "${stdout}"`);
    }
    const parts = stdout.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(`gh repo view の出力が不正です: "${stdout}"`);
    }
    const [owner, repo] = parts;
    const validName = /^[\w.-]+$/;
    if (!validName.test(owner) || !validName.test(repo)) {
      throw new Error(`repo名が不正です: "${stdout}"`);
    }
    const repoInfo: RepoInfo = { owner, repo, nameWithOwner: stdout };
    const repoInfoPath = join(ctx.sessionDir, "repo-info.json");
    writeFileSync(repoInfoPath, JSON.stringify(repoInfo, null, 2), "utf-8");
    return { artifacts: [{ key: "repo-info.json", path: repoInfoPath }] };
  },

  steps: [
    analysisCycleStep,
    analysisExhaustedGateStep,
    updateCycleStep,
    updateExhaustedGateStep,
    updateIssueStep,
    reportStep,
  ],
};

export default def;
