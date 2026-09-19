import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateFindingsJson } from "../../shared/review-helpers/validate-findings-json";
import { FINDINGS_KEY as REVIEW_FINDINGS_KEY } from "../../shared/review-helpers/findings-key";
import { REVIEW_ROUND_LIMIT } from "../../shared/review-helpers/review-round-limit";

/// must=0 または自律上限で通常の人間レビューへ渡す。
export function isHumanReviewPhase(ctx: {
  sessionDir: string;
  artifacts: import("tado").ArtifactRecord[];
}): boolean {
  const findingsRaw =
    findArtifactText(ctx.artifacts, REVIEW_FINDINGS_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_FINDINGS_KEY);
  const findingsResult = validateFindingsJson(findingsRaw);
  if (!findingsResult.valid || !findingsResult.parsed) return false;
  return (
    findingsResult.parsed.counts.must === 0 || findingsResult.parsed.round >= REVIEW_ROUND_LIMIT
  );
}
