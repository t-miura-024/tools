import { runCommand } from "../plan-init-config-gh/run-command";
import { GitCommandError } from "../plan-init-config-gh/git-command-error";
import { TransitionPlanError } from "./transition-plan-error";

export async function defaultListSubIssueNumbers(params: {
  repo: string;
  number: number;
}): Promise<number[]> {
  try {
    const { stdout } = await runCommand("gh", [
      "api",
      `repos/${params.repo}/issues/${params.number}/sub_issues`,
      "--paginate",
      "--slurp",
    ]);
    const pages = JSON.parse(stdout) as Array<Array<{ number?: number }>>;
    const issues = pages.flat();
    return issues.flatMap((issue) => (typeof issue.number === "number" ? [issue.number] : []));
  } catch (error) {
    if (error instanceof GitCommandError) throw new TransitionPlanError(error.message);
    throw error;
  }
}
