import { InitConfigError } from "../plan-init-config/init-config-error";
import { runCommand } from "./run-command";
import { projectV2UserQuery } from "./project-v2-user-query";
import type { GhProjectViewResponse, RawProjectV2 } from "./types";

export async function tryFetchUserProject(
  owner: string,
  projectNumber: number,
): Promise<RawProjectV2> {
  const args = [
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: project_v2",
    "-f",
    `query=${projectV2UserQuery()}`,
    "-f",
    `login=${owner}`,
    "-F",
    `number=${projectNumber}`,
  ];

  const { stdout } = await runCommand("gh", args);
  const response = JSON.parse(stdout) as GhProjectViewResponse;

  if (response.errors && response.errors.length > 0) {
    const isUserNotFound = response.errors.some((e) =>
      /Could not resolve to a (User|Repository)/.test(e.message),
    );
    if (isUserNotFound) {
      throw new InitConfigError("not found");
    }
    throw new InitConfigError(
      `gh api graphql returned errors: ${response.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const raw = response.data?.user?.projectV2 ?? null;
  if (!raw) {
    throw new InitConfigError("not found");
  }
  return raw;
}
