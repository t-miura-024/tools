import { InitConfigError } from "../plan-init-config/init-config-error";
import { runCommand } from "./run-command";
import { projectV2OrgQuery } from "./project-v2-org-query";
import type { GhProjectViewResponse, RawProjectV2 } from "./types";

export async function tryFetchOrgProject(
  owner: string,
  projectNumber: number,
): Promise<RawProjectV2> {
  const args = [
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: project_v2",
    "-f",
    `query=${projectV2OrgQuery()}`,
    "-f",
    `login=${owner}`,
    "-F",
    `number=${projectNumber}`,
  ];

  const { stdout } = await runCommand("gh", args);
  const response = JSON.parse(stdout) as GhProjectViewResponse;

  if (response.errors && response.errors.length > 0) {
    const isOrgNotFound = response.errors.some((e) =>
      /Could not resolve to an Organization/.test(e.message),
    );
    if (isOrgNotFound) {
      throw new InitConfigError("not found");
    }
    throw new InitConfigError(
      `gh api graphql returned errors: ${response.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const raw = response.data?.organization?.projectV2 ?? null;
  if (!raw) {
    throw new InitConfigError("not found");
  }
  return raw;
}
