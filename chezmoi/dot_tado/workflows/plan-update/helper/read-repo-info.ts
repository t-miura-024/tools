import type { ArtifactRecord } from "tado";
import { findArtifactText } from "tado/artifacts";
import type { RepoInfo } from "../types.ts";

// afterInit で生成される repo-info.json を消費する際に使用。
// 各 check で repoInfo の整合性を検証するために呼び出す。
export function readRepoInfo(artifacts: ArtifactRecord[], sessionDir: string): RepoInfo {
  const raw = findArtifactText(artifacts, "repo-info.json", sessionDir);
  if (!raw) throw new Error("Artifact not found: repo-info.json");
  return JSON.parse(raw) as RepoInfo;
}
