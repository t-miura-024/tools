import { describe, test, expect } from "bun:test";
import { validateVerifyFixJson } from "./validate-verify-fix-json.ts";

describe("validateVerifyFixJson (verify_fix 報告の検証)", () => {
  test("initial は valid", () => {
    const result = validateVerifyFixJson(JSON.stringify({ status: "initial" }));
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ status: "initial" });
  });

  test("verified は diffChanged と非空 regressionTests が必要", () => {
    const result = validateVerifyFixJson(
      JSON.stringify({
        status: "verified",
        diffChanged: true,
        regressionTests: ["src/a.test.ts"],
      }),
    );
    expect(result.valid).toBe(true);
  });

  test.each([
    ["未作成", undefined],
    ["不正 JSON", "{not-json"],
    ["status 不正", JSON.stringify({ status: "done" })],
    [
      "diffChanged 欠落",
      JSON.stringify({ status: "verified", regressionTests: ["src/a.test.ts"] }),
    ],
    [
      "regressionTests 空",
      JSON.stringify({ status: "verified", diffChanged: true, regressionTests: [] }),
    ],
    [
      "regressionTests 非文字列",
      JSON.stringify({ status: "verified", diffChanged: true, regressionTests: [42] }),
    ],
    ["unfixed 理由欠落", JSON.stringify({ status: "unfixed", reason: "  " })],
  ])("不正な報告は invalid（%s）", (_label, raw) => {
    expect(validateVerifyFixJson(raw as string | undefined).valid).toBe(false);
  });

  test("unfixed は非空 reason で valid", () => {
    const result = validateVerifyFixJson(JSON.stringify({ status: "unfixed", reason: "差分不変" }));
    expect(result.valid).toBe(true);
    expect(result.parsed).toEqual({ status: "unfixed", reason: "差分不変" });
  });
});
