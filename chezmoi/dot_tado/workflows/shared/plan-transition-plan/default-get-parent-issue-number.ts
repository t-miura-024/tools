import { runCommand } from "../plan-init-config-gh/run-command";
import { GitCommandError } from "../plan-init-config-gh/git-command-error";
import { TransitionPlanError } from "./transition-plan-error";

export async function defaultGetParentIssueNumber(params: {
  repo: string;
  number: number;
}): Promise<number | null> {
  try {
    const { stdout } = await runCommand("gh", [
      "api",
      `repos/${params.repo}/issues/${params.number}/parent`,
    ]);
    const response = JSON.parse(stdout) as { number?: number };
    return typeof response.number === "number" ? response.number : null;
  } catch (error) {
    if (
      error instanceof GitCommandError &&
      error.exitCode === 1 &&
      /No parent issue found/.test(error.stderr)
    ) {
      return null;
    }
    if (error instanceof GitCommandError) throw new TransitionPlanError(error.message);
    throw error;
  }
}
