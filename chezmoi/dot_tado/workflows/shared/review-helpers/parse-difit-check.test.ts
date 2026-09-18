import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseDifitCheck } from "./parse-difit-check.ts";

describe("selection_drift / stderr の解析 (Rust 出力契約)", () => {
  /// `mt difit check` / `threads --json` の stdout 契約として drift を解釈する。
  const parseDrift = (selectionDrift: unknown) =>
    parseDifitCheck(
      JSON.stringify({ passes: true, blocking_threads: [], selection_drift: selectionDrift }),
    );
  test("Rust の selection_drift 契約（detection / expected / current）を三値で取り込む", () => {
    expect(
      parseDrift({
        detection: "detected",
        expected: { base: "a", target: "b", baseMode: "merge-base" },
        current: { base: "c", target: "d" },
      })!.selection_drift,
    ).toEqual({
      detection: "detected",
      expected: { base: "a", target: "b", baseMode: "merge-base" },
      current: { base: "c", target: "d" },
    });
    expect(
      parseDrift({
        detection: "none",
        expected: { base: "a", target: "b" },
        current: { base: "a", target: "b" },
      })!.selection_drift,
    ).toEqual({
      detection: "none",
      expected: { base: "a", target: "b" },
      current: { base: "a", target: "b" },
    });
    // probe 失敗時は current が null（検知不能）。drift 情報は expected のみ保持する
    expect(
      parseDrift({
        detection: "unavailable",
        expected: { base: "a", target: "b" },
        current: null,
      })!.selection_drift,
    ).toEqual({ detection: "unavailable", expected: { base: "a", target: "b" } });
  });
});
describe("selection_drift / stderr の解析 (Rust 出力契約)", () => {
  /// `mt difit check` / `threads --json` の stdout 契約として drift を解釈する。
  const parseDrift = (selectionDrift: unknown) =>
    parseDifitCheck(
      JSON.stringify({ passes: true, blocking_threads: [], selection_drift: selectionDrift }),
    );
  test("旧形式（boolean / {detected}）や未知の detection は selection_drift_error に理由を記録する", () => {
    expect(parseDrift(true)!.selection_drift).toBeUndefined();
    expect(parseDrift(true)!.selection_drift_error).toContain("オブジェクト");
    expect(parseDrift({ detected: true })!.selection_drift).toBeUndefined();
    expect(parseDrift({ detected: true })!.selection_drift_error).toContain("detection");
    expect(parseDrift({ detection: "drifted" })!.selection_drift).toBeUndefined();
    expect(parseDrift({ detection: "drifted" })!.selection_drift_error).toContain("drifted");
    // フィールド欠落（done など drift を省く経路）は error マーカーを立てない
    expect(
      parseDifitCheck('{"passes":true,"blocking_threads":[]}')!.selection_drift,
    ).toBeUndefined();
    expect(
      parseDifitCheck('{"passes":true,"blocking_threads":[]}')!.selection_drift_error,
    ).toBeUndefined();
  });
});
describe("selection_drift / stderr の解析 (Rust 出力契約)", () => {
  /// `mt difit check` / `threads --json` の stdout 契約として drift を解釈する。
  const parseDrift = (selectionDrift: unknown) =>
    parseDifitCheck(
      JSON.stringify({ passes: true, blocking_threads: [], selection_drift: selectionDrift }),
    );
  test("Rust の DriftDetection 三値と TS パーサーの受理集合が一致する", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../../..");
    const checkRs = readFileSync(path.join(repoRoot, "src/difit/check.rs"), "utf-8");
    const enumBody = /enum DriftDetection \{([\s\S]*?)\n\}/.exec(checkRs)?.[1];
    expect(enumBody).toBeDefined();
    const variants = (enumBody ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Za-z0-9]*,$/.test(line))
      .map((line) => line.slice(0, -1).toLowerCase())
      .sort();
    expect(variants).toEqual(["detected", "none", "unavailable"]);

    // serde の lowercase 変換が前提（rename_all = "lowercase"）
    const enumIndex = checkRs.indexOf("enum DriftDetection");
    expect(checkRs.slice(Math.max(0, enumIndex - 300), enumIndex)).toContain(
      'rename_all = "lowercase"',
    );

    // 全バリアントを TS パーサーが受理し、未知値は error マーカー（fail-closed）
    for (const detection of variants) {
      expect(
        parseDrift({ detection, expected: { base: "a", target: "b" } })!.selection_drift,
      ).toEqual(expect.objectContaining({ detection }));
    }
    expect(parseDrift({ detection: "unknown" })!.selection_drift).toBeUndefined();
    expect(parseDrift({ detection: "unknown" })!.selection_drift_error).toContain("unknown");
  });

  // README に記載された threads --json の出力例（wire 形状）をパーサーがそのまま受理する
});
describe("selection_drift / stderr の解析 (Rust 出力契約)", () => {
  /// `mt difit check` / `threads --json` の stdout 契約として drift を解釈する。
  const parseDrift = (selectionDrift: unknown) =>
    parseDifitCheck(
      JSON.stringify({ passes: true, blocking_threads: [], selection_drift: selectionDrift }),
    );
  test("src/README.md の selection_drift 出力例をそのまま解釈できる", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../../..");
    const readme = readFileSync(path.join(repoRoot, "src/README.md"), "utf-8");
    const blocks = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    const driftBlock = blocks.find((block) => block.includes('"selection_drift"'));
    expect(driftBlock).toBeDefined();
    const parsed = JSON.parse(driftBlock!) as { selection_drift?: unknown };
    expect(parseDrift(parsed.selection_drift)!.selection_drift).toEqual({
      detection: "detected",
      expected: { base: "abc1234", target: "def5678", baseMode: "merge-base" },
      current: { base: "9999999", target: "def5678" },
    });
  });
});
