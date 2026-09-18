export function usage(): string {
  return [
    "Usage: bun <mt-plan-skill-dir>/init-config.ts --owner <owner> --project <number> [--config <path>]",
    "",
    "Initializes ~/.config/mt-plan/config.json from the GitHub Project's Status field.",
    "Reads project metadata via 'gh project field-list' using the existing 'gh' CLI auth.",
    "",
    "Options:",
    "  --owner <owner>      GitHub owner (user or org) of the Project (required)",
    "  --project <number>   Project number (required)",
    "  --config <path>      Override config file path (default: ~/.config/mt-plan/config.json)",
    "  --help, -h           Show this usage",
  ].join("\n");
}
