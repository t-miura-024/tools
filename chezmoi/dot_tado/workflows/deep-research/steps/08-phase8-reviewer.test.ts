import { describe, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as mod from "./08-phase8-reviewer.ts";
import {
  makeSnapshotCtx,
  createSnapshotSessionDir,
  normalizePrompt,
  expectPromptMd,
  snapMdPath,
} from "../../shared/prompt-snapshot/helper.ts";

describe("08-phase8-reviewer prompt snapshot", () => {
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = createSnapshotSessionDir("snap-");
  });
  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("parallel subtasks snapshot", () => {
    const artifacts: never[] = [];
    const ctx = makeSnapshotCtx(sessionDir, {
      artifacts: artifacts as never,
      artifactDbPath: "/test/research.db",
    });
    const step = (
      mod as Record<
        string,
        { parallel?: { subtasks: { key: string; buildPrompt: (ctx: never) => string }[] } }
      >
    ).phase8ReviewerStep;
    if (!step?.parallel) throw new Error("parallel step not found");
    for (const sub of step.parallel.subtasks) {
      const prompt = sub.buildPrompt(ctx as never);
      expectPromptMd(normalizePrompt(prompt, sessionDir), snapMdPath(import.meta.path, sub.key));
    }
  });

  it("task snapshot", () => {
    const artifacts: never[] = [];
    const ctx = makeSnapshotCtx(sessionDir, {
      artifacts: artifacts as never,
      artifactDbPath: "/test/research.db",
    });
    const step = (mod as Record<string, { task: { buildPrompt: (ctx: never) => string } }>)
      .phase8ReviewerStep;
    expectPromptMd(
      normalizePrompt(step.task.buildPrompt(ctx as never), sessionDir),
      snapMdPath(import.meta.path),
    );
  });
});
