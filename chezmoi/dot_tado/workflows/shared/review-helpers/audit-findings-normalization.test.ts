import { describe, test, expect } from "bun:test";
import { auditFindingsNormalization } from "./audit-findings-normalization.ts";
import { parseDiffChangedLines } from "./parse-diff-changed-lines.ts";
import { quoteGitPathForDiff } from "./quote-git-path-for-diff.ts";
import type { FindingsJson } from "./types.ts";

describe("auditFindingsNormalization", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,4 @@",
    " context",
    "+added1",
    "+added2",
    " tail",
  ].join("\n");

  function findingsJson(
    findings: Array<Record<string, unknown>>,
    filteredOut?: { count: number; items: Array<Record<string, unknown>> },
  ): FindingsJson {
    return {
      round: 1,
      width: "medium",
      depth: "medium",
      findings: findings as never,
      counts: { must: 0, should: 0, want: 0 },
      ...(filteredOut ? { filteredOut: filteredOut as never } : {}),
    };
  }

  function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      axis: "req-1",
      severity: "must",
      detail: "detail",
      filePath: "src/a.ts",
      position: { side: "new", line: 2 },
      ...overrides,
    };
  }

  test("raw と findings が機械導出で一致すれば match", () => {
    const raw = [finding()];
    const audit = auditFindingsNormalization(raw, diff, findingsJson(raw), { untrackedFiles: [] });
    expect(audit.match).toBe(true);
    expect(audit.reasons).toEqual([]);
  });

  test("集約段で must を落とした findings は欠落として fail（counts が自己整合でも検出）", () => {
    const raw = [finding()];
    const audit = auditFindingsNormalization(raw, diff, findingsJson([]), { untrackedFiles: [] });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("欠落 1 件");
    expect(audit.reasons.join("\n")).toContain("req-1 must src/a.ts 2");
  });

  test("diff フィルタで除外した finding は filteredOut への記録が必須", () => {
    const raw = [finding({ position: { side: "new", line: 99 } })];
    const withoutFiltered = auditFindingsNormalization(raw, diff, findingsJson([]), {
      untrackedFiles: [],
    });
    expect(withoutFiltered.match).toBe(false);
    expect(withoutFiltered.reasons.join("\n")).toContain("filteredOut");

    const withFiltered = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 1,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 99, reason: "line_not_in_added" }],
      }),
      { untrackedFiles: [] },
    );
    expect(withFiltered.match).toBe(true);

    // count と items 件数の不一致も検出する
    const countMismatch = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 2,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 99, reason: "line_not_in_added" }],
      }),
      { untrackedFiles: [] },
    );
    expect(countMismatch.match).toBe(false);
    expect(countMismatch.reasons.join("\n")).toContain("filteredOut.count");
  });

  test("axis / severity / detail 不正の例外除外は内訳に計上して match", () => {
    const raw = [finding({ axis: "unknown-axis" })];
    const audit = auditFindingsNormalization(raw, diff, findingsJson([]), { untrackedFiles: [] });
    expect(audit.match).toBe(true);
  });

  test("±2 行マージで統合された findings を受理する（軸/深刻度/位置の multiset 比較）", () => {
    const raw = [
      finding({ detail: "a" }),
      finding({
        axis: "req-2",
        severity: "should",
        detail: "b",
        position: { side: "new", line: 3 },
      }),
    ];
    const merged = [
      {
        axis: "req-1",
        severity: "must",
        detail: "a\n\n--- merged (±2) ---\n\nb",
        filePath: "src/a.ts",
        position: { side: "new", line: 2 },
      },
    ];
    expect(
      auditFindingsNormalization(raw, diff, findingsJson(merged), { untrackedFiles: [] }).match,
    ).toBe(true);

    // マージせず 2 件のまま残した findings は余剰として fail
    const notMerged = auditFindingsNormalization(raw, diff, findingsJson(raw), {
      untrackedFiles: [],
    });
    expect(notMerged.match).toBe(false);
    expect(notMerged.reasons.join("\n")).toContain("余剰 1 件");
  });

  test("reviewer-outputs.json が配列でなければ fail", () => {
    const audit = auditFindingsNormalization({ findings: [] }, diff, findingsJson([]), {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("JSON array");
  });

  test("解析済み Map を渡すと内部で再パースせず、その Map でフィルタする（二重パース回避）", () => {
    const raw = [finding()]; // src/a.ts:2 は diff の追加行
    // 空の Map を渡す: 内部パースが走っていれば kept になりこの findings では不一致になる。
    // 渡した Map が使われるなら file_not_in_diff として filteredOut へ落ちて match する。
    const withEmptyMap = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 1,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 2, reason: "file_not_in_diff" }],
      }),
      { changedLinesMap: new Map(), untrackedFiles: [] },
    );
    expect(withEmptyMap.match).toBe(true);

    // 解析済みの正しい Map では従来どおり kept として扱われる（内部パースと同一の判定）
    const parsed = parseDiffChangedLines(diff);
    expect(
      auditFindingsNormalization(raw, diff, findingsJson(raw), {
        changedLinesMap: parsed,
        untrackedFiles: [],
      }).match,
    ).toBe(true);
    expect(
      auditFindingsNormalization(raw, diff, findingsJson([]), { untrackedFiles: [] }).match,
    ).toBe(false);
  });

  test("diff.txt が無ければ機械照合できず fail", () => {
    const raw = [finding()];
    const audit = auditFindingsNormalization(raw, undefined, findingsJson(raw), {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("diff.txt");
  });

  test("filteredOut のスキーマ不正は TypeError にせず reasons に積んで fail する", () => {
    const raw = [finding({ position: { side: "new", line: 99 } })];

    // items: [null] は filteredKey が null アクセスで落ちる形（旧実装は TypeError）
    const nullItem = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], { count: 1, items: [null as never] }),
      { untrackedFiles: [] },
    );
    expect(nullItem.match).toBe(false);
    expect(nullItem.reasons.join("\n")).toContain("filteredOut.items[0]");
    expect(nullItem.reasons.join("\n")).toContain("オブジェクトではありません");

    // filteredOut 自体がオブジェクトでない
    const notObject = auditFindingsNormalization(
      raw,
      diff,
      {
        ...findingsJson([]),
        filteredOut: [1],
      } as unknown as FindingsJson,
      { untrackedFiles: [] },
    );
    expect(notObject.match).toBe(false);
    expect(notObject.reasons.join("\n")).toContain("filteredOut");

    // items が配列でない
    const notArray = auditFindingsNormalization(
      raw,
      diff,
      {
        ...findingsJson([]),
        filteredOut: { count: 1, items: "x" },
      } as unknown as FindingsJson,
      { untrackedFiles: [] },
    );
    expect(notArray.match).toBe(false);
    expect(notArray.reasons.join("\n")).toContain("items が配列ではありません");

    // reason が契約外・count が整数でない
    const badReason = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], {
        count: 1,
        items: [{ axis: "req-1", filePath: "src/a.ts", line: 99, reason: "tampered" }],
      }),
      { untrackedFiles: [] },
    );
    expect(badReason.match).toBe(false);
    expect(badReason.reasons.join("\n")).toContain("reason が不正");

    const badCount = auditFindingsNormalization(
      raw,
      diff,
      findingsJson([], { count: "1" as never, items: [null as never] }),
      { untrackedFiles: [] },
    );
    expect(badCount.match).toBe(false);
    expect(badCount.reasons.join("\n")).toContain("count が整数ではありません");
  });

  test("diff.txt に untracked の欠落があれば fail（打ち切られた差分を SoT にしない）", () => {
    const raw = [finding()];
    // untracked 一覧の 1 件が diff.txt に現れない = head 等による打ち切りを模す
    const audit = auditFindingsNormalization(raw, diff, findingsJson(raw), {
      untrackedFiles: ["src/a.ts", "src/missing.ts"],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("src/missing.ts");
    expect(audit.reasons.join("\n")).toContain("欠落");

    // 欠落が無ければ match
    expect(
      auditFindingsNormalization(raw, diff, findingsJson(raw), { untrackedFiles: ["src/a.ts"] })
        .match,
    ).toBe(true);
  });

  test("diff.txt の truncate マーカーは fail（表示用 truncate と SoT の混同検出）", () => {
    const raw = [finding()];
    const truncated = `${diff}\n[... truncated: 4999 lines omitted]\n`;
    const audit = auditFindingsNormalization(raw, truncated, findingsJson(raw), {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(false);
    expect(audit.reasons.join("\n")).toContain("truncate マーカー");

    // 差分内容に `+[... truncated...` として現れる場合はマーカーではない（行頭一致のみ）
    const contentLine = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -0,0 +1 @@
+[... truncated: 4999 lines omitted]`;
    const notMarker = auditFindingsNormalization(raw, contentLine, findingsJson([]), {
      untrackedFiles: ["src/a.ts"],
    });
    expect(notMarker.reasons.join("\n")).not.toContain("truncate マーカー");
  });
});
describe("diff.txt 完全性検証 (untracked 打ち切り・truncate マーカー)", () => {
  test("auditFindingsNormalization: C-quote パス上の指摘を file_not_in_diff で無音除外しない", () => {
    const quotedPath = quoteGitPathForDiff("docs/日本語.md");
    const diff = [
      `diff --git "a/${quotedPath}" "b/${quotedPath}"`,
      `+++ "b/${quotedPath}"`,
      "@@ -0,0 +1 @@",
      "+追加行",
    ].join("\n");
    const finding = {
      axis: "req-1",
      severity: "should",
      detail: "非 ASCII パスの指摘",
      filePath: "docs/日本語.md",
      position: { side: "new", line: 1 },
    };
    const findingsJsonValue: FindingsJson = {
      round: 1,
      width: "medium",
      depth: "medium",
      findings: [finding] as never,
      counts: { must: 0, should: 1, want: 0 },
    };
    const audit = auditFindingsNormalization([finding], diff, findingsJsonValue, {
      untrackedFiles: [],
    });
    expect(audit.match).toBe(true);
    expect(audit.reasons).toEqual([]);
  });
});
