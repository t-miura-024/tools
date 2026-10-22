import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ConditionCtx } from "tado";
import { reviewFixExhaustedStep } from "./01.05-review-fix-exhausted.ts";
import type { PlanReviewFindings } from "../../helper/review-findings.ts";
import { REVIEW_FINDINGS_KEY } from "../../helper/review-limits.ts";

function makeFindings(overrides: { must: number; cycleRound: number }): PlanReviewFindings {
  const findings = Array.from({ length: overrides.must }, (_, index) => ({
    id: `R1-F${index + 1}`,
    severity: "must" as const,
    perspective: "A" as const,
    type: "decision" as const,
    target: "issue-body.md#§完了条件",
    evidence: "根拠",
    problem: "問題",
    proposedQuestion: "質問",
    proposedOptions: [],
    proposedFix: null,
  }));
  return {
    reviewer: "mt-plan-reviewer",
    round: 1,
    cycleRound: overrides.cycleRound,
    reviewedTargets: ["issue-body.md"],
    findings,
    counts: { must: overrides.must, should: 0, want: 0 },
  };
}

describe("01.05-review-fix-exhausted", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-fix-exhausted-"));
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  function makeCtx(): ConditionCtx {
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      artifacts: [],
    };
  }

  it("must>0 かつ cycleRound が上限なら true", () => {
    fs.writeFileSync(
      path.join(sessionDir, REVIEW_FINDINGS_KEY),
      JSON.stringify(makeFindings({ must: 1, cycleRound: 3 })),
    );
    expect(reviewFixExhaustedStep.condition!(makeCtx())).toBe(true);
  });

  it("must=0 なら false", () => {
    fs.writeFileSync(
      path.join(sessionDir, REVIEW_FINDINGS_KEY),
      JSON.stringify(makeFindings({ must: 0, cycleRound: 3 })),
    );
    expect(reviewFixExhaustedStep.condition!(makeCtx())).toBe(false);
  });

  it("cycleRound が上限未満なら false", () => {
    fs.writeFileSync(
      path.join(sessionDir, REVIEW_FINDINGS_KEY),
      JSON.stringify(makeFindings({ must: 1, cycleRound: 2 })),
    );
    expect(reviewFixExhaustedStep.condition!(makeCtx())).toBe(false);
  });

  it("findings が不正なら throw する（fail-closed）", () => {
    fs.writeFileSync(path.join(sessionDir, REVIEW_FINDINGS_KEY), "not-json");
    expect(() => reviewFixExhaustedStep.condition!(makeCtx())).toThrow();
  });

  it("選択肢は retry / abort のみで must 残存の承認を持たない", () => {
    const question = reviewFixExhaustedStep.humanGate.questions[0];
    expect(question.key).toBe("decision");
    expect((question.choices ?? []).map((choice) => choice.value)).toEqual(["retry", "abort"]);
  });
});
