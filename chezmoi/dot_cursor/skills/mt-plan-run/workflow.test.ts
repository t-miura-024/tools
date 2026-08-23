import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def from "./workflow.ts";
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
