import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export class CollectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectError";
  }
}

type RunResult = { stdout: string; stderr: string };

export async function runCommand(
  command: string,
  args: string[],
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      reject(new CollectError(`${command} ${args.join(" ")}: ${err.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new CollectError(
          `${command} ${args.join(" ")} exited with ${code}: ${stderr.trim()}`,
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function detectBaseBranch(): Promise<string> {
  for (const branch of ["main", "master"]) {
    try {
      const result = await runCommand("git", ["rev-parse", "--verify", `origin/${branch}`]);
      if (result.stdout.trim()) {
        return branch;
      }
    } catch {
      // continue
    }
  }
  return "main";
}

async function getMergeBase(baseBranch: string): Promise<string> {
  try {
    const result = await runCommand("git", ["merge-base", `origin/${baseBranch}`, "HEAD"]);
    return result.stdout.trim();
  } catch {
    // fallback: use origin/base...HEAD directly
    return "";
  }
}

async function collectIssueBody(
  planNumber: number,
  repo?: string,
): Promise<string> {
  const args = ["issue", "view", String(planNumber), "--json", "body"];
  if (repo) { args.push("--repo", repo); }
  const result = await runCommand("gh", args);
  const parsed = JSON.parse(result.stdout) as { body: string };
  return parsed.body ?? "";
}

async function collectGitBranchDiff(baseBranch: string): Promise<string> {
  try {
    const mergeBase = await getMergeBase(baseBranch);
    const revRange = mergeBase
      ? `${mergeBase}..HEAD`
      : `origin/${baseBranch}..HEAD`;
    const result = await runCommand("git", ["diff", revRange]);
    return result.stdout;
  } catch {
    return "";
  }
}

async function collectGitUnstagedDiff(): Promise<string> {
  try {
    const result = await runCommand("git", ["diff"]);
    return result.stdout;
  } catch {
    return "";
  }
}

export interface CollectInput {
  planNumber: number;
  sessionDir: string;
  repo?: string;
  baseBranch?: string;
}

export interface CollectResult {
  issueBodyPath: string;
  branchDiffPath: string;
  unstagedDiffPath: string;
}

export async function collectReviewContext(
  input: CollectInput,
): Promise<CollectResult> {
  await mkdir(input.sessionDir, { recursive: true });

  const baseBranch = input.baseBranch ?? (await detectBaseBranch());

  const [issueBody, branchDiff, unstagedDiff] = await Promise.all([
    collectIssueBody(input.planNumber, input.repo).catch((err) => {
      throw new CollectError(`Failed to collect issue body: ${err.message}`);
    }),
    collectGitBranchDiff(baseBranch).catch((err) => {
      throw new CollectError(`Failed to collect branch diff: ${err.message}`);
    }),
    collectGitUnstagedDiff().catch((err) => {
      throw new CollectError(`Failed to collect unstaged diff: ${err.message}`);
    }),
  ]);

  const issueBodyPath = join(input.sessionDir, "issue-body.md");
  const branchDiffPath = join(input.sessionDir, "git-branch-diff.txt");
  const unstagedDiffPath = join(input.sessionDir, "git-unstaged-diff.txt");

  await Promise.all([
    writeFile(issueBodyPath, issueBody, "utf-8"),
    writeFile(branchDiffPath, branchDiff || "(no branch diff)", "utf-8"),
    writeFile(unstagedDiffPath, unstagedDiff || "(no unstaged changes)", "utf-8"),
  ]);

  return { issueBodyPath, branchDiffPath, unstagedDiffPath };
}

function formatResult(result: CollectResult): string {
  return [
    `Collected review context:`,
    `  issue-body: ${result.issueBodyPath}`,
    `  branch-diff: ${result.branchDiffPath}`,
    `  unstaged-diff: ${result.unstagedDiffPath}`,
  ].join("\n");
}

export function parseCli(argv: readonly string[]): {
  planNumber: number;
  sessionDir: string;
  repo?: string;
  baseBranch?: string;
  help?: boolean;
} {
  const result = {
    planNumber: 0,
    sessionDir: "",
    repo: undefined as string | undefined,
    baseBranch: undefined as string | undefined,
    help: false as boolean,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
    } else if (arg === "--plan-number") {
      const val = argv[++i];
      if (!val) throw new CollectError("--plan-number requires a value");
      result.planNumber = Number(val);
      i++;
    } else if (arg === "--session-dir") {
      const val = argv[++i];
      if (!val) throw new CollectError("--session-dir requires a value");
      result.sessionDir = val;
      i++;
    } else if (arg === "--repo") {
      const val = argv[++i];
      if (!val) throw new CollectError("--repo requires a value");
      result.repo = val;
      i++;
    } else if (arg === "--base-branch") {
      const val = argv[++i];
      if (!val) throw new CollectError("--base-branch requires a value");
      result.baseBranch = val;
      i++;
    } else {
      i++;
    }
  }

  return result;
}

export function usage(): string {
  return [
    "Usage: collect-review-context --plan-number <n> --session-dir <dir> [--repo <owner/repo>] [--base-branch <branch>]",
    "",
    "Collects review context (issue body, branch diff, unstaged diff) and writes to session-dir.",
    "Used by mt-run-plan's review_work step before delegating to the reviewer SubAgent.",
  ].join("\n");
}

if (require.main === module) {
  void (async () => {
    try {
      const opts = parseCli(process.argv.slice(2));
      if (opts.help || !opts.planNumber || !opts.sessionDir) {
        process.stdout.write(`${usage()}\n`);
        if (!opts.help && (!opts.planNumber || !opts.sessionDir)) {
          process.exitCode = 1;
        }
        return;
      }
      const result = await collectReviewContext({
        planNumber: opts.planNumber,
        sessionDir: opts.sessionDir,
        repo: opts.repo,
        baseBranch: opts.baseBranch,
      });
      process.stdout.write(`${formatResult(result)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  })();
}
