import { loadConfig, type MtPlanConfig, type PlanStatus, PLAN_STATUSES, InitConfigError } from "./init-config";
import { runCommand, GitCommandError } from "./init-config-gh";

export class ListPlansError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListPlansError";
  }
}

export type ProjectItemIssue = {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
};

export type ProjectItem = {
  id: string;
  issue: ProjectItemIssue;
  fieldValueByName?: Record<string, { name: string; optionId: string | null }>;
};

export type ListedPlan = {
  itemId: string;
  number: number;
  title: string;
  url: string;
  status: PlanStatus;
  state: "OPEN" | "CLOSED";
  createdAt: string;
};

export type ListPlansResult = {
  config: MtPlanConfig;
  statuses: readonly PlanStatus[];
  plans: ListedPlan[];
};

function isPlanStatus(value: string): value is PlanStatus {
  return PLAN_STATUSES.includes(value as PlanStatus);
}

function parsePlanStatus(value: string): PlanStatus {
  if (!isPlanStatus(value)) {
    throw new ListPlansError(
      `Unsupported status: ${value}. Supported statuses: ${PLAN_STATUSES.join(", ")}`,
    );
  }
  return value;
}

function reverseOptionLookup(
  config: MtPlanConfig,
): Map<string, PlanStatus> {
  const map = new Map<string, PlanStatus>();
  for (const status of PLAN_STATUSES) {
    map.set(config.statusOptions[status], status);
  }
  return map;
}

export function extractPlanStatus(
  item: ProjectItem,
  config: MtPlanConfig,
): PlanStatus | null {
  const field = item.fieldValueByName?.["Status"];
  if (!field || !field.optionId) {
    return null;
  }
  const lookup = reverseOptionLookup(config);
  return lookup.get(field.optionId) ?? null;
}

export function sortByCreatedAtDesc(plans: ListedPlan[]): ListedPlan[] {
  return [...plans].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function filterAndSort(
  items: readonly ProjectItem[],
  config: MtPlanConfig,
  statuses: readonly PlanStatus[],
): ListedPlan[] {
  const allowed = new Set(statuses);
  const plans: ListedPlan[] = [];

  for (const item of items) {
    const status = extractPlanStatus(item, config);
    if (!status || !allowed.has(status)) {
      continue;
    }
    plans.push({
      itemId: item.id,
      number: item.issue.number,
      title: item.issue.title,
      url: item.issue.url,
      status,
      state: item.issue.state,
      createdAt: item.issue.createdAt,
    });
  }

  return sortByCreatedAtDesc(plans);
}

function buildListQuery(): string {
  return `
    query($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            nodes {
              id
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  optionId
                }
              }
              content {
                ... on Issue {
                  number
                  title
                  url
                  state
                  createdAt
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;
}

type GhListResponse = {
  data?: {
    node?: {
      items?: {
        nodes?: Array<{
          id: string;
          fieldValueByName?: {
            name?: string;
            optionId?: string | null;
          } | null;
          content?: {
            number: number;
            title: string;
            url: string;
            state: "OPEN" | "CLOSED";
            createdAt: string;
          } | null;
        }>;
        pageInfo?: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
  errors?: Array<{ message: string }>;
};

export async function fetchProjectItems(
  config: MtPlanConfig,
): Promise<ProjectItem[]> {
  const query = buildListQuery();
  const allNodes: ProjectItem[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const args = [
      "api",
      "graphql",
      "-H",
      "GraphQL-Features: project_v2",
      "-f",
      `query=${query}`,
      "-f",
      `projectId=${config.projectId}`,
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
        throw new ListPlansError(error.message);
      }
      throw error;
    }
    const response = JSON.parse(stdout) as GhListResponse;

    if (response.errors && response.errors.length > 0) {
      throw new ListPlansError(
        `gh api graphql returned errors: ${response.errors.map((e) => e.message).join("; ")}`,
      );
    }

    const page = response.data?.node?.items;
    const nodes = page?.nodes ?? [];
    const pageInfo = page?.pageInfo;

    for (const node of nodes) {
      if (!node.content) continue;
      allNodes.push({
        id: node.id,
        issue: node.content,
        fieldValueByName: node.fieldValueByName
          ? {
              Status: {
                name: node.fieldValueByName.name ?? "",
                optionId: node.fieldValueByName.optionId ?? null,
              },
            }
          : undefined,
      });
    }

    hasNextPage = pageInfo?.hasNextPage ?? false;
    after = pageInfo?.endCursor ?? null;
  }

  return allNodes;
}

export type ListPlansOptions = {
  config: MtPlanConfig;
  statuses?: readonly PlanStatus[];
  fetchItems?: (config: MtPlanConfig) => Promise<ProjectItem[]>;
};

export async function listPlans(
  options: ListPlansOptions,
): Promise<ListPlansResult> {
  const statuses = options.statuses ?? ["refined", "in-progress"];
  const fetch = options.fetchItems ?? fetchProjectItems;
  const items = await fetch(options.config);
  return {
    config: options.config,
    statuses,
    plans: filterAndSort(items, options.config, statuses),
  };
}

function formatCreatedAt(iso: string): string {
  return iso.slice(0, 10);
}

export function formatListPlansResult(result: ListPlansResult): string {
  if (result.plans.length === 0) {
    return [
      "plans: none",
      `statuses: ${result.statuses.join(", ")}`,
      `project: ${result.config.owner}/${result.config.projectNumber}`,
    ].join("\n");
  }

  const lines: string[] = [];
  result.plans.forEach((plan, index) => {
    lines.push(
      `${index + 1}. [${plan.status}] ${plan.title} (#${plan.number}) ${formatCreatedAt(plan.createdAt)}`,
    );
  });
  return lines.join("\n");
}

export type ListPlansCliOptions = {
  configPath?: string;
  statuses: PlanStatus[];
  help?: boolean;
};

export function parseListPlansCli(argv: readonly string[]): ListPlansCliOptions {
  const options: ListPlansCliOptions = { statuses: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new ListPlansError("--config requires a path.");
      }
      options.configPath = value;
      index += 1;
      continue;
    }

    options.statuses.push(parsePlanStatus(arg));
  }

  return options;
}

export function usage(): string {
  return [
    "Usage: bun <mt-plan-skill-dir>/list-plans.ts [--config <path>] [statuses...]",
    "",
    "Lists plans from the GitHub Project. Default statuses: refined in-progress.",
    "Config is loaded from ~/.config/mt-plan/config.json (see init-config.ts).",
    "",
    `Supported statuses: ${PLAN_STATUSES.join(", ")}`,
  ].join("\n");
}

if (require.main === module) {
  void (async () => {
    try {
      const options = parseListPlansCli(process.argv.slice(2));
      if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
      }
      const config = loadConfig(options.configPath);
      const statuses =
        options.statuses.length > 0 ? options.statuses : ["refined", "in-progress"];
      const result = await listPlans({ config, statuses });
      process.stdout.write(`${formatListPlansResult(result)}\n`);
    } catch (error) {
      if (error instanceof InitConfigError || error instanceof ListPlansError) {
        process.stderr.write(`${error.message}\n`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
    }
  })();
}
