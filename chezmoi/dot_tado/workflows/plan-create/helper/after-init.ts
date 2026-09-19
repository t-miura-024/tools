import type { InitCtx } from "tado";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import type { RepoInfo } from "../types.ts";

const REPO_INFO_KEY = "repo-info.json";

export async function afterInit(
  ctx: InitCtx,
): Promise<{ artifacts: { key: string; path: string }[] }> {
  let stdout: string;
  try {
    stdout = execSync("gh repo view --json nameWithOwner --jq .nameWithOwner", {
      encoding: "utf-8",
    }).trim();
  } catch (error) {
    throw new Error(
      `gh repo view failed: ${error instanceof Error ? error.message : String(error)}. gh auth login と git リポジトリを確認してください。`,
    );
  }
  if (!stdout || !stdout.includes("/")) {
    throw new Error(`gh repo view の出力が不正です: "${stdout}"`);
  }
  const parts = stdout.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`gh repo view の出力が不正です: "${stdout}"`);
  }
  const [owner, repo] = parts;
  const validName = /^[\w.-]+$/;
  if (!validName.test(owner) || !validName.test(repo)) {
    throw new Error(`repo名が不正です: "${stdout}"`);
  }
  const repoInfo: RepoInfo = { owner, repo, nameWithOwner: stdout };
  const repoInfoPath = join(ctx.sessionDir, REPO_INFO_KEY);
  writeFileSync(repoInfoPath, JSON.stringify(repoInfo, null, 2), "utf-8");
  return { artifacts: [{ key: REPO_INFO_KEY, path: repoInfoPath }] };
}
