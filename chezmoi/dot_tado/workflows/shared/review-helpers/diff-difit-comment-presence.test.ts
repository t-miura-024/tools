import { describe, test, expect } from "bun:test";
import { diffDifitCommentPresence } from "./diff-difit-comment-presence.ts";
import type { DifitThreadView } from "./types.ts";

describe("diffDifitCommentPresence", () => {
  function thread(overrides: Partial<DifitThreadView> = {}): DifitThreadView {
    return {
      id: "t1",
      filePath: "src/a.ts",
      position: { side: "new", line: 1 },
      taxonomy: "issue",
      blocking: true,
      body: "A",
      author: null,
      replies: [],
      ...overrides,
    };
  }

  function comment(body: string, line = 1): Record<string, unknown> {
    return { type: "thread", filePath: "src/a.ts", position: { side: "new", line }, body };
  }

  test("位置まで一致する注入は match", () => {
    const result = diffDifitCommentPresence([comment("A")], [thread()]);
    expect(result.match).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
  });

  test("body 一致でも position.line の差し替えは missing として検出する", () => {
    const result = diffDifitCommentPresence([comment("A", 5)], [thread()]);
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0]).toContain("src/a.ts:5");
  });

  test("body 一致でも position.side の差し替えは missing として検出する", () => {
    const result = diffDifitCommentPresence(
      [comment("A")],
      [thread({ position: { side: "old", line: 1 } })],
    );
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  test("同一 body 2 件の片方欠落は missing として検出する（multiset）", () => {
    const result = diffDifitCommentPresence([comment("A"), comment("A")], [thread()]);
    expect(result.match).toBe(false);
    expect(result.missing).toHaveLength(1);
  });

  test("サーバ側の余剰は許容し、キー生成不能なサーバ要素は無視する", () => {
    const result = diffDifitCommentPresence(
      [comment("A")],
      [
        thread(),
        thread({ body: "前ラウンドの未 resolve" }),
        thread({ position: null, body: "人間" }),
      ],
    );
    expect(result.match).toBe(true);
  });

  test("注入側のキー生成不能（position なし）は invalid として fail する", () => {
    const result = diffDifitCommentPresence(
      [{ type: "thread", filePath: "src/a.ts", body: "no position" }],
      [thread({ body: "no position" })],
    );
    expect(result.match).toBe(false);
    expect(result.invalid).toHaveLength(1);
  });
});
