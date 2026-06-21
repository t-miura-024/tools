import * as fs from "node:fs";
import * as path from "node:path";

export const GOAL_STATUSES = ["draft", "refined", "done"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];

export type TransitionResult = {
  from: string;
  to: string;
  sourceStatus: GoalStatus;
  targetStatus: GoalStatus;
};

export class TransitionGoalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionGoalError";
  }
}

const ALLOWED_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  draft: ["refined"],
  refined: ["done"],
  done: ["refined"],
};

function isGoalStatus(value: string): value is GoalStatus {
  return GOAL_STATUSES.includes(value as GoalStatus);
}

function assertGoalStatus(value: string): asserts value is GoalStatus {
  if (!isGoalStatus(value)) {
    throw new TransitionGoalError(
      `Unsupported target status: ${value}. Supported statuses: ${GOAL_STATUSES.join(
        ", ",
      )}`,
    );
  }
}

export function resolveGoalPath(
  goalPath: string,
  cwd = process.cwd(),
): {
  absolutePath: string;
  goalRoot: string;
  sourceStatus: GoalStatus;
} {
  const absolutePath = path.resolve(cwd, goalPath);
  const segments = absolutePath.split(path.sep);
  let goalIndex = -1;

  for (let i = 0; i < segments.length - 3; i += 1) {
    if (
      segments[i] === "tmp" &&
      segments[i + 1] === "mt-goal" &&
      segments[i + 2] === "docs"
    ) {
      goalIndex = i;
    }
  }

  if (goalIndex === -1) {
    throw new TransitionGoalError(
      `Goal document must be under tmp/mt-goal/docs/[status]/: ${goalPath}`,
    );
  }

  if (segments.length !== goalIndex + 5) {
    throw new TransitionGoalError(
      `Goal document must be a direct child of tmp/mt-goal/docs/[status]/: ${goalPath}`,
    );
  }

  const sourceStatus = segments[goalIndex + 3];
  if (!isGoalStatus(sourceStatus)) {
    throw new TransitionGoalError(
      `Unsupported source status: ${sourceStatus}. Supported statuses: ${GOAL_STATUSES.join(
        ", ",
      )}`,
    );
  }

  return {
    absolutePath,
    goalRoot: segments.slice(0, goalIndex + 3).join(path.sep),
    sourceStatus,
  };
}

export function transitionGoal(
  goalPath: string,
  targetStatusInput: string,
  options: { cwd?: string } = {},
): TransitionResult {
  assertGoalStatus(targetStatusInput);

  const { absolutePath, goalRoot, sourceStatus } = resolveGoalPath(
    goalPath,
    options.cwd,
  );
  const targetStatus = targetStatusInput;

  if (!fs.existsSync(absolutePath)) {
    throw new TransitionGoalError(`Goal document does not exist: ${absolutePath}`);
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new TransitionGoalError(`Goal path is not a file: ${absolutePath}`);
  }

  if (sourceStatus === targetStatus) {
    throw new TransitionGoalError(
      `Goal is already in status '${targetStatus}': ${absolutePath}`,
    );
  }

  if (!ALLOWED_TRANSITIONS[sourceStatus].includes(targetStatus)) {
    throw new TransitionGoalError(
      `Transition '${sourceStatus}' -> '${targetStatus}' is not allowed.`,
    );
  }

  const targetDir = path.join(goalRoot, targetStatus);
  const targetPath = path.join(targetDir, path.basename(absolutePath));

  if (fs.existsSync(targetPath)) {
    throw new TransitionGoalError(
      `Destination goal document already exists: ${targetPath}`,
    );
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.renameSync(absolutePath, targetPath);

  return {
    from: absolutePath,
    to: targetPath,
    sourceStatus,
    targetStatus,
  };
}

export function formatTransitionResult(result: TransitionResult): string {
  return [
    "Goal document status transitioned.",
    `from: ${result.from}`,
    `to: ${result.to}`,
    `status: ${result.sourceStatus} -> ${result.targetStatus}`,
  ].join("\n");
}

export function usage(): string {
  return [
    "Usage: bun <mt-goal-skill-dir>/transition-goal.ts <goal-file> <target-status>",
    "",
    `Supported statuses: ${GOAL_STATUSES.join(", ")}`,
    "Allowed transitions: draft -> refined, refined -> done, done -> refined",
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)): string {
  if (argv.includes("--help") || argv.includes("-h")) {
    return usage();
  }

  if (argv.length !== 2) {
    throw new TransitionGoalError(usage());
  }

  const [goalPath, targetStatus] = argv;
  return formatTransitionResult(transitionGoal(goalPath, targetStatus));
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
