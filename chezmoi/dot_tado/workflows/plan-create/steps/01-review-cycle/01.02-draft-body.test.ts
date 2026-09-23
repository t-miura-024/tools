import { describe, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as mod from "./01.02-draft-body.ts";
import {
  makeSnapshotCtx,
  createSnapshotSessionDir,
  normalizePrompt,
  expectPromptMd,
  snapMdPath,
} from "../../../shared/prompt-snapshot/helper.ts";

function findTaskBuildPrompt(): ((ctx: never) => string) | null {
  for (const v of Object.values(mod)) {
    if (
      typeof v === "object" &&
      v !== null &&
      "task" in v &&
      typeof (v as { task?: { buildPrompt?: unknown } }).task?.buildPrompt === "function"
    ) {
      return (v as { task: { buildPrompt: (ctx: never) => string } }).task.buildPrompt;
    }
  }
  return null;
}

describe("01.02-draft-body prompt snapshot", () => {
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
});
