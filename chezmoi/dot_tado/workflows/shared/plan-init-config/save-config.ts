import * as fs from "node:fs";
import * as path from "node:path";
import type { MtPlanConfig } from "./types";
import { defaultConfigPath } from "./default-config-path";
import { serializeConfig } from "./serialize-config";

export function saveConfig(config: MtPlanConfig, configPath: string = defaultConfigPath()): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, serializeConfig(config), "utf8");
}
