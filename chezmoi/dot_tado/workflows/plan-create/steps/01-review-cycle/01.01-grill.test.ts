import { describe, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import * as mod from "./01.01-grill.ts";
import {
  makeSnapshotCtx,
  createSnapshotSessionDir,
  normalizePrompt,
  expectPromptMd,
  snapMdPath,
} from "../../../shared/prompt-snapshot/helper.ts";

function findTaskBuildPrompt(): ((ctx: PromptCtx) => string) | null {
  for (const v of Object.values(mod)) {
    if (
      typeof v === "object" &&
      v !== null &&
      "task" in v &&
      typeof (v as TaskStepDef).task?.buildPrompt === "function"
    ) {
      return (v as TaskStepDef).task.buildPrompt;
    }
  }
  return null;
}

describe("01.01-grill prompt snapshot", () => {
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = createSnapshotSessionDir("snap-");
  });
  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("snapshot", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "acme", repo: "demo", nameWithOwner: "acme/demo" }),
    );
    const artifacts = [
      {
        id: 0,
        sessionId: path.basename(sessionDir),
        stepKey: "test",
        artifactKey: "repo-info.json",
        filePath: repoInfoPath,
        createdAt: "2026-01-01 00:00:00",
      },
    ];
    const ctx = makeSnapshotCtx(sessionDir, { artifacts: artifacts as never });
    const buildPrompt = findTaskBuildPrompt();
    if (!buildPrompt) throw new Error("task buildPrompt not found");
    const prompt = buildPrompt(ctx);
    expectPromptMd(normalizePrompt(prompt, sessionDir), snapMdPath(import.meta.path));
  });

  it("review snapshot", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "acme", repo: "demo", nameWithOwner: "acme/demo" }),
    );
    fs.writeFileSync(
      path.join(sessionDir, "issue-body.md"),
      "## ✅ 完了条件\n\n- 条件\n\n## 🧭 方針\n\n方針\n",
    );
    fs.writeFileSync(
      path.join(sessionDir, "review-findings.json"),
      JSON.stringify({
        reviewer: "mt-plan-reviewer",
        round: 2,
        cycleRound: 1,
        reviewedTargets: ["issue-body.md"],
        findings: [
          {
            id: "R2-F1",
            severity: "must",
            perspective: "A",
            type: "decision",
            target: "issue-body.md#§完了条件",
            evidence: "完了条件が『適切に』となっており判定不能",
            problem: "完了条件が検証可能な粒度になっていない",
            proposedQuestion: "完了条件をどの基準で判定しますか",
            proposedOptions: ["数値で判定", "手動確認", "別Issueで定義"],
            proposedFix: null,
          },
        ],
        counts: { must: 1, should: 0, want: 0 },
      }),
    );
    fs.writeFileSync(path.join(sessionDir, "review-decisions.md"), "## レビュー R1\n");
    const artifacts = [
      {
        id: 0,
        sessionId: path.basename(sessionDir),
        stepKey: "test",
        artifactKey: "repo-info.json",
        filePath: repoInfoPath,
        createdAt: "2026-01-01 00:00:00",
      },
    ];
    const ctx = makeSnapshotCtx(sessionDir, { artifacts: artifacts as never });
    const buildPrompt = findTaskBuildPrompt();
    if (!buildPrompt) throw new Error("task buildPrompt not found");
    const prompt = buildPrompt(ctx);
    expectPromptMd(normalizePrompt(prompt, sessionDir), snapMdPath(import.meta.path, "review"));
  });
});
