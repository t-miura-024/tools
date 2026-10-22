import { describe, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import type { PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import * as mod from "./01.09-judge-review.ts";
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

describe("01.09-judge-review prompt snapshot", () => {
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = createSnapshotSessionDir("snap-");
  });
  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("snapshot", () => {
    const artifacts: never[] = [];
    const ctx = makeSnapshotCtx(sessionDir, { artifacts: artifacts as never });
    const buildPrompt = findTaskBuildPrompt();
    if (!buildPrompt) throw new Error("task buildPrompt not found");
    const prompt = buildPrompt(ctx);
    expectPromptMd(normalizePrompt(prompt, sessionDir), snapMdPath(import.meta.path));
  });
});
