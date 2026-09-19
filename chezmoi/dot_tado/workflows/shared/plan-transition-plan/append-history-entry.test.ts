import { describe, it, expect } from "bun:test";
import { appendHistoryEntry } from "./append-history-entry";

describe("appendHistoryEntry", () => {
  it("## 🐢 履歴 セクションがない場合は末尾に追加", () => {
    const body = "## 💭 背景\n\nこれはテストです。";
    const result = appendHistoryEntry(body, "draft", "refined");

    expect(result).toContain("## 🐢 履歴");
    expect(result).toContain("[refined] draft から遷移");
  });

  it("## 🐢 履歴 セクションがある場合はその直下に追記", () => {
    const body =
      "## 💭 背景\n\nこれはテストです。\n\n## 🐢 履歴\n\n- 2026-06-25 10:00 [refined] previous";
    const result = appendHistoryEntry(body, "refined", "in-progress");

    expect(result).toContain("## 🐢 履歴");
    expect(result).toContain("- 2026-06-25 10:00 [refined] previous");
    expect(result).toContain("[in-progress] refined から遷移");
  });

  it("## 🐢 履歴 セクションが空の場合はその直下に追記 (新セクションを作らない)", () => {
    const body = "## 💭 背景\n\nこれはテストです。\n\n## 🐢 履歴";
    const result = appendHistoryEntry(body, "draft", "refined");

    const matches = result.match(/## 🐢 履歴/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("[refined] draft から遷移");
  });

  it("## 🐢 履歴 ヘッダーのみで末尾にある場合もその直下に追記", () => {
    const body = "## 💭 背景\n\n## 🐢 履歴\n";
    const result = appendHistoryEntry(body, "draft", "refined");

    const matches = result.match(/## 🐢 履歴/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("[refined] draft から遷移");
  });

  it("## 🐢 履歴 が body 中盤にあって、後に別セクションがある場合も追記できる", () => {
    const body = [
      "## 💭 背景",
      "",
      "これはテストです。",
      "",
      "## 🐢 履歴",
      "",
      "- 2026-06-25 10:00 [refined] previous",
      "",
      "## 🦊 別セクション",
      "",
      "別のセクションの内容",
    ].join("\n");
    const result = appendHistoryEntry(body, "refined", "in-progress");

    const matches = result.match(/## 🐢 履歴/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("- 2026-06-25 10:00 [refined] previous");
    expect(result).toContain("[in-progress] refined から遷移");
    expect(result).toContain("## 🦊 別セクション");
    expect(result).toContain("別のセクションの内容");

    const historyIdx = result.indexOf("## 🐢 履歴");
    const otherIdx = result.indexOf("## 🦊 別セクション");
    expect(historyIdx).toBeLessThan(otherIdx);

    const newEntryIdx = result.indexOf("[in-progress] refined から遷移");
    const oldEntryIdx = result.indexOf("[refined] previous");
    expect(newEntryIdx).toBeLessThan(oldEntryIdx);
  });

  it("## 🐢 履歴 が body 中盤にあり、内容が空で、後に別セクションがある場合は追記できる", () => {
    const body = [
      "## 💭 背景",
      "",
      "これはテストです。",
      "",
      "## 🐢 履歴",
      "",
      "## 🦊 別セクション",
      "",
      "別のセクションの内容",
    ].join("\n");
    const result = appendHistoryEntry(body, "draft", "refined");

    const matches = result.match(/## 🐢 履歴/g);
    expect(matches?.length).toBe(1);
    expect(result).toContain("[refined] draft から遷移");
    expect(result).toContain("## 🦊 別セクション");
  });
  it("executionTransition=true で UUID マーカーが埋め込まれる", () => {
    const body = "## 🐢 履歴\n";
    const result = appendHistoryEntry(
      body,
      "refined",
      "in-progress",
      true,
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result).toContain("(mt-run-plan)");
    expect(result).toContain("<!-- mt-run-plan-marker: 550e8400-e29b-41d4-a716-446655440000 -->");
  });

  it("executionTransition=false でマーカーも (mt-run-plan) も付かない", () => {
    const body = "## 🐢 履歴\n";
    const result = appendHistoryEntry(body, "draft", "refined", false, null);
    expect(result).not.toContain("(mt-run-plan)");
    expect(result).not.toContain("mt-run-plan-marker");
  });

  it("executionTransition=true だが executionMarker が null ならマーカーなし", () => {
    const body = "## 🐢 履歴\n";
    const result = appendHistoryEntry(body, "refined", "in-progress", true, null);
    expect(result).toContain("(mt-run-plan)");
    expect(result).not.toContain("mt-run-plan-marker");
  });
});
