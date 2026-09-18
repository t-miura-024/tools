import type { TransitionPlanCliOptions } from "./types";
import { assertPlanStatus } from "./types";
import { TransitionPlanError } from "./transition-plan-error";

export function parseTransitionPlanCli(argv: readonly string[]): TransitionPlanCliOptions {
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
        throw new TransitionPlanError(`First argument must be an issue number, got '${arg}'.`);
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
