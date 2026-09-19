import type { ArtifactRecord } from "tado";
import { lastArtifactRecord } from "./last-artifact-record";

/** 申告された成果物のパス（正）を返す。plan_number のようにパス欄に値を格納するキーにも使う。 */
export function reportedArtifactPath(artifacts: ArtifactRecord[], key: string): string | undefined {
  return lastArtifactRecord(artifacts, key)?.filePath;
}
