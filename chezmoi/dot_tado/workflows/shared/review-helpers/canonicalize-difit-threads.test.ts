import { describe, test, expect } from "bun:test";
import { canonicalizeDifitThreads } from "./canonicalize-difit-threads.ts";

describe("canonicalizeDifitThreads", () => {
  test("配列順が違っても同じ文字列になる", () => {
    const a = [
      { id: "t1", file: "src/a.ts", line: 1, taxonomy: "issue", body: "A", replies: [] },
      { id: "t2", file: "src/b.ts", line: 2, taxonomy: "human", body: "B", replies: ["r"] },
    ];
    const b = [a[1], a[0]];
    expect(canonicalizeDifitThreads(a)).toBe(canonicalizeDifitThreads(b));
  });

  test("body が改変されていれば異なる文字列になる", () => {
    const a = [{ id: "t1", body: "original", replies: [] }];
    const b = [{ id: "t1", body: "rewritten", replies: [] }];
    expect(canonicalizeDifitThreads(a)).not.toBe(canonicalizeDifitThreads(b));
  });

  test("replies の欠落は空配列として比較される", () => {
    const a = [{ id: "t1", body: "A", replies: [] as string[] }];
    const b = [{ id: "t1", body: "A" }];
    expect(canonicalizeDifitThreads(a)).toBe(canonicalizeDifitThreads(b));
  });
});
