import type { ArtifactRecord } from "tado";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { parseDifitCheck } from "../../shared/review-helpers/parse-difit-check";
import { DIFIT_CHECK_KEY } from "../../shared/review-helpers/difit-check-key";
import type { FeedbackCoverageExpected } from "../types.ts";
import { KNOWN_STEP_KEYS, LOOP_OUTSIDE_GATE_KEYS } from "../types.ts";
import { resolveReviewFindings } from "./resolve-review-findings.ts";
import { resolveReviewVerdict } from "./resolve-review-verdict.ts";

export function buildFeedbackCoverageExpected(
  ctx: { sessionDir: string; artifacts: ArtifactRecord[] },
  requests: { gateKey: string; input: string | undefined }[],
): FeedbackCoverageExpected {
  const findings = resolveReviewFindings(ctx);
  const verdict = resolveReviewVerdict(ctx);
  const difit = (() => {
    const raw =
      findArtifactText(ctx.artifacts, DIFIT_CHECK_KEY, ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, DIFIT_CHECK_KEY);
    const parsed = parseDifitCheck(raw);
    if (!parsed) return { available: false, texts: [] as string[] };
    const texts: string[] = [];
    for (const thread of parsed.blocking_threads) {
      if (thread.body.trim() !== "") texts.push(thread.body);
      const replies = (thread as { replies?: unknown }).replies;
      if (Array.isArray(replies)) {
        for (const reply of replies) {
          if (typeof reply === "string" && reply.trim() !== "") texts.push(reply);
        }
      }
    }
    return { available: true, texts };
  })();
  return {
    gateInputs: requests
      .filter(
        (r) =>
          !(LOOP_OUTSIDE_GATE_KEYS as readonly string[]).includes(r.gateKey) &&
          r.input !== undefined &&
          r.input.trim() !== "",
      )
      .map((r) => ({ gateKey: r.gateKey, input: (r.input as string).trim() })),
    findingDetails: findings
      ? findings.findings.map((f, index) => ({
          index,
          severity: f.severity,
          detail: f.detail,
        }))
      : [],
    verdictTexts: verdict
      ? (() => {
          const out: string[] = [];
          for (const thread of verdict.blocking_threads) {
            if (thread.body.trim() !== "") out.push(thread.body);
            const replies = (thread as { replies?: unknown }).replies;
            if (Array.isArray(replies)) {
              for (const reply of replies) {
                if (typeof reply === "string" && reply.trim() !== "") out.push(reply);
              }
            }
          }
          return out;
        })()
      : [],
    difitTexts: difit.texts,
    knownStepKeys: new Set(KNOWN_STEP_KEYS),
    findingsAvailable: findings !== undefined,
    verdictAvailable: verdict !== undefined,
    difitAvailable: difit.available,
  };
}
