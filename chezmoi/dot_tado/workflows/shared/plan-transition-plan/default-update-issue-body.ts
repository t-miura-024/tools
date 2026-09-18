import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../plan-init-config-gh/run-command";
import { GitCommandError } from "../plan-init-config-gh/git-command-error";
import { TransitionPlanError } from "./transition-plan-error";

export async function defaultUpdateIssueBody(params: {
  repo: string;
  number: number;
  body: string;
}): Promise<void> {
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "mt-plan-body-"));
  const tmpPath = path.join(tmpDir, "body.md");
  try {
    await fsp.writeFile(tmpPath, params.body, "utf8");
    try {
      await runCommand("gh", [
        "issue",
        "edit",
        String(params.number),
        "--repo",
        params.repo,
        "--body-file",
        tmpPath,
      ]);
    } catch (error) {
      if (error instanceof GitCommandError) {
        throw new TransitionPlanError(error.message);
      }
      throw error;
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}
