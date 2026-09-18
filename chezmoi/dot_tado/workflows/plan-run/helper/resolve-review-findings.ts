import type { ArtifactRecord } from "tado";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateFindingsJson } from "../../shared/review-helpers/validate-findings-json";
import { FINDINGS_KEY as REVIEW_FINDINGS_KEY } from "../../shared/review-helpers/findings-key";
import type { FindingsJson } from "../../shared/review-helpers/types";

/// findings.json を artifacts → セッションファイルの順で解決し、検証済みの値だけ返す。
export function resolveReviewFindings(ctx: {
  sessionDir: string;
  artifacts: ArtifactRecord[];
}): FindingsJson | undefined {
  const findingsRaw =
    findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
  const findings = validateFindingsJson(findingsRaw);
  return findings.valid ? findings.parsed : undefined;
}
