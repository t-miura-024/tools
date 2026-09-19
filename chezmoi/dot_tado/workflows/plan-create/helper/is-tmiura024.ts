import type { ArtifactRecord } from "tado";
import { readRepoInfo } from "./read-repo-info.ts";

export function isTMiura024(artifacts: ArtifactRecord[], sessionDir: string): boolean {
  return readRepoInfo(artifacts, sessionDir).owner === "t-miura-024";
}
