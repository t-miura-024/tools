import { loadConfig, PLAN_STATUSES, type MtPlanConfig, type PlanStatus, InitConfigError } from "./init-config";
import { runCommand, GitCommandError } from "./init-config-gh";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export class TransitionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionPlanError";
  }
}

export type TransitionSideEffect = {
  itemId: string;
  number: number;
  sourceStatus: PlanStatus;
  targetStatus: PlanStatus;
  bodyUpdated: boolean;
  issueStateChanged: boolean;
  issueClosed: boolean;
};

function isPlanStatus(value: string): value is PlanStatus {
  return PLAN_STATUSES.includes(value as PlanStatus);
}

function assertPlanStatus(value: string): asserts value is PlanStatus {
  if (!isPlanStatus(value)) {
    throw new TransitionPlanError(
      `Unsupported target status: ${value}. Supported statuses: ${PLAN_STATUSES.join(", ")}`,
    );
  }
}

function formatHistoryEntry(
  sourceStatus: PlanStatus,
  targetStatus: PlanStatus,
): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  return `- ${yyyy}-${mm}-${dd} ${hh}:${mi} [${targetStatus}] ${sourceStatus} から遷移`;
}

export function appendHistoryEntry(
  body: string,
  sourceStatus: PlanStatus,
  targetStatus: PlanStatus,
): string {
  const entry = formatHistoryEntry(sourceStatus, targetStatus);

  const sectionMatch = body.match(/## 🐢 履歴[ \t]*\n([\s\S]*?)(?=\n## |\s*$)/);

  if (sectionMatch) {
    const existingContent = sectionMatch[1].trim();
    if (existingContent.length > 0) {
      return body.replace(
        /(## 🐢 履歴[ \t]*\n)/,
        `$1${entry}\n`,
      );
    }
    return body.replace(
      /(## 🐢 履歴[ \t]*\n)/,
      `$1\n${entry}\n`,
    );
  }

  if (body.includes("## 🐢 履歴")) {
    return `${body.trimEnd()}\n\n${entry}\n`;
  }

  return `${body.trimEnd()}\n\n## 🐢 履歴\n\n${entry}\n`;
}

export type UpdateItemStatusFn = (params: {
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
}) => Promise<void>;

export type UpdateIssueStateFn = (params: {
  repo: string;
  number: number;
  state: "open" | "closed";
}) => Promise<void>;

export type UpdateIssueBodyFn = (params: {
  repo: string;
  number: number;
  body: string;
}) => Promise<void>;

export type FindPlanItemFn = (params: {
  config: MtPlanConfig;
  number: number;
  repo?: string;
}) => Promise<{ itemId: string; currentStatus: PlanStatus; repo: string }>;

export type TransitionPlanOptions = {
  config: MtPlanConfig;
  number: number;
  targetStatus: PlanStatus;
  repo?: string;
  findPlanItem?: FindPlanItemFn;
  updateItemStatus?: UpdateItemStatusFn;
  updateIssueState?: UpdateIssueStateFn;
  readIssueBody?: (params: { repo: string; number: number }) => Promise<string>;
  updateIssueBody?: UpdateIssueBodyFn;
  skipHistoryAppend?: boolean;
};

export type TransitionPlanResult = TransitionSideEffect;

export async function transitionPlan(
  options: TransitionPlanOptions,
): Promise<TransitionPlanResult> {
  assertPlanStatus(options.targetStatus);

  const find = options.findPlanItem ?? defaultFindPlanItem;
  const found = await find({
    config: options.config,
    number: options.number,
    repo: options.repo,
  });
  const sourceStatus = found.currentStatus;

  if (sourceStatus === options.targetStatus) {
    throw new TransitionPlanError(
      `Plan #${options.number} is already in status '${options.targetStatus}'.`,
    );
  }

  const updateStatus = options.updateItemStatus ?? defaultUpdateItemStatus;
  await updateStatus({
    projectId: options.config.projectId,
    itemId: found.itemId,
    fieldId: options.config.statusFieldId,
    optionId: options.config.statusOptions[options.targetStatus],
  });

  const shouldClose = options.targetStatus === "done";
  const updateState = options.updateIssueState ?? defaultUpdateIssueState;
  let issueStateChanged = false;
  try {
    await updateState({ repo: found.repo, number: options.number, state: shouldClose ? "closed" : "open" });
    issueStateChanged = true;
  } catch (error) {
    if (!(error instanceof TransitionPlanError)) {
      throw error;
    }
  }

  let bodyUpdated = false;
  if (!options.skipHistoryAppend) {
    const read = options.readIssueBody ?? defaultReadIssueBody;
    const currentBody = await read({ repo: found.repo, number: options.number });
    const newBody = appendHistoryEntry(currentBody, sourceStatus, options.targetStatus);
    const write = options.updateIssueBody ?? defaultUpdateIssueBody;
    await write({ repo: found.repo, number: options.number, body: newBody });
    bodyUpdated = true;
  }

  return {
    itemId: found.itemId,
    number: options.number,
    sourceStatus,
    targetStatus: options.targetStatus,
    bodyUpdated,
    issueStateChanged,
    issueClosed: shouldClose,
  };
}

function buildFindItemQuery(): string {
  return `
    query($projectId: ID!, $after: String) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 100, after: $after) {
            nodes {
              id
              fieldValueByName(name: "Status") {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  optionId
                }
              }
              content {
                ... on Issue {
                  number
                  repository { nameWithOwner }
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

async function defaultFindPlanItem(params: {
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
    found = candidates.find(
      (node) => node.content!.repository.nameWithOwner === params.repo,
    );
    if (!found) {
      throw new TransitionPlanError(
        `Plan #${params.number} not found in repo '${params.repo}'. Available repos: ${[...new Set(candidates.map((c) => c.content!.repository.nameWithOwner))].join(", ")}.`,
      );
    }
  } else if (candidates.length === 1) {
    found = candidates[0];
  } else {
    const repos = [
      ...new Set(candidates.map((c) => c.content!.repository.nameWithOwner)),
    ];
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
    throw new TransitionPlanError(
      `Plan #${params.number} has no Status value in the Project.`,
    );
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

async function defaultUpdateItemStatus(params: {
  projectId: string;
  itemId: string;
  fieldId: string;
  optionId: string;
}): Promise<void> {
  const mutation = `
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { singleSelectOptionId: $optionId }
      }) {
        projectV2Item { id }
      }
    }
  `;

  const args = [
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: project_v2",
    "-f",
    `query=${mutation}`,
    "-f",
    `projectId=${params.projectId}`,
    "-f",
    `itemId=${params.itemId}`,
    "-f",
    `fieldId=${params.fieldId}`,
    "-f",
    `optionId=${params.optionId}`,
  ];

  try {
    await runCommand("gh", args);
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new TransitionPlanError(error.message);
    }
    throw error;
  }
}

async function defaultUpdateIssueState(params: {
  repo: string;
  number: number;
  state: "open" | "closed";
}): Promise<void> {
  const action = params.state === "closed" ? "close" : "reopen";
  try {
    await runCommand("gh", [
      "issue",
      action,
      String(params.number),
      "--repo",
      params.repo,
    ]);
  } catch (error) {
    if (error instanceof GitCommandError) {
      throw new TransitionPlanError(error.message);
    }
    throw error;
  }
}

async function defaultReadIssueBody(params: {
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

async function defaultUpdateIssueBody(params: {
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

export function formatTransitionResult(result: TransitionPlanResult): string {
  const lines = [
    "Plan status transitioned.",
    `number: #${result.number}`,
    `status: ${result.sourceStatus} -> ${result.targetStatus}`,
    `item: ${result.itemId}`,
    `history: ${result.bodyUpdated ? "appended" : "skipped"}`,
    `issue: ${result.issueStateChanged ? (result.issueClosed ? "closed" : "reopened") : "unchanged"}`,
  ];
  return lines.join("\n");
}

export type TransitionPlanCliOptions = {
  number?: number;
  targetStatus?: PlanStatus;
  repo?: string;
  configPath?: string;
  help?: boolean;
};

export function parseTransitionPlanCli(
  argv: readonly string[],
): TransitionPlanCliOptions {
  const options: TransitionPlanCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new TransitionPlanError("--config requires a path.");
      }
      options.configPath = value;
      index += 1;
      continue;
    }

    if (arg === "--repo") {
      const value = argv[index + 1];
      if (!value) {
        throw new TransitionPlanError("--repo requires an owner/repo value.");
      }
      options.repo = value;
      index += 1;
      continue;
    }

    if (options.number === undefined) {
      const parsed = Number.parseInt(arg, 10);
      if (Number.isNaN(parsed) || String(parsed) !== arg) {
        throw new TransitionPlanError(
          `First argument must be an issue number, got '${arg}'.`,
        );
      }
      options.number = parsed;
      continue;
    }

    if (options.targetStatus === undefined) {
      assertPlanStatus(arg);
      options.targetStatus = arg;
      continue;
    }

    throw new TransitionPlanError(`Unknown argument: ${arg}`);
  }

  return options;
}

export function usage(): string {
  return [
    "Usage: bun <mt-plan-skill-dir>/transition-plan.ts <number> <target-status> [--repo <owner/repo>] [--config <path>]",
    "",
    "Transitions a plan (Issue) to the target status by updating the Project Status field,",
    "syncing the Issue open/closed state, and appending an entry to '## 🐢 履歴'.",
    "",
    "If multiple Issues in the Project share the same number across repos,",
    "use --repo <owner/repo> to disambiguate.",
    "",
    `Supported statuses: ${PLAN_STATUSES.join(", ")}`,
  ].join("\n");
}

if (require.main === module) {
  void (async () => {
    try {
      const options = parseTransitionPlanCli(process.argv.slice(2));
      if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
      }
      if (options.number === undefined || options.targetStatus === undefined) {
        process.stderr.write(`${usage()}\n`);
        process.exitCode = 1;
        return;
      }
      const config = loadConfig(options.configPath);
      const result = await transitionPlan({
        config,
        number: options.number,
        targetStatus: options.targetStatus,
        repo: options.repo,
      });
      process.stdout.write(`${formatTransitionResult(result)}\n`);
    } catch (error) {
      if (error instanceof InitConfigError || error instanceof TransitionPlanError) {
        process.stderr.write(`${error.message}\n`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`${message}\n`);
      }
      process.exitCode = 1;
    }
  })();
}
