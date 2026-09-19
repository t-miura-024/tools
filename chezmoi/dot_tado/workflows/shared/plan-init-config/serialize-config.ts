import type { MtPlanConfig } from "./types";

export function serializeConfig(config: MtPlanConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}
