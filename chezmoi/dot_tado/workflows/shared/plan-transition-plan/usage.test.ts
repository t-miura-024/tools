import { describe, it, expect } from "bun:test";
import { usage } from "./usage";

describe("usage", () => {
  it("usage メッセージを返す", () => {
    const text = usage();
    expect(text).toContain("Usage:");
    expect(text).toContain("Supported statuses");
  });
});
