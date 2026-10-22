import { describe, it, expect } from "bun:test";
import {
  extractMarkdownSection,
  hasFindingDecision,
  parseRawReviewFindings,
  validatePlanReviewFindings,
} from "./review-findings.ts";
import { renderReviewBody } from "./render-review-body.ts";

describe("review-findings helpers", () => {
  it("extractMarkdownSection は R1 と R10 を混同しない", () => {
    const text = [
      "## レビュー R1",
      "- 決定: adopt",
      "",
      "## レビュー R10",
      "- 決定: reject",
      "",
    ].join("\n");
    expect(extractMarkdownSection(text, "レビュー R1")).toContain("adopt");
    expect(extractMarkdownSection(text, "レビュー R1")).not.toContain("reject");
    expect(extractMarkdownSection(text, "レビュー R10")).toContain("reject");
  });

  it("hasFindingDecision は R1-F1 と R1-F10 を混同しない", () => {
    const section = [
      "### R1-F1: 問題1",
      "- 決定: adopt",
      "- 内容: 対応1",
      "",
      "### R1-F10: 問題10",
      "- 決定: reject",
      "- 内容: 対応しない",
    ].join("\n");
    expect(hasFindingDecision(section, "R1-F1")).toBe(true);
    expect(hasFindingDecision(section, "R1-F10")).toBe(true);
    expect(hasFindingDecision(section, "R1-F2")).toBe(false);
  });

  it("hasFindingDecision は決定行と内容行の両方を要求する", () => {
    expect(hasFindingDecision("### R1-F1: 問題\n- 決定: adopt", "R1-F1")).toBe(false);
    expect(hasFindingDecision("### R1-F1: 問題\n- 内容: 対応", "R1-F1")).toBe(false);
    expect(hasFindingDecision("### R1-F1: 問題\n- 決定: ok\n- 内容: 対応", "R1-F1")).toBe(false);
  });

  it("validatePlanReviewFindings は counts 不一致を拒否する", () => {
    const raw = JSON.stringify({
      reviewer: "mt-plan-reviewer",
      round: 1,
      cycleRound: 1,
      reviewedTargets: ["issue-body.md"],
      findings: [
        {
          id: "R1-F1",
          severity: "must",
          perspective: "A",
          type: "decision",
          target: "issue-body.md#§完了条件",
          evidence: "根拠",
          problem: "問題",
          proposedQuestion: "質問",
          proposedOptions: [],
          proposedFix: null,
        },
      ],
      counts: { must: 0, should: 1, want: 0 },
    });
    const result = validatePlanReviewFindings(raw);
    expect(result.valid).toBe(false);
    expect(result.error ?? "").toContain("counts");
  });

  it("parseRawReviewFindings はコードフェンスを剥がす", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        reviewedTargets: ["issue-body.md"],
        findings: [],
      }) +
      "\n```";
    const result = parseRawReviewFindings(raw);
    expect(result.valid).toBe(true);
    expect(result.parsed?.findings).toEqual([]);
  });

  it("parseRawReviewFindings は decision の proposedQuestion 欠落を拒否する", () => {
    const raw = JSON.stringify({
      reviewedTargets: ["issue-body.md"],
      findings: [
        {
          severity: "must",
          perspective: "A",
          type: "decision",
          target: "issue-body.md#§完了条件",
          evidence: "根拠",
          problem: "問題",
        },
      ],
    });
    const result = parseRawReviewFindings(raw);
    expect(result.valid).toBe(false);
    expect(result.error ?? "").toContain("proposedQuestion");
  });

  it("renderReviewBody は must/should の件数と対象一覧を出す", () => {
    const text = renderReviewBody({
      reviewer: "mt-plan-reviewer",
      round: 1,
      cycleRound: 1,
      reviewedTargets: ["issue-body.md", "issue-body-1.md"],
      findings: [
        {
          id: "R1-F1",
          severity: "must",
          perspective: "B",
          type: "decision",
          target: "issue-body.md#§完了条件",
          evidence: "根拠",
          problem: "問題",
          proposedQuestion: "質問",
          proposedOptions: ["A", "B", "C"],
          proposedFix: null,
        },
      ],
      counts: { must: 1, should: 0, want: 0 },
    });
    expect(text).toContain("must 1 / should 0 / want 0");
    expect(text).toContain("🚨 must");
    expect(text).toContain("issue-body-1.md");
  });
});
