import type { ArtifactRecord } from "tado";

/** 申告レコードは retry で累積するため、同一キーの最後（最新）の申告を正とする。 */
export function lastArtifactRecord(
  artifacts: ArtifactRecord[],
  key: string,
): ArtifactRecord | undefined {
  let found: ArtifactRecord | undefined;
  for (const record of artifacts) {
    if (record.artifactKey === key) found = record;
  }
  return found;
}
