import type { ArtifactRecord } from "tado";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateVerdictJson } from "../../shared/review-helpers/validate-verdict-json";
import { VERDICT_KEY as REVIEW_VERDICT_KEY } from "../../shared/review-helpers/verdict-key";
import type { VerdictJson } from "../../shared/review-helpers/types";

/// verdict.json を artifacts → セッションファイルの順で解決し、検証済みの値だけ返す。
export function resolveReviewVerdict(ctx: {
  sessionDir: string;
  artifacts: ArtifactRecord[];
}): VerdictJson | undefined {
  const verdictRaw =
    findArtifactText(ctx.artifacts, REVIEW_VERDICT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, REVIEW_VERDICT_KEY);
  const verdict = validateVerdictJson(verdictRaw);
  return verdict.valid ? verdict.parsed : undefined;
}
