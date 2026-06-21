import * as fs from "node:fs";
import * as path from "node:path";
import { GOAL_STATUSES, type GoalStatus } from "./transition-goal";

export type ListedGoal = {
  status: GoalStatus;
  path: string;
  absolutePath: string;
};

export type CheckedGoalDirectory = {
  status: GoalStatus;
  dir: string;
  exists: boolean;
};

export type ListGoalsResult = {
  root: string;
  statuses: readonly GoalStatus[];
  directories: CheckedGoalDirectory[];
  goals: ListedGoal[];
};

export class ListGoalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListGoalsError";
  }
}

function isGoalStatus(value: string): value is GoalStatus {
  return GOAL_STATUSES.includes(value as GoalStatus);
}

function parseGoalStatus(value: string): GoalStatus {
  if (!isGoalStatus(value)) {
    throw new ListGoalsError(
      `Unsupported status: ${value}. Supported statuses: ${GOAL_STATUSES.join(
        ", ",
      )}`,
    );
  }

  return value;
}

export function listGoals(options: {
  cwd?: string;
  statuses?: readonly GoalStatus[];
} = {}): ListGoalsResult {
  const root = path.resolve(options.cwd ?? process.cwd());
  const statuses = options.statuses ?? GOAL_STATUSES;
  const directories: CheckedGoalDirectory[] = [];
  const goals: ListedGoal[] = [];

  for (const status of statuses) {
    const dir = path.join(root, "tmp", "mt-goal", "docs", status);
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
      goals.push({
        status,
        absolutePath,
        path: path.relative(root, absolutePath),
      });
    }
  }

  return { root, statuses, directories, goals };
}

export function formatListGoalsResult(result: ListGoalsResult): string {
  const lines = [
    `root: ${result.root}`,
    `statuses: ${result.statuses.join(", ")}`,
  ];

  if (result.goals.length > 0) {
    lines.push("goals:");
    result.goals.forEach((goal, index) => {
      lines.push(`${index + 1}. [${goal.status}] ${goal.path}`);
    });
    return lines.join("\n");
  }

  lines.push("goals: none");
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
    "Usage: bun <mt-goal-skill-dir>/list-goals.ts [--cwd <project-root>] [statuses...]",
    "",
    `Supported statuses: ${GOAL_STATUSES.join(", ")}`,
    "If no statuses are provided, all statuses are listed.",
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)): string {
  if (argv.includes("--help") || argv.includes("-h")) {
    return usage();
  }

  let cwd: string | undefined;
  const statuses: GoalStatus[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new ListGoalsError("--cwd requires a project root path.");
      }

      cwd = value;
      index += 1;
      continue;
    }

    statuses.push(parseGoalStatus(arg));
  }

  return formatListGoalsResult(
    listGoals({ cwd, statuses: statuses.length > 0 ? statuses : undefined }),
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
