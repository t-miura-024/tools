import { PLAN_STATUSES } from "../plan-init-config/plan-statuses";

export function usage(): string {
  return [
    "Usage: bun <mt-plan-skill-dir>/transition-plan.ts <number> <target-status> [--repo <owner/repo>] [--config <path>]",
    "",
    "Transitions a plan (Issue) to the target status by updating the Project Status field,",
    "syncing the Issue open/closed state, and appending an entry to '## 🐢 履歴'.",
    "",
    "If multiple Issues in the Project share the same number across repos,",
    "use --repo <owner/repo> to disambiguate.",
    "",
    `Supported statuses: ${PLAN_STATUSES.join(", ")}`,
  ].join("\n");
}
