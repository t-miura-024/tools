import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PLAN_STATUSES = [
  "draft",
  "refined",
  "in-progress",
  "done",
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export type StatusOptionMap = Record<PlanStatus, string>;

export type MtPlanConfig = {
  owner: string;
  projectNumber: number;
  projectId: string;
  statusFieldId: string;
  statusOptions: StatusOptionMap;
};

export class InitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitConfigError";
  }
}

export type ProjectV2SingleSelectField = {
  id: string;
  name: string;
  options: Array<{ id: string; name: string }>;
};

export type ProjectV2Field = {
  id: string;
  name: string;
  dataType?: string;
  options?: Array<{ id: string; name: string }>;
};

export type ProjectV2Owner = {
  __typename: "User" | "Organization";
  login: string;
};

export type ProjectV2 = {
  id: string;
  number: number;
  title: string;
  owner: ProjectV2Owner;
  fields: { nodes: ProjectV2Field[] };
};

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".config", "mt-plan", "config.json");
}

export type InitConfigOptions = {
  owner: string;
  projectNumber: number;
  statusFieldName?: string;
  configPath?: string;
  fetchProject?: (owner: string, projectNumber: number) => Promise<ProjectV2>;
  runCommand?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
};

export type InitConfigResultFull = {
  config: MtPlanConfig;
  configPath: string;
  project: ProjectV2;
};

async function defaultFetchProject(
  owner: string,
  projectNumber: number,
): Promise<ProjectV2> {
  const { fetchProject } = await import("./init-config-gh");
  return fetchProject(owner, projectNumber);
}

export async function initConfig(
  options: InitConfigOptions,
): Promise<InitConfigResultFull> {
  const fetch = options.fetchProject ?? defaultFetchProject;
  const project = await fetch(options.owner, options.projectNumber);
  const config = buildConfig(project, {
    statusFieldName: options.statusFieldName,
  });
  const configPath = options.configPath ?? defaultConfigPath();
  saveConfig(config, configPath);
  return { config, configPath, project };
}

export function findStatusField(
  fields: readonly ProjectV2Field[],
  fieldName = "Status",
): ProjectV2SingleSelectField | null {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    return null;
  }

  if (!field.options || field.options.length === 0) {
    return null;
  }

  return {
    id: field.id,
    name: field.name,
    options: field.options,
  };
}

export function buildStatusOptionMap(
  statusField: ProjectV2SingleSelectField,
): StatusOptionMap {
  const map = {} as StatusOptionMap;
  const missing: PlanStatus[] = [];

  for (const status of PLAN_STATUSES) {
    const option = statusField.options.find((candidate) => candidate.name === status);
    if (!option) {
      missing.push(status);
      continue;
    }
    map[status] = option.id;
  }

  if (missing.length > 0) {
    throw new InitConfigError(
      `Status field '${statusField.name}' is missing required options: ${missing.join(", ")}. ` +
        `Found options: ${statusField.options.map((option) => option.name).join(", ")}.`,
    );
  }

  return map;
}

export function buildConfig(
  project: ProjectV2,
  options: { statusFieldName?: string } = {},
): MtPlanConfig {
  const statusField = findStatusField(
    project.fields.nodes,
    options.statusFieldName ?? "Status",
  );

  if (!statusField) {
    throw new InitConfigError(
      `Project ${project.owner.login}/${project.number} does not have a 'Status' single select field. ` +
        `Add it via the Project UI first, then re-run init.`,
    );
  }

  return {
    owner: project.owner.login,
    projectNumber: project.number,
    projectId: project.id,
    statusFieldId: statusField.id,
    statusOptions: buildStatusOptionMap(statusField),
  };
}

export function serializeConfig(config: MtPlanConfig): string {
  return JSON.stringify(config, null, 2) + "\n";
}

export function parseConfig(input: string): MtPlanConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InitConfigError(`Failed to parse config JSON: ${message}`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new InitConfigError("Config must be a JSON object.");
  }

  const obj = parsed as Record<string, unknown>;
  const required = [
    "owner",
    "projectNumber",
    "projectId",
    "statusFieldId",
    "statusOptions",
  ];
  for (const key of required) {
    if (!(key in obj)) {
      throw new InitConfigError(`Config is missing required field: ${key}`);
    }
  }

  if (typeof obj.owner !== "string") {
    throw new InitConfigError("Config field 'owner' must be a string.");
  }
  if (typeof obj.projectNumber !== "number") {
    throw new InitConfigError("Config field 'projectNumber' must be a number.");
  }
  if (typeof obj.projectId !== "string") {
    throw new InitConfigError("Config field 'projectId' must be a string.");
  }
  if (typeof obj.statusFieldId !== "string") {
    throw new InitConfigError("Config field 'statusFieldId' must be a string.");
  }
  if (!obj.statusOptions || typeof obj.statusOptions !== "object") {
    throw new InitConfigError("Config field 'statusOptions' must be an object.");
  }

  const options = obj.statusOptions as Record<string, unknown>;
  for (const status of PLAN_STATUSES) {
    if (typeof options[status] !== "string") {
      throw new InitConfigError(
        `Config field 'statusOptions.${status}' must be a string.`,
      );
    }
  }

  return {
    owner: obj.owner,
    projectNumber: obj.projectNumber,
    projectId: obj.projectId,
    statusFieldId: obj.statusFieldId,
    statusOptions: {
      draft: options.draft,
      refined: options.refined,
      "in-progress": options["in-progress"],
      done: options.done,
    },
  };
}

export function loadConfig(configPath: string = defaultConfigPath()): MtPlanConfig {
  if (!fs.existsSync(configPath)) {
    throw new InitConfigError(
      `Config file does not exist: ${configPath}. Run 'mt-plan init' first.`,
    );
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return parseConfig(raw);
}

export function saveConfig(
  config: MtPlanConfig,
  configPath: string = defaultConfigPath(),
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, serializeConfig(config), "utf8");
}

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

export type InitConfigCliOptions = {
  owner?: string;
  projectNumber?: number;
  configPath?: string;
  help?: boolean;
};

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

export function formatInitConfigResult(
  config: MtPlanConfig,
  configPath: string,
): string {
  return [
    "mt-plan config initialized.",
    `config: ${configPath}`,
    `owner: ${config.owner}`,
    `project: ${config.projectNumber} (${config.projectId})`,
    `statusField: ${config.statusFieldId}`,
    "status options:",
    ...PLAN_STATUSES.map(
      (status) => `  - ${status}: ${config.statusOptions[status]}`,
    ),
  ].join("\n");
}

if (require.main === module) {
  void (async () => {
    try {
      const options = parseInitConfigCli(process.argv.slice(2));
      if (options.help) {
        process.stdout.write(`${usage()}\n`);
        return;
      }
      if (!options.owner || options.projectNumber === undefined) {
        process.stderr.write(
          "Both --owner and --project are required.\n\n" + usage() + "\n",
        );
        process.exitCode = 1;
        return;
      }
      const result = await initConfig({
        owner: options.owner,
        projectNumber: options.projectNumber,
        configPath: options.configPath,
      });
      process.stdout.write(
        `${formatInitConfigResult(result.config, result.configPath)}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  })();
}
