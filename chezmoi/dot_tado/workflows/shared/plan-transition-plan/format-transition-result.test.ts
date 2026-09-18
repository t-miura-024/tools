import { describe, it, expect } from "bun:test";
import { formatTransitionResult } from "./format-transition-result";

describe("formatTransitionResult", () => {
  it("result の主要フィールドを表示する", () => {
    const result = {
      itemId: "PVTI_abc",
      number: 7,
      sourceStatus: "refined" as const,
      targetStatus: "in-progress" as const,
      bodyUpdated: true,
      issueStateChanged: true,
      issueClosed: false,
    };
    const output = formatTransitionResult(result);

    expect(output).toContain("number: #7");
    expect(output).toContain("status: refined -> in-progress");
    expect(output).toContain("item: PVTI_abc");
    expect(output).toContain("history: appended");
    expect(output).toContain("issue: reopened");
  });

  it("done への遷移は issue: closed と表示", () => {
    const result = {
      itemId: "PVTI_abc",
      number: 7,
      sourceStatus: "in-progress" as const,
      targetStatus: "done" as const,
      bodyUpdated: true,
      issueStateChanged: true,
      issueClosed: true,
    };
    const output = formatTransitionResult(result);

    expect(output).toContain("issue: closed");
  });
});
