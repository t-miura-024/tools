import * as os from "node:os";
import * as path from "node:path";

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "mt-plan", "config.json");
}
