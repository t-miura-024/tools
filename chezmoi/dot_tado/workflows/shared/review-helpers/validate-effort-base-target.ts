import { isValidGitRefName } from "./is-valid-git-ref-name.ts";

export function validateEffortBaseTarget(base?: unknown, target?: unknown): string | undefined {
  if (base !== undefined) {
    if (typeof base !== "string" || !base.trim()) return "base must be non-empty string if present";
    if (!isValidGitRefName(base.trim())) return `invalid base: ${base}`;
  }
  if (target !== undefined) {
    if (typeof target !== "string" || !target.trim())
      return "target must be non-empty string if present";
    if (!isValidGitRefName(target.trim())) return `invalid target: ${target}`;
  }
  return undefined;
}
