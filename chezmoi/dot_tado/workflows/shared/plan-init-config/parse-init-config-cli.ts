import type { InitConfigCliOptions } from "./types";
import { InitConfigError } from "./init-config-error";

export function parseInitConfigCli(argv: readonly string[]): InitConfigCliOptions {
  const options: InitConfigCliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) {
        throw new InitConfigError("--config requires a path.");
      }
      options.configPath = value;
      index += 1;
      continue;
    }

    if (arg === "--owner") {
      const value = argv[index + 1];
      if (!value) {
        throw new InitConfigError("--owner requires a value.");
      }
      options.owner = value;
      index += 1;
      continue;
    }

    if (arg === "--project") {
      const value = argv[index + 1];
      if (!value) {
        throw new InitConfigError("--project requires a value.");
      }
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || String(parsed) !== value) {
        throw new InitConfigError(`--project must be a number, got '${value}'.`);
      }
      options.projectNumber = parsed;
      index += 1;
      continue;
    }

    throw new InitConfigError(`Unknown argument: ${arg}`);
  }

  return options;
}
