import * as fs from "node:fs";
import * as path from "node:path";

export const PLAN_STATUSES = [
  "draft",
  "refined",
  "in-progress",
  "done",
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type TransitionResult = {
  from: string;
  to: string;
  sourceStatus: PlanStatus;
  targetStatus: PlanStatus;
};

export class TransitionPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransitionPlanError";
  }
}

const ALLOWED_TRANSITIONS: Record<PlanStatus, readonly PlanStatus[]> = {
  draft: ["refined"],
  refined: ["in-progress"],
  "in-progress": ["done"],
  done: ["in-progress"],
};

function isPlanStatus(value: string): value is PlanStatus {
  return PLAN_STATUSES.includes(value as PlanStatus);
}

function assertPlanStatus(value: string): asserts value is PlanStatus {
  if (!isPlanStatus(value)) {
    throw new TransitionPlanError(
      `Unsupported target status: ${value}. Supported statuses: ${PLAN_STATUSES.join(
        ", ",
      )}`,
    );
  }
}

export function resolvePlanPath(
  planPath: string,
  cwd = process.cwd(),
): {
  absolutePath: string;
  planRoot: string;
  sourceStatus: PlanStatus;
} {
  const absolutePath = path.resolve(cwd, planPath);
  const segments = absolutePath.split(path.sep);
  let planIndex = -1;

  for (let i = 0; i < segments.length - 2; i += 1) {
    if (segments[i] === "tmp" && segments[i + 1] === "plan") {
      planIndex = i;
    }
  }

  if (planIndex === -1) {
    throw new TransitionPlanError(
      `Plan file must be under tmp/plan/[status]/: ${planPath}`,
    );
  }

  if (segments.length !== planIndex + 4) {
    throw new TransitionPlanError(
      `Plan file must be a direct child of tmp/plan/[status]/: ${planPath}`,
    );
  }

  const sourceStatus = segments[planIndex + 2];
  if (!isPlanStatus(sourceStatus)) {
    throw new TransitionPlanError(
      `Unsupported source status: ${sourceStatus}. Supported statuses: ${PLAN_STATUSES.join(
        ", ",
      )}`,
    );
  }

  return {
    absolutePath,
    planRoot: segments.slice(0, planIndex + 2).join(path.sep),
    sourceStatus,
  };
}

export function transitionPlan(
  planPath: string,
  targetStatusInput: string,
  options: { cwd?: string } = {},
): TransitionResult {
  assertPlanStatus(targetStatusInput);

  const { absolutePath, planRoot, sourceStatus } = resolvePlanPath(
    planPath,
    options.cwd,
  );
  const targetStatus = targetStatusInput;

  if (!fs.existsSync(absolutePath)) {
    throw new TransitionPlanError(`Plan file does not exist: ${absolutePath}`);
  }

  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new TransitionPlanError(`Plan path is not a file: ${absolutePath}`);
  }

  if (sourceStatus === targetStatus) {
    throw new TransitionPlanError(
      `Plan is already in status '${targetStatus}': ${absolutePath}`,
    );
  }

  if (!ALLOWED_TRANSITIONS[sourceStatus].includes(targetStatus)) {
    throw new TransitionPlanError(
      `Transition '${sourceStatus}' -> '${targetStatus}' is not allowed.`,
    );
  }

  const targetDir = path.join(planRoot, targetStatus);
  const targetPath = path.join(targetDir, path.basename(absolutePath));

  if (fs.existsSync(targetPath)) {
    throw new TransitionPlanError(
      `Destination plan already exists: ${targetPath}`,
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
    "Plan status transitioned.",
    `from: ${result.from}`,
    `to: ${result.to}`,
    `status: ${result.sourceStatus} -> ${result.targetStatus}`,
  ].join("\n");
}

export function usage(): string {
  return [
    "Usage: bun <mt-plan-skill-dir>/transition-plan.ts <plan-file> <target-status>",
    "",
    `Supported statuses: ${PLAN_STATUSES.join(", ")}`,
    "Allowed transitions: draft -> refined, refined -> in-progress, in-progress -> done, done -> in-progress",
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)): string {
  if (argv.includes("--help") || argv.includes("-h")) {
    return usage();
  }

  if (argv.length !== 2) {
    throw new TransitionPlanError(usage());
  }

  const [planPath, targetStatus] = argv;
  return formatTransitionResult(transitionPlan(planPath, targetStatus));
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
