import { describe, test, expect } from "bun:test";
import { difitStderrReasons } from "./difit-stderr-reasons.ts";

describe("selection_drift / stderr の解析 (Rust 出力契約)", () => {
  test("difitStderrReasons は空 stderr を落とし、非空行を理由行へ整形する", () => {
    expect(difitStderrReasons("")).toEqual([]);
    expect(difitStderrReasons("  \n\n")).toEqual([]);
    expect(difitStderrReasons("warn: drift\n\nerror: identity\n")).toEqual([
      "mt difit stderr: warn: drift",
      "mt difit stderr: error: identity",
    ]);
  });
});
