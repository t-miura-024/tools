import { describe, test, expect } from "bun:test";
import { isolateDifitFeedback } from "./isolate-difit-feedback.ts";

describe("isolateDifitFeedback (difit 由来文面のフェンス隔離)", () => {
  test("行頭#を含む原文を維持したままコードフェンスで囲む", () => {
    const feedback = "## difit の人間フィードバック\n\n### 1. src/a.ts:1 (issue)";
    const isolated = isolateDifitFeedback(feedback);
    expect(isolated.startsWith("```markdown\n")).toBe(true);
    expect(isolated.endsWith("\n```")).toBe(true);
    expect(isolated).toContain(feedback);
  });

  test("``` を含む入力は4連フェンスで囲み早期終了を防ぐ", () => {
    const feedback = "例:\n```\ncode\n```";
    const isolated = isolateDifitFeedback(feedback);
    expect(isolated.startsWith("````markdown\n")).toBe(true);
    expect(isolated.endsWith("\n````")).toBe(true);
    expect(isolated).toContain(feedback);
  });
});
