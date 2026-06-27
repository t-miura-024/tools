import { spawn } from "node:child_process";
import {
  type ProjectV2,
  type ProjectV2Field,
  type ProjectV2Owner,
  InitConfigError,
} from "./init-config";

export class GitCommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(params: {
    command: string;
    args: readonly string[];
    exitCode: number | null;
    stderr: string;
    cause?: unknown;
  }) {
    super(
      `${params.command} ${params.args.join(" ")} exited with code ${params.exitCode}: ${params.stderr.trim()}`,
    );
    this.name = "GitCommandError";
    this.command = params.command;
    this.args = params.args;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
  }
}

export type RunCommandResult = {
  stdout: string;
  stderr: string;
};

export async function runCommand(
  command: string,
  args: string[],
): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(
        new GitCommandError({
          command,
          args,
          exitCode: null,
          stderr: stderr || error.message,
          cause: error,
        }),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new GitCommandError({
            command,
            args,
            exitCode: code,
            stderr,
          }),
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

type GhProjectViewResponse = {
  data?: {
    user?: { projectV2: RawProjectV2 | null } | null;
    organization?: { projectV2: RawProjectV2 | null } | null;
  };
  errors?: Array<{ message: string }>;
};

type RawProjectV2 = {
  id: string;
  number: number;
  title: string;
  owner: { __typename: "User" | "Organization"; login: string };
  fields: {
    nodes: Array<{
      __typename?: string;
      id: string;
      name: string;
      dataType?: string;
      options?: Array<{ id: string; name: string }> | null;
    }>;
  };
};

function projectV2UserQuery(): string {
  return `
    query($login: String!, $number: Int!) {
      user(login: $login) {
        projectV2(number: $number) {
          id
          number
          title
          owner { __typename ... on User { login } ... on Organization { login } }
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField { id name options { id name } }
              ... on ProjectV2IterationField { id name }
            }
          }
        }
      }
    }
  `;
}

function projectV2OrgQuery(): string {
  return `
    query($login: String!, $number: Int!) {
      organization(login: $login) {
        projectV2(number: $number) {
          id
          number
          title
          owner { __typename ... on User { login } ... on Organization { login } }
          fields(first: 50) {
            nodes {
              __typename
              ... on ProjectV2Field { id name dataType }
              ... on ProjectV2SingleSelectField { id name options { id name } }
              ... on ProjectV2IterationField { id name }
            }
          }
        }
      }
    }
  `;
}

export async function fetchProject(
  owner: string,
  projectNumber: number,
): Promise<ProjectV2> {
  const raw = await tryFetchUserProject(owner, projectNumber)
    .catch(() => null)
    ?? await tryFetchOrgProject(owner, projectNumber)
    ?? null;

  if (!raw) {
    throw new InitConfigError(
      `Project #${projectNumber} not found for user/org '${owner}'. ` +
        `Verify the project exists and the 'gh' CLI is authenticated with 'project' scope.`,
    );
  }

  return mapProject(raw);
}

async function tryFetchUserProject(
  owner: string,
  projectNumber: number,
): Promise<RawProjectV2> {
  const args = [
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: project_v2",
    "-f",
    `query=${projectV2UserQuery()}`,
    "-f",
    `login=${owner}`,
    "-F",
    `number=${projectNumber}`,
  ];

  const { stdout } = await runCommand("gh", args);
  const response = JSON.parse(stdout) as GhProjectViewResponse;

  if (response.errors && response.errors.length > 0) {
    const isUserNotFound = response.errors.some(
      (e) => /Could not resolve to a (User|Repository)/.test(e.message),
    );
    if (isUserNotFound) {
      throw new InitConfigError("not found");
    }
    throw new InitConfigError(
      `gh api graphql returned errors: ${response.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const raw = response.data?.user?.projectV2 ?? null;
  if (!raw) {
    throw new InitConfigError("not found");
  }
  return raw;
}

async function tryFetchOrgProject(
  owner: string,
  projectNumber: number,
): Promise<RawProjectV2> {
  const args = [
    "api",
    "graphql",
    "-H",
    "GraphQL-Features: project_v2",
    "-f",
    `query=${projectV2OrgQuery()}`,
    "-f",
    `login=${owner}`,
    "-F",
    `number=${projectNumber}`,
  ];

  const { stdout } = await runCommand("gh", args);
  const response = JSON.parse(stdout) as GhProjectViewResponse;

  if (response.errors && response.errors.length > 0) {
    const isOrgNotFound = response.errors.some(
      (e) => /Could not resolve to an Organization/.test(e.message),
    );
    if (isOrgNotFound) {
      throw new InitConfigError("not found");
    }
    throw new InitConfigError(
      `gh api graphql returned errors: ${response.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const raw = response.data?.organization?.projectV2 ?? null;
  if (!raw) {
    throw new InitConfigError("not found");
  }
  return raw;
}

function mapProject(raw: RawProjectV2): ProjectV2 {
  const fields: ProjectV2Field[] = raw.fields.nodes.map((node) => ({
    id: node.id,
    name: node.name,
    dataType: node.dataType,
    options: node.options ?? undefined,
  }));

  const owner: ProjectV2Owner = {
    __typename: raw.owner.__typename,
    login: raw.owner.login,
  };

  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    owner,
    fields: { nodes: fields },
  };
}
