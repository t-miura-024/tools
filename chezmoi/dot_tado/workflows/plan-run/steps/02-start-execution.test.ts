import { describe, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as mod from "./02-start-execution.ts";
import {
  makeSnapshotCtx,
  createSnapshotSessionDir,
  normalizePrompt,
  expectPromptMd,
  snapMdPath,
} from "../../shared/prompt-snapshot/helper.ts";

function findTaskStep(): { task: { buildPrompt: (ctx: never) => string } } {
  const found = Object.values(mod).find(
    (v) =>
      typeof v === "object" &&
      v !== null &&
      "task" in v &&
      typeof (v as { task?: { buildPrompt?: unknown } }).task?.buildPrompt === "function",
  );
  if (!found) throw new Error("task step not found");
  return found as { task: { buildPrompt: (ctx: never) => string } };
}

describe("02-start-execution prompt snapshot", () => {
  let sessionDir: string;
  beforeEach(() => {
    sessionDir = createSnapshotSessionDir("start-exec-");
  });
  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("buildPrompt snapshot", () => {
    const step = findTaskStep();
    const ctx = makeSnapshotCtx(sessionDir);
    const prompt = step.task.buildPrompt(ctx as never);
    expectPromptMd(normalizePrompt(prompt, sessionDir), snapMdPath(import.meta.path));
  });
});
