import * as fs from "node:fs";
import * as path from "node:path";
import { PLAN_STATUSES, type PlanStatus } from "./transition-plan-legacy";

export type ListedPlan = {
  status: PlanStatus;
  path: string;
  absolutePath: string;
};

export type CheckedPlanDirectory = {
  status: PlanStatus;
  dir: string;
  exists: boolean;
};

export type ListPlansResult = {
  root: string;
  statuses: readonly PlanStatus[];
  directories: CheckedPlanDirectory[];
  plans: ListedPlan[];
};

export class ListPlansError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListPlansError";
  }
}

function isPlanStatus(value: string): value is PlanStatus {
  return PLAN_STATUSES.includes(value as PlanStatus);
}

function parsePlanStatus(value: string): PlanStatus {
  if (!isPlanStatus(value)) {
    throw new ListPlansError(
      `Unsupported status: ${value}. Supported statuses: ${PLAN_STATUSES.join(
        ", ",
      )}`,
    );
  }

  return value;
}

export function listPlans(options: {
  cwd?: string;
  statuses?: readonly PlanStatus[];
} = {}): ListPlansResult {
  const root = path.resolve(options.cwd ?? process.cwd());
  const statuses = options.statuses ?? PLAN_STATUSES;
  const directories: CheckedPlanDirectory[] = [];
  const plans: ListedPlan[] = [];

  for (const status of statuses) {
    const dir = path.join(root, "tmp", "plan", status);
    const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    directories.push({ status, dir, exists });

    if (!exists) {
      continue;
    }

    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      plans.push({
        status,
        absolutePath,
        path: path.relative(root, absolutePath),
      });
    }
  }

  return { root, statuses, directories, plans };
}

export function formatListPlansResult(result: ListPlansResult): string {
  const lines = [
    `root: ${result.root}`,
    `statuses: ${result.statuses.join(", ")}`,
  ];

  if (result.plans.length > 0) {
    lines.push("plans:");
    result.plans.forEach((plan, index) => {
      lines.push(`${index + 1}. [${plan.status}] ${plan.path}`);
    });
    return lines.join("\n");
  }

  lines.push("plans: none");
  lines.push("checked directories:");
  for (const directory of result.directories) {
    lines.push(
      `- [${directory.status}] ${directory.dir} (${
        directory.exists ? "exists" : "missing"
      })`,
    );
  }

  return lines.join("\n");
}

export function usage(): string {
  return [
    "Usage: bun <mt-plan-skill-dir>/list-plans.ts [--cwd <project-root>] [statuses...]",
    "",
    `Supported statuses: ${PLAN_STATUSES.join(", ")}`,
    "If no statuses are provided, all statuses are listed.",
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)): string {
  if (argv.includes("--help") || argv.includes("-h")) {
    return usage();
  }

  let cwd: string | undefined;
  const statuses: PlanStatus[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new ListPlansError("--cwd requires a project root path.");
      }

      cwd = value;
      index += 1;
      continue;
    }

    statuses.push(parsePlanStatus(arg));
  }

  return formatListPlansResult(
    listPlans({ cwd, statuses: statuses.length > 0 ? statuses : undefined }),
  );
}

if (require.main === module) {
  try {
    process.stdout.write(`${runCli()}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
