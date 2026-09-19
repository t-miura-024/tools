import * as fs from "node:fs";
import type { MtPlanConfig } from "./types";
import { InitConfigError } from "./init-config-error";
import { defaultConfigPath } from "./default-config-path";
import { parseConfig } from "./parse-config";

export function loadConfig(configPath: string = defaultConfigPath()): MtPlanConfig {
  if (!fs.existsSync(configPath)) {
    throw new InitConfigError(
      `Config file does not exist: ${configPath}. Run 'mt-plan init' first.`,
    );
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return parseConfig(raw);
}
