import { describe, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import type { PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import * as mod from "./01.06-judge-fix-exhausted.ts";
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

describe("01.06-judge-fix-exhausted prompt snapshot", () => {
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = createSnapshotSessionDir("snap-");
  });
  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("snapshot", () => {
    const ctx = makeSnapshotCtx(sessionDir, { artifacts: [] });
    const buildPrompt = findTaskBuildPrompt();
    if (!buildPrompt) throw new Error("task buildPrompt not found");
    expectPromptMd(normalizePrompt(buildPrompt(ctx), sessionDir), snapMdPath(import.meta.path));
  });
});
