import { describe, test, expect } from "bun:test";
import { describeDifitSelectionDrift } from "./describe-difit-selection-drift.ts";

describe("selection_drift / stderr の解析 (Rust 出力契約)", () => {
  test("describeDifitSelectionDrift: detected はセレクタ復旧、unavailable は検知不能の復旧手順を返す", () => {
    const detected = describeDifitSelectionDrift({
      detection: "detected",
      expected: { base: "a", target: "b" },
      current: { base: "c", target: "d" },
    });
    expect(detected).toContain("リビジョンセレクタ");
    expect(detected).toContain("起動時の選択");

    const unavailable = describeDifitSelectionDrift({
      detection: "unavailable",
      expected: { base: "a", target: "b" },
    });
    expect(unavailable).toContain("検知不能");
    expect(unavailable).toContain("probe 失敗");
    expect(unavailable).toContain("mt difit start <base-branch>");
  });

  // Rust の DriftDetection 三値と TS パーサーの受理集合を突合する
  // （スキーマ変更・enum 追加時に TS 側の追従漏れを検知する）。
});
