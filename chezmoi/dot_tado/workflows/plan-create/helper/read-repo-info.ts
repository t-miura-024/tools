import type { ArtifactRecord } from "tado";
import { findArtifactText } from "tado/artifacts";
import { isRecord } from "../../shared/review-helpers/is-record";
import type { RepoInfo } from "../types.ts";

const REPO_INFO_KEY = "repo-info.json";

export function readRepoInfo(artifacts: ArtifactRecord[], sessionDir: string): RepoInfo {
  const raw = findArtifactText(artifacts, REPO_INFO_KEY, sessionDir);
  if (!raw) throw new Error(`Artifact not found: ${REPO_INFO_KEY}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${REPO_INFO_KEY} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`${REPO_INFO_KEY} must be a JSON object with owner/repo/nameWithOwner`);
  }
  const { owner, repo, nameWithOwner } = parsed;
  if (
    typeof owner !== "string" ||
    owner.length === 0 ||
    typeof repo !== "string" ||
    repo.length === 0 ||
    typeof nameWithOwner !== "string" ||
    nameWithOwner.length === 0
  ) {
    throw new Error(`${REPO_INFO_KEY} must contain non-empty string owner/repo/nameWithOwner`);
  }
  const validName = /^[\w.-]+$/;
  if (!validName.test(owner) || !validName.test(repo)) {
    throw new Error(`${REPO_INFO_KEY}: owner/repo が不正です: "${nameWithOwner}"`);
  }
  if (nameWithOwner !== `${owner}/${repo}`) {
    throw new Error(
      `${REPO_INFO_KEY}: nameWithOwner "${nameWithOwner}" が owner/repo と一致しません`,
    );
  }
  return { owner, repo, nameWithOwner };
}
