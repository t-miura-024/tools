import { PLAN_STATUSES } from "../plan-init-config/plan-statuses";
import type { MtPlanConfig, PlanStatus } from "../plan-init-config/types";
import { runCommand } from "../plan-init-config-gh/run-command";
import { GitCommandError } from "../plan-init-config-gh/git-command-error";
import { TransitionPlanError } from "./transition-plan-error";
import { buildFindItemQuery } from "./build-find-item-query";

export async function defaultFindPlanItem(params: {
  config: MtPlanConfig;
  number: number;
  repo?: string;
}): Promise<{ itemId: string; currentStatus: PlanStatus; repo: string }> {
  type ItemNode = {
    id: string;
    fieldValueByName?: { optionId?: string | null } | null;
    content?: { number: number; repository: { nameWithOwner: string } } | null;
  };
  type PageResponse = {
    data?: {
      node?: {
        items?: {
          nodes?: ItemNode[];
          pageInfo?: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  const allNodes: ItemNode[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const args = [
      "api",
      "graphql",
      "-H",
      "GraphQL-Features: project_v2",
      "-f",
      `query=${buildFindItemQuery()}`,
      "-f",
      `projectId=${params.config.projectId}`,
    ];
    if (after) {
      args.push("-f", `after=${after}`);
    }

    let stdout: string;
    try {
      const result = await runCommand("gh", args);
      stdout = result.stdout;
    } catch (error) {
      if (error instanceof GitCommandError) {
        throw new TransitionPlanError(error.message);
      }
      throw error;
    }
    const response = JSON.parse(stdout) as PageResponse;

    if (response.errors && response.errors.length > 0) {
      throw new TransitionPlanError(
        `gh api graphql returned errors: ${response.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const page = response.data?.node?.items;
    const nodes = page?.nodes ?? [];
    const pageInfo = page?.pageInfo;

    allNodes.push(...nodes);

    hasNextPage = pageInfo?.hasNextPage ?? false;
    after = pageInfo?.endCursor ?? null;
  }

  const candidates = allNodes.filter(
    (node) => node.content && node.content.number === params.number,
  );

  if (candidates.length === 0) {
    throw new TransitionPlanError(
      `Plan #${params.number} not found in project ${params.config.owner}/${params.config.projectNumber}.`,
    );
  }

  let found: ItemNode | undefined;
  if (params.repo) {
    found = candidates.find((node) => node.content!.repository.nameWithOwner === params.repo);
    if (!found) {
      throw new TransitionPlanError(
        `Plan #${params.number} not found in repo '${params.repo}'. Available repos: ${[...new Set(candidates.map((c) => c.content!.repository.nameWithOwner))].join(", ")}.`,
      );
    }
  } else if (candidates.length === 1) {
    found = candidates[0];
  } else {
    const repos = [...new Set(candidates.map((c) => c.content!.repository.nameWithOwner))];
    throw new TransitionPlanError(
      `Plan #${params.number} exists in multiple repos: ${repos.join(", ")}. ` +
        `Re-run with --repo <owner/repo> to disambiguate.`,
    );
  }

  if (!found || !found.content) {
    throw new TransitionPlanError(
      `Plan #${params.number} not found in project ${params.config.owner}/${params.config.projectNumber}.`,
    );
  }

  const optionId = found.fieldValueByName?.optionId;
  if (!optionId) {
    throw new TransitionPlanError(`Plan #${params.number} has no Status value in the Project.`);
  }

  const reverseLookup = new Map<string, PlanStatus>();
  for (const status of PLAN_STATUSES) {
    reverseLookup.set(params.config.statusOptions[status], status);
  }

  const currentStatus = reverseLookup.get(optionId);
  if (!currentStatus) {
    throw new TransitionPlanError(
      `Plan #${params.number} has unknown Status option '${optionId}'.`,
    );
  }

  return {
    itemId: found.id,
    currentStatus,
    repo: found.content.repository.nameWithOwner,
  };
}
