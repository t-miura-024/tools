import { describe, test, expect } from "bun:test";
import { requireDifitSelectionDrift } from "./require-difit-selection-drift.ts";

describe("requireDifitSelectionDrift (fail-closed の契約判定)", () => {
  test("解釈できた drift はそのまま返す", () => {
    const drift = { detection: "none" as const };
    expect(requireDifitSelectionDrift({ selection_drift: drift })).toEqual({ drift });
  });

  test("フィールド欠落は契約違反（ドリフトなしに倒さない）", () => {
    const result = requireDifitSelectionDrift({});
    expect("violation" in result).toBe(true);
    expect("violation" in result ? result.violation : "").toContain("契約違反");
    expect("violation" in result ? result.violation : "").toContain("selection_drift");
  });

  test("解釈不能（selection_drift_error）は理由つきの契約違反で返す", () => {
    const result = requireDifitSelectionDrift({
      selection_drift_error: "selection_drift.detection が未知の値です: drifted",
    });
    expect("violation" in result).toBe(true);
    expect("violation" in result ? result.violation : "").toContain("解釈できません");
    expect("violation" in result ? result.violation : "").toContain("drifted");
  });
});
