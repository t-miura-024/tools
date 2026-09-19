import { InitConfigError } from "../plan-init-config/init-config-error";
import type { ProjectV2 } from "../plan-init-config/types";
import { tryFetchUserProject } from "./try-fetch-user-project";
import { tryFetchOrgProject } from "./try-fetch-org-project";
import { mapProject } from "./map-project";

export async function fetchProject(owner: string, projectNumber: number): Promise<ProjectV2> {
  const raw =
    (await tryFetchUserProject(owner, projectNumber).catch(() => null)) ??
    (await tryFetchOrgProject(owner, projectNumber)) ??
    null;

  if (!raw) {
    throw new InitConfigError(
      `Project #${projectNumber} not found for user/org '${owner}'. ` +
        `Verify the project exists and the 'gh' CLI is authenticated with 'project' scope.`,
    );
  }

  return mapProject(raw);
}
