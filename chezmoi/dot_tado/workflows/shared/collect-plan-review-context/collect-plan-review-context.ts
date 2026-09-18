import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { StepCtx } from "tado";
import type { ArtifactInput } from "tado/types/artifact.ts";
import { cleanGitEnv } from "../review-helpers/clean-git-env";
import { execGit } from "../review-helpers/exec-git";
import { findArtifactText } from "tado/artifacts";
import { listUntrackedFiles } from "../review-helpers/list-untracked-files";
import { parseJson } from "../review-helpers/parse-json";
import { readSessionFile } from "tado/artifacts";
import { resolveEffectiveEffortBase } from "../review-helpers/resolve-effective-effort-base";
import { validateEffort } from "../review-helpers/validate-effort";
import { validateEffortBaseTarget } from "../review-helpers/validate-effort-base-target";
import { effortFromIssueBody } from "./effort-from-issue-body";
import { validateReviewDiff } from "./validate-review-diff";

/** stdout をファイルへ直接出力する git 実行（execGit の 16MiB maxBuffer を回避）。 */
function gitToFile(args: string[], outFd: number): void {
  execFileSync("git", args, {
    stdio: ["ignore", outFd, "pipe"],
    env: cleanGitEnv(),
  });
}

/** plan-run 専用の収集。index は変更せず、全検証成功後に成果物を更新する。 */
export async function collectPlanReviewContext(ctx: StepCtx): Promise<ArtifactInput[]> {
  const raw =
    findArtifactText(ctx.artifacts, "effort.json", ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, "effort.json");
  const effort =
    raw === undefined
      ? {
          ...effortFromIssueBody(
            findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir) ??
              readSessionFile(ctx.sessionDir, "issue-body.md"),
          ),
          round: 1,
        }
      : parseJson(raw);
  const validation = validateEffort(effort);
  if (validation.status !== "pass") throw new Error(validation.reasons.join("\n"));
  const value = effort as Record<string, unknown>;
  const base = resolveEffectiveEffortBase(value.base);
  const target = typeof value.target === "string" ? value.target.trim() : undefined;
  const refError = validateEffortBaseTarget(base, target);
  if (refError) throw new Error(refError);
  const revision = target ? `${base}...${target}` : execGit(["merge-base", "HEAD", base]).trim();
  if (!revision) throw new Error("git merge-base returned an empty revision");
  // diff は stdout バッファ（execGit の maxBuffer）を経由せず一時ファイルへ直接出力する。
  // 大きな差分でも全文を保持し、検証成功後に正式な diff.txt へ置換する。
  const workDir = mkdtempSync(join(ctx.sessionDir, ".collect-"));
  const diffPath = join(workDir, "diff.txt");
  try {
    const diffFd = openSync(diffPath, "w");
    try {
      gitToFile(["-c", "core.quotePath=false", "diff", revision], diffFd);
      if (!target) {
        const untracked = listUntrackedFiles();
        if ("error" in untracked) throw new Error(untracked.error);
        for (const file of untracked.files) {
          try {
            gitToFile(
              ["-c", "core.quotePath=false", "diff", "--no-index", "--", "/dev/null", file],
              diffFd,
            );
          } catch (error) {
            // git diff --no-index の 1 は差分あり。その他の失敗は伝播させる。
            if ((error as { status?: number }).status !== 1) throw error;
          }
        }
      }
    } finally {
      closeSync(diffFd);
    }
    validateReviewDiff(readFileSync(diffPath, "utf8"), { base, target });
    const context = `${execGit(["log", "--oneline", "-20"])}\n${execGit(["diff", "--stat"])}`;
    writeFileSync(join(workDir, "context.md"), context);
    writeFileSync(join(workDir, "effort.json"), `${JSON.stringify(effort, null, 2)}\n`);
    for (const key of ["context.md", "effort.json", "diff.txt"]) {
      renameSync(join(workDir, key), join(ctx.sessionDir, key));
    }
    return ["diff.txt", "effort.json"].map((key) => ({ key, path: join(ctx.sessionDir, key) }));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
