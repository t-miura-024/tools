import { runCommand } from "../plan-init-config-gh/run-command";
import { GitCommandError } from "../plan-init-config-gh/git-command-error";
import { TransitionPlanError } from "./transition-plan-error";

export async function defaultReadIssueBody(params: {
  repo: string;
  number: number;
}): Promise<string> {
  try {
    const { stdout } = await runCommand("gh", [
      "issue",
      "view",
      String(params.number),
      "--repo",
      params.repo,
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    return stdout.trim();
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new TransitionPlanError(error.message);
    }
    throw error;
  }
}
