import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def from "./index.ts";
import {
  buildHunkComments,
  formatReviewComment as formatComment,
} from "../_shared/mt-review-helpers.ts";
import type { CheckCtx } from "tado";

const stepCheck = (key: string) => def.steps.find((s) => s.key === key)!.check;

describe("mt-plan-run workflow checks", () => {
  let tmp: string;
  let binDir: string;
  let sessionDir: string;
  let originalPath: string | undefined;
  let originalTadoHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-workflow-"));
    binDir = path.join(tmp, "bin");
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(binDir);
    fs.mkdirSync(sessionDir);
    // resetReviewCycle が実ユーザーの workflow.db を触らないよう隔離する
    originalTadoHome = process.env.TADO_HOME;
    process.env.TADO_HOME = path.join(tmp, "tado-home");
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    process.env.TADO_HOME = originalTadoHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeScript(name: string, body: string): void {
    const scriptPath = path.join(binDir, name);
    fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(scriptPath, 0o755);
  }

  /// `git rev-parse --show-toplevel` と `hunk session get --json` を制御する
  function fakeGitAndHunkSessionGet(sessionLive: boolean): void {
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${tmp}/repo" && exit 0
exit 1`,
    );
    writeScript(
      "hunk",
      sessionLive
        ? `echo '{"session":{"sessionId":"s1"}}'
exit 0`
        : `echo "no active hunk session" >&2
exit 1`,
    );
  }

  /// `mt hunk status` / `mt hunk check` を制御する
  function fakeMt(options: { statusOutput: string; checkJson?: string; checkExit?: number }): void {
    const lines = [
      `[ "$1" = "hunk" ] || exit 64`,
      `[ "$2" = "status" ] && printf '%s\\n' '${options.statusOutput}' && exit 0`,
    ];
    if (options.checkJson !== undefined) {
      lines.push(
        `[ "$2" = "check" ] && printf '%s\\n' '${options.checkJson}' && exit ${options.checkExit ?? 0}`,
      );
    }
    lines.push("exit 64");
    writeScript("mt", lines.join("\n"));
  }

  function makeCtx(overrides: Partial<CheckCtx> = {}): CheckCtx {
    return {
      sessionDir,
      attemptResult: { status: "completed" },
      artifacts: [],
      ...overrides,
    };
  }

  describe("ensure_hunk_session", () => {
    it("`hunk session get` 成功なら pass", () => {
      fakeGitAndHunkSessionGet(true);

      const result = stepCheck("ensure_hunk_session")(makeCtx());

      expect(result.status).toBe("pass");
    });

    it("`hunk session get` 失敗なら fail", () => {
      fakeGitAndHunkSessionGet(false);

      const result = stepCheck("ensure_hunk_session")(makeCtx());

      expect(result.status).toBe("fail");
    });
  });

  // 旧 start_hunk_review / await_review / check_hunk は Step import により
  // resolve_effort / collect_context / run_reviewers / publish_findings / await_human_review / collect_verdict に置換されたため削除
  // 新ワークフローの品質規律は mt-review-diff 側で純粋関数テストとして担保する
  describe("resolve_effort (human_gate 廃止 — Issue body コメント or medium/medium)", () => {
    it("human_gate を持たず task 型である", () => {
      const step = def.steps.find((s) => s.key === "resolve_effort")!;
      expect(step.type).toBe("task");
      expect((step as unknown as Record<string, unknown>).humanGate).toBeUndefined();
    });

    it("HTML コメントがあれば derived で pass", () => {
      fs.writeFileSync(
        path.join(sessionDir, "issue-body.md"),
        "# plan\n\n<!-- effort: width=high depth=low -->\n",
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("width=high depth=low");
    });

    it("コメントがなければ medium/medium 既定で pass", () => {
      fs.writeFileSync(path.join(sessionDir, "issue-body.md"), "# plan\n\n本文のみ\n");
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("medium/medium");
    });

    it("プロンプト記法 width=... は無視して medium/medium で pass", () => {
      fs.writeFileSync(path.join(sessionDir, "issue-body.md"), "# plan\n\nwidth=high depth=max\n");
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("medium/medium");
    });

    it("width: セクション記法は無視して medium/medium で pass", () => {
      fs.writeFileSync(
        path.join(sessionDir, "issue-body.md"),
        "# plan\n\nwidth: high\ndepth: max\n",
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("medium/medium");
    });

    it("片方欠落コメントは fail し create 修正を案内する", () => {
      fs.writeFileSync(
        path.join(sessionDir, "issue-body.md"),
        "# plan\n\n<!-- effort: width=medium -->\n",
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("mt-plan-create");
    });

    it("enum 外コメントは fail し create 修正を案内する", () => {
      fs.writeFileSync(
        path.join(sessionDir, "issue-body.md"),
        "# plan\n\n<!-- effort: width=super depth=medium -->\n",
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("mt-plan-create");
    });

    it("effort.json があればその検証に委譲する", () => {
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "high", depth: "low", round: 1 }),
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("pass");
    });
  });

  describe("publish_findings (Step import)", () => {
    it("valid findings.json があれば pass", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fakeMt({ statusOutput: "hunk review session: active" });
      const result = stepCheck("publish_findings")(makeCtx());
      expect(result.status).toBe("pass");
    });

    it("findings.json が不正なら error", () => {
      fs.writeFileSync(path.join(sessionDir, "findings.json"), "not json");
      fakeMt({ statusOutput: "hunk review session: active" });
      const result = stepCheck("publish_findings")(makeCtx());
      expect(result.status).toBe("error");
    });

    it("hunk-start.json が session:null なら fail", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "hunk-start.json"), '{"session":null}\n');
      fakeMt({ statusOutput: "hunk review session: active" });
      const result = stepCheck("publish_findings")(makeCtx());
      expect(result.status).toBe("fail");
    });
  });

  describe("await_human_review (Step import)", () => {
    // strict: none は fail — hunk セッション未起動の厳密検出
    it("hunk session none なら fail (strict)", () => {
      fakeMt({ statusOutput: "hunk review session: none" });
      const resultNone = stepCheck("await_human_review")(makeCtx());
      expect(resultNone.status).toBe("fail");
    });

    // 寛容: active は pass — tracer bullet で hunk が active なら即 pass
    it("hunk session active なら pass (tracer bullet 寛容)", () => {
      fakeMt({ statusOutput: "hunk review session: active" });
      const resultActive = stepCheck("await_human_review")(makeCtx());
      expect(resultActive.status).toBe("pass");
    });
  });

  describe("collect_verdict (Step import, round上限3)", () => {
    it("findings must=0 なら pass（合成）", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      const verdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      fakeMt({
        statusOutput: "hunk review session: active",
        checkJson: JSON.stringify({ passes: true, blocking_threads: [] }),
        checkExit: 0,
      });
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );
      expect(result.status).toBe("pass");
    });

    it("round 4 は limit exceeded で fail/error", () => {
      const findings = {
        round: 4,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      const verdict = {
        round: 4,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      fakeMt({
        statusOutput: "hunk review session: active",
        checkJson: JSON.stringify({ passes: true, blocking_threads: [] }),
        checkExit: 0,
      });
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );
      expect(["fail", "error"]).toContain(result.status);
      expect(result.reasons.join("\n")).toContain("round limit");
    });

    it("daemon が block なのに verdict が pass 偽装なら fail (daemon 偽装検出)", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      // verdict に passes を含めて daemon 照合を発火させる（validateVerdict は passed を見るが parseHunkCheck は passes を見る）
      const verdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        passes: true,
        blocking_threads: [],
      } as unknown as Record<string, unknown>;
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      const daemonGate = {
        passes: false,
        blocking_threads: [{ id: "n1", taxonomy: "issue", body: "[issue] real", replies: [] }],
      };
      fakeMt({
        statusOutput: "hunk review session: active",
        checkJson: JSON.stringify(daemonGate),
        checkExit: 1,
      });
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("does not match");
    });

    it("blocking_threads を改変した verdict は不一致 fail (daemon 偽装検出)", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      const daemonGate = {
        passes: false,
        blocking_threads: [{ id: "n1", taxonomy: "issue", body: "[issue] real", replies: [] }],
      };
      fakeMt({
        statusOutput: "hunk review session: active",
        checkJson: JSON.stringify(daemonGate),
        checkExit: 1,
      });
      const tampered = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: false,
        passes: false,
        blocking_threads: [{ id: "n1", taxonomy: "issue", body: "[issue] rewritten", replies: [] }],
      } as unknown as Record<string, unknown>;
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(tampered));
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(tampered) },
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("does not match");
    });
  });
});

describe("formatComment snapshots", () => {
  const axes = ["req-1", "req-2", "logic-1", "logic-2", "arch-1"] as const;
  const severities = ["must", "should", "want"] as const;
  const detail = "サンプルの詳細テキスト。レビュー指摘の内容がここに入ります。";

  for (const severity of severities) {
    for (const axis of axes) {
      for (const withLine of [true, false] as const) {
        const caseName = `${severity} · ${axis} · ${withLine ? "with line" : "without line"}`;
        it(caseName, () => {
          const result = formatComment({
            severity,
            axis,
            detail,
            filePath: "src/example.ts",
            line: withLine ? 42 : undefined,
          });
          expect(result).toMatchSnapshot();
          // summary は [] を含まず、絵文字と区切りを含む
          expect(result.summary).not.toContain("[");
          expect(result.summary).not.toContain("]");
          expect(result.summary).toContain(" | ");
          expect(result.summary).toContain(" — ");
          // markup は STML の box と summary の二重生成
          expect(result.markup).toContain("<box");
          expect(result.markup).toContain('title="');
        });
      }
    }
  }

  it("truncates long detail head in summary", () => {
    const longDetail = "a".repeat(100) + " 詳細続き";
    const result = formatComment({
      severity: "must",
      axis: "req-2",
      detail: longDetail,
      filePath: "src/long.ts",
      line: 10,
    });
    expect(result.summary).toContain("...");
    expect(result.markup).toContain("a".repeat(10));
  });

  it("escapes STML special chars in markup", () => {
    const result = formatComment({
      severity: "should",
      axis: "logic-1",
      detail: "if (a < b && c > d) { & check }",
      filePath: "src/escape.ts",
      line: 5,
    });
    expect(result.markup).toContain("&lt;");
    expect(result.markup).toContain("&gt;");
    expect(result.markup).toContain("&amp;");
    expect(result.summary).toContain("if (a < b");
  });

  it("renders suggestions as list when provided", () => {
    const result = formatComment({
      severity: "want",
      axis: "arch-1",
      detail: "改善提案あり",
      filePath: "src/with-suggest.ts",
      line: 7,
      suggestions: ["提案1: 変数名を明確化", "提案2: 関数を分割"],
    });
    expect(result.markup).toContain("<list>");
    expect(result.markup).toContain("<item>提案1");
    expect(result.markup).toContain("<item>提案2");
  });

  it("omits list when suggestions empty", () => {
    const result = formatComment({
      severity: "must",
      axis: "req-1",
      detail: "詳細のみ",
      filePath: "src/no-suggest.ts",
      line: 1,
    });
    expect(result.markup).not.toContain("<list>");
  });

  it("handles multiline detail with br", () => {
    const result = formatComment({
      severity: "should",
      axis: "logic-3",
      detail: "1行目\n2行目\n3行目",
      filePath: "src/multi.ts",
      line: 3,
    });
    expect(result.markup).toContain("<br/>");
    expect(result.summary).toContain("1行目");
    expect(result.summary).not.toContain("2行目");
  });

  it("handles general target when filePath missing", () => {
    const result = formatComment({
      severity: "must",
      axis: "logic-1",
      detail: "ファイルレベル指摘",
    });
    expect(result.summary).toContain("general");
    expect(result.markup).toContain("general");
  });
});

describe("buildHunkComments integration", () => {
  it("generates markup and summary for mixed axes with and without line", () => {
    // diff-only厳格化: filePath必須・position必須(side:new)のみがコメント化される
    const review = JSON.stringify({
      round: 1,
      width: "medium",
      depth: "medium",
      findings: [
        {
          axis: "req-1",
          severity: "must",
          detail: "essential must detail",
          filePath: "src/a.ts",
          position: { side: "new", line: 10 },
        },
        {
          axis: "req-1",
          severity: "should",
          detail: "essential should detail",
          filePath: "src/b.ts",
        },
        {
          axis: "req-2",
          severity: "want",
          detail: "acceptance want detail",
          filePath: "src/c.ts",
          position: { side: "old", line: 5 },
        },
        {
          axis: "logic-3",
          severity: "must",
          detail: "align must <escape> & test",
          filePath: "src/d.ts",
          position: { side: "new", line: 99 },
        },
        {
          axis: "arch-1",
          severity: "should",
          detail: "quality should detail\nsecond line",
          filePath: "src/e.ts",
        },
      ],
      counts: { must: 2, should: 2, want: 1 },
    });
    const comments = buildHunkComments(review);
    // filePathなし / old_side は除外され、new側のみが残る
    expect(comments).toHaveLength(2);
    for (const c of comments) {
      expect(c.summary).toBeDefined();
      expect(c.markup).toBeDefined();
      expect(c.summary as string).not.toContain("[");
      expect(c.markup as string).toContain("<box");
      expect(c.markup as string).toContain("border-color=");
      expect(c.filePath).toBeDefined();
      expect(c.newLine).toBeDefined();
      expect(c.oldLine).toBeUndefined();
    }
    const withLine = comments.find((c) => c.filePath === "src/a.ts");
    expect(withLine?.newLine).toBe(10);
    const withLine2 = comments.find((c) => c.filePath === "src/d.ts");
    expect(withLine2?.newLine).toBe(99);
    // filtered: b.ts / c.ts / e.ts は生成されない
    expect(comments.find((c) => c.filePath === "src/b.ts")).toBeUndefined();
    expect(comments.find((c) => c.filePath === "src/c.ts")).toBeUndefined();
    expect(comments.find((c) => c.filePath === "src/e.ts")).toBeUndefined();
    // snapshot for stability
    expect(comments).toMatchSnapshot();
  });

  it("ignores suggestion field gracefully when present", () => {
    const review = JSON.stringify({
      round: 1,
      width: "medium",
      depth: "medium",
      findings: [
        {
          axis: "req-1",
          severity: "must",
          detail: "detail with suggestion",
          filePath: "src/f.ts",
          position: { side: "new", line: 1 },
          suggestions: ["do X", "do Y"],
        },
      ],
      counts: { must: 1, should: 0, want: 0 },
    });
    const comments = buildHunkComments(review);
    expect(comments).toHaveLength(1);
    expect(comments[0].markup as string).toContain("<list>");
    expect(comments[0].markup as string).toContain("do X");
  });

  it("returns empty array for invalid json", () => {
    expect(buildHunkComments(undefined)).toEqual([]);
    expect(buildHunkComments("not json")).toEqual([]);
    expect(buildHunkComments(JSON.stringify({ axes: null }))).toEqual([]);
  });

  it("summary contains correct emoji mappings for all severities and axes", () => {
    const cases: Array<{
      severity: "must" | "should" | "want";
      axis: string;
      expectedEmoji: string;
    }> = [
      { severity: "must", axis: "req-1", expectedEmoji: "🚨" },
      { severity: "should", axis: "req-2", expectedEmoji: "⚠️" },
      { severity: "want", axis: "logic-1", expectedEmoji: "💡" },
    ];
    for (const c of cases) {
      const r = formatComment({
        severity: c.severity,
        axis: c.axis,
        detail: "d",
        filePath: "p.ts",
        line: 1,
      });
      expect(r.summary).toContain(c.expectedEmoji);
    }
    const axisCases = [
      { axis: "req-1", emoji: "🎯" },
      { axis: "req-2", emoji: "📋" },
      { axis: "logic-1", emoji: "🛡️" },
      { axis: "logic-2", emoji: "🔒" },
      { axis: "arch-1", emoji: "🧩" },
    ];
    for (const c of axisCases) {
      const r = formatComment({
        severity: "must",
        axis: c.axis,
        detail: "d",
        filePath: "p.ts",
        line: 1,
      });
      expect(r.summary).toContain(c.emoji);
      expect(r.markup).toContain(c.emoji);
    }
  });
});
