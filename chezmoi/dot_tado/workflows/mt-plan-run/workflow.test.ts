import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def, { buildHunkComments, formatComment } from "./index.ts";
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

  describe("start_hunk_review", () => {
    it("hunk-start.json が session:null の偽装なら fail", () => {
      fakeMt({ statusOutput: "hunk review session: active" });
      fs.writeFileSync(path.join(sessionDir, "hunk-start.json"), '{"session":null}\n');

      const result = stepCheck("start_hunk_review")(makeCtx());

      expect(result.status).toBe("fail");
    });

    it("session があり mt hunk status が active なら pass", () => {
      fakeMt({ statusOutput: "hunk review session: active" });
      fs.writeFileSync(
        path.join(sessionDir, "hunk-start.json"),
        '{"session":{"sessionId":"s1"},"comments":[]}\n',
      );

      const result = stepCheck("start_hunk_review")(makeCtx());

      expect(result.status).toBe("pass");
    });
  });

  describe("await_review", () => {
    it("mt hunk status が inactive なら fail", () => {
      fakeMt({ statusOutput: "hunk review session: none" });

      const result = stepCheck("await_review")(makeCtx());

      expect(result.status).toBe("fail");
    });

    it("mt hunk status が active なら pass", () => {
      fakeMt({ statusOutput: "hunk review session: active" });

      const result = stepCheck("await_review")(makeCtx());

      expect(result.status).toBe("pass");
    });
  });

  describe("check_hunk", () => {
    it("正実 pass なら pass し gate JSON を永続化する", () => {
      const gate = { passes: true, blocking_threads: [] };
      fakeMt({
        statusOutput: "hunk review session: active",
        checkJson: JSON.stringify(gate),
        checkExit: 0,
      });

      const result = stepCheck("check_hunk")(
        makeCtx({ attemptResult: { status: "completed", subagentOutput: JSON.stringify(gate) } }),
      );

      expect(result.status).toBe("pass");
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "hunk-check.json"), "utf-8"),
      );
      expect(persisted).toEqual(gate);
    });

    it("正実 block なら blocking_threads を reasons にして fail", () => {
      const gate = {
        passes: false,
        blocking_threads: [
          {
            id: "n1",
            file: "a.ts",
            line: 10,
            taxonomy: "question",
            body: "[question] fix me",
            replies: [],
          },
        ],
      };
      fakeMt({
        statusOutput: "hunk review session: active",
        checkJson: JSON.stringify(gate),
        checkExit: 1,
      });

      const result = stepCheck("check_hunk")(
        makeCtx({ attemptResult: { status: "completed", subagentOutput: JSON.stringify(gate) } }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("[question] fix me");
    });

    it("report が pass 偽装でも daemon が block なら不一致 fail", () => {
      const daemonGate = {
        passes: false,
        blocking_threads: [{ id: "n1", taxonomy: "issue", body: "[issue] real", replies: [] }],
      };
      fakeMt({
        statusOutput: "hunk review session: active",
        checkJson: JSON.stringify(daemonGate),
        checkExit: 1,
      });

      const result = stepCheck("check_hunk")(
        makeCtx({
          attemptResult: {
            status: "completed",
            subagentOutput: JSON.stringify({ passes: true, blocking_threads: [] }),
          },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("does not match");
    });

    it("blocking_threads を改変した report は不一致 fail", () => {
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
        passes: false,
        blocking_threads: [{ id: "n1", taxonomy: "issue", body: "[issue] rewritten", replies: [] }],
      };

      const result = stepCheck("check_hunk")(
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
  const axes = ["essentiality", "acceptance", "scope", "alignment", "quality"] as const;
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
      axis: "acceptance",
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
      axis: "scope",
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
      axis: "quality",
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
      axis: "essentiality",
      detail: "詳細のみ",
      filePath: "src/no-suggest.ts",
      line: 1,
    });
    expect(result.markup).not.toContain("<list>");
  });

  it("handles multiline detail with br", () => {
    const result = formatComment({
      severity: "should",
      axis: "alignment",
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
      axis: "scope",
      detail: "ファイルレベル指摘",
    });
    expect(result.summary).toContain("general");
    expect(result.markup).toContain("general");
  });
});

describe("buildHunkComments integration", () => {
  it("generates markup and summary for mixed axes with and without line", () => {
    const review = {
      round: 1,
      axes: {
        essentiality: [
          {
            severity: "must",
            detail: "essential must detail",
            filePath: "src/a.ts",
            position: { side: "new", line: 10 },
          },
          { severity: "should", detail: "essential should detail", filePath: "src/b.ts" },
        ],
        acceptance: [
          {
            severity: "want",
            detail: "acceptance want detail",
            filePath: "src/c.ts",
            position: { side: "old", line: 5 },
          },
        ],
        scope: [],
        alignment: [
          {
            severity: "must",
            detail: "align must <escape> & test",
            filePath: "src/d.ts",
            position: { side: "new", line: 99 },
          },
        ],
        quality: [
          {
            severity: "should",
            detail: "quality should detail\nsecond line",
            filePath: "src/e.ts",
          },
        ],
      },
      counts: { must: 2, should: 2, want: 1 },
    };
    const comments = buildHunkComments(JSON.stringify(review));
    expect(comments).toHaveLength(5);
    for (const c of comments) {
      expect(c.summary).toBeDefined();
      expect(c.markup).toBeDefined();
      expect(c.summary as string).not.toContain("[");
      expect(c.markup as string).toContain("<box");
      expect(c.markup as string).toContain("border-color=");
    }
    // line ありは newLine/oldLine が付与される
    const withLine = comments.find((c) => c.filePath === "src/a.ts");
    expect(withLine?.newLine).toBe(10);
    const withoutLine = comments.find((c) => c.filePath === "src/b.ts");
    expect(withoutLine?.newLine).toBeUndefined();
    expect(withoutLine?.oldLine).toBeUndefined();
    const oldLine = comments.find((c) => c.filePath === "src/c.ts");
    expect(oldLine?.oldLine).toBe(5);
    // snapshot for stability
    expect(comments).toMatchSnapshot();
  });

  it("ignores suggestion field gracefully when present", () => {
    const review = {
      round: 1,
      axes: {
        essentiality: [
          {
            severity: "must",
            detail: "detail with suggestion",
            filePath: "src/f.ts",
            position: { side: "new", line: 1 },
            suggestions: ["do X", "do Y"],
          },
        ],
        acceptance: [],
        scope: [],
        alignment: [],
        quality: [],
      },
      counts: { must: 1, should: 0, want: 0 },
    };
    const comments = buildHunkComments(JSON.stringify(review));
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
      { severity: "must", axis: "essentiality", expectedEmoji: "🚨" },
      { severity: "should", axis: "acceptance", expectedEmoji: "⚠️" },
      { severity: "want", axis: "quality", expectedEmoji: "💡" },
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
      { axis: "essentiality", emoji: "🎯" },
      { axis: "acceptance", emoji: "✅" },
      { axis: "scope", emoji: "📦" },
      { axis: "alignment", emoji: "🧭" },
      { axis: "quality", emoji: "✨" },
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
