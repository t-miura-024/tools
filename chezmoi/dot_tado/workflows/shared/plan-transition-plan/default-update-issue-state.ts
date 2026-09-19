import { runCommand } from "../plan-init-config-gh/run-command";
import { GitCommandError } from "../plan-init-config-gh/git-command-error";
import { TransitionPlanError } from "./transition-plan-error";

export async function defaultUpdateIssueState(params: {
  repo: string;
  number: number;
  state: "open" | "closed";
}): Promise<void> {
  const action = params.state === "closed" ? "close" : "reopen";
  try {
    await runCommand("gh", ["issue", action, String(params.number), "--repo", params.repo]);
  } catch (error) {
    if (error instanceof GitCommandError) {
      if (error.exitCode === 1 && /already (closed|open)/.test(error.stderr)) {
        return;
      }
      throw new TransitionPlanError(error.message);
    }
    throw error;
  }
}
