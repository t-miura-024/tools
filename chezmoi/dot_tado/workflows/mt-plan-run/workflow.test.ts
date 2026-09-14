import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def from "./index.ts";
import { awaitHumanReviewStep } from "../mt-review-diff/index.ts";
import {
  buildDifitComments,
  formatReviewComment as formatComment,
} from "../_shared/mt-review-helpers.ts";
import type { CheckCtx, ConditionCtx } from "tado";
import type { ArtifactRecord } from "tado";

const stepCheck = (key: string) => def.steps.find((s) => s.key === key)!.check;

/// fake スクリプトの安定 runner（exec 対象）。
/// macOS は新規の実行ファイルごとに exec スキャン（syspolicyd 等）を行い、高負荷時は
/// spawn が数分ブロックする。テストごとに変わる本体は exec されない `.body` に置き、
/// 実行される scriptPath はこの runner への symlink に固定することで、スキャンを
/// プロセスにつき 1 回に抑え、テストのランダムな長時間ブロックを防ぐ。
const FAKE_SCRIPT_RUNNER = path.join(os.tmpdir(), `mt-fake-script-runner-${process.pid}.sh`);

function ensureFakeScriptRunner(): string {
  if (!fs.existsSync(FAKE_SCRIPT_RUNNER)) {
    fs.writeFileSync(FAKE_SCRIPT_RUNNER, `#!/bin/sh\nexec /bin/sh "$0.body" "$@"\n`);
    fs.chmodSync(FAKE_SCRIPT_RUNNER, 0o755);
  }
  return FAKE_SCRIPT_RUNNER;
}

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
    // 実行される scriptPath は安定 runner への symlink に固定し、テストごとに変わる本体は
    // exec されない `.body` へ置く（ensureFakeScriptRunner のコメント参照）。
    fs.writeFileSync(`${scriptPath}.body`, `#!/bin/sh\n${body}\n`);
    fs.rmSync(scriptPath, { force: true });
    fs.symlinkSync(ensureFakeScriptRunner(), scriptPath);
  }

  /// git fake: rev-parse --show-toplevel（readDifitReviewState の基点）に加えて、
  /// start check の選択整合検証が使う rev-parse <ref> / merge-base / symbolic-ref に応答する。
  /// ls-files --others --exclude-standard -z は diff.txt 完全性検証の untracked 一覧を、
  /// status --porcelain -z は staged 一覧を、diff --numstat -z は収集範囲のファイル別
  /// 行数を返す（options.untracked で欠落検出テスト用の一覧を模せる）。
  function fakeGit(options: { untracked?: string[] } = {}): void {
    const untrackedLines = (options.untracked ?? []).map((f) => `printf '%s\\0' '${f}'`).join("\n");
    writeScript(
      "git",
      `[ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && echo "${tmp}/repo" && exit 0
if [ "$1" = "rev-parse" ]; then echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; exit 0; fi
if [ "$1" = "merge-base" ]; then echo "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; exit 0; fi
if [ "$1" = "symbolic-ref" ]; then echo "origin/main"; exit 0; fi
if [ "$1" = "ls-files" ]; then
${untrackedLines}
exit 0
fi
if [ "$1" = "status" ]; then
exit 0
fi
if [ "$1" = "diff" ]; then
exit 0
fi
exit 1`,
    );
  }

  /// `.difit/difit-review.json` を書く（readDifitReviewState が読む JSON 契約）。
  /// selection の既定値は fakeGit が返す解決値（base=bbbbbbb, target=.）と一致させ、
  /// start check の選択整合検証を通過させる。null で selection 未記録を模せる。
  function writeDifitState(
    options: { pid?: number; port?: number; selection?: Record<string, unknown> | null } = {},
  ): void {
    const dir = path.join(tmp, "repo", ".difit");
    fs.mkdirSync(dir, { recursive: true });
    const selection =
      options.selection === undefined
        ? { base: "bbbbbbb", target: ".", baseMode: "merge-base" }
        : options.selection;
    fs.writeFileSync(
      path.join(dir, "difit-review.json"),
      JSON.stringify({
        port: options.port ?? 4966,
        pid: options.pid ?? process.pid,
        comments: [],
        difit_args: [],
        tab: null,
        ...(selection ? { selection } : {}),
      }),
    );
  }

  /// start check の選択整合検証が読む effort.json。base=main、target なしの既定。
  /// （validateEffort は git ref 名を検証するため、スラッシュを含む ref は使わない）
  function writeEffort(overrides: Record<string, unknown> = {}): void {
    fs.writeFileSync(
      path.join(sessionDir, "effort.json"),
      JSON.stringify({
        width: "medium",
        depth: "medium",
        base: "main",
        round: 1,
        ...overrides,
      }),
    );
  }

  /// `mt difit check --dry-run`（非破壊突合）と `mt difit done`（後始末）を制御する。
  /// dry-run 以外の check 引数は exit 65 で拒否し、done は呼び出しマーカーを残して
  /// state を削除する。checkStderr / doneStderr で stderr の診断メッセージを模せる。
  /// `check --dry-run` は selection_drift を常に含む契約のため、checkJson に無ければ
  /// `none`（一致）を補う（欠落・解釈不能は checkJson 側で明示的に模す）。
  function fakeMtDifitGate(
    options: {
      checkJson?: string;
      checkExit?: number;
      checkStderr?: string;
      doneJson?: string;
      doneStderr?: string;
    } = {},
  ): void {
    const marker = path.join(tmp, "done-called");
    const checkJson = (() => {
      if (options.checkJson === undefined) return undefined;
      try {
        const parsed = JSON.parse(options.checkJson) as Record<string, unknown>;
        if (parsed.selection_drift === undefined) {
          parsed.selection_drift = { detection: "none" };
        }
        return JSON.stringify(parsed);
      } catch {
        return options.checkJson;
      }
    })();
    const lines = [`[ "$1" = "difit" ] || exit 64`, `if [ "$2" = "check" ]; then`];
    lines.push(`  [ "$3" = "--dry-run" ] || exit 65`);
    if (checkJson !== undefined) {
      lines.push(`  printf '%s\\n' '${checkJson}'`);
      if (options.checkStderr) {
        lines.push(`  printf '%s\\n' '${options.checkStderr}' >&2`);
      }
      lines.push(`  exit ${options.checkExit ?? 0}`);
    } else {
      lines.push(`  exit 1`);
    }
    lines.push(`fi`, `if [ "$2" = "done" ]; then`);
    lines.push(`  touch '${marker}'`);
    lines.push(`  rm -f "${tmp}/repo/.difit/difit-review.json"`);
    if (options.doneStderr) {
      lines.push(`  printf '%s\\n' '${options.doneStderr}' >&2`);
    }
    lines.push(`  printf '%s\\n' '${options.doneJson ?? '{"passes":true,"blocking_threads":[]}'}'`);
    lines.push(`  exit 0`, `fi`, `exit 64`);
    writeScript("mt", lines.join("\n"));
  }

  function doneCalled(): boolean {
    return fs.existsSync(path.join(tmp, "done-called"));
  }

  /// `mt difit threads --json`（選択固定・read-only）に応答する fake mt。
  /// `selection_drift` は Rust 側で必須のため `none`（一致）を常に含める。
  /// 引数が `difit threads --json` でなければ exit 64（unpinned CLI への退行検出）。
  function fakeMtDifitThreads(threadBodies: string[]): void {
    const threads = threadBodies.map((body, index) => ({
      id: `t${index + 1}`,
      filePath: "src/a.ts",
      position: { side: "new", line: index + 1 },
      taxonomy: "issue",
      blocking: true,
      body,
      author: null,
      replies: [],
    }));
    writeScript(
      "mt",
      `[ "$1" = "difit" ] || exit 64
[ "$2" = "threads" ] || exit 64
[ "$3" = "--json" ] || exit 64
printf '%s\\n' '${JSON.stringify({ passes: false, selection: {}, threads, blocking_threads: [], selection_drift: { detection: "none" } })}'
exit 0`,
    );
  }

  function makeCtx(overrides: Partial<CheckCtx> = {}): CheckCtx {
    return {
      sessionDir,
      attemptResult: { status: "completed" },
      artifacts: [],
      ...overrides,
    };
  }

  /// tado の ArtifactRecord。requireStepArtifacts は report 申告済み（ctx.artifacts）の
  /// 成果物だけを読めるため、execute_work の check テストは申告済みレコードを渡す。
  function artifactRecord(key: string, filePath: string): ArtifactRecord {
    return {
      id: 0,
      sessionId: path.basename(sessionDir),
      stepKey: "execute_work",
      artifactKey: key,
      filePath,
      createdAt: "2026-01-01 00:00:00",
    };
  }

  function writeFindings(counts: { must: number; should: number; want: number }, round = 1): void {
    const findings: Array<Record<string, unknown>> = [];
    let line = 1;
    for (const [severity, n] of Object.entries(counts)) {
      for (let i = 0; i < (n as number); i += 1) {
        findings.push({
          axis: "req-1",
          severity,
          detail: `${severity} detail ${i}`,
          filePath: "src/a.ts",
          position: { side: "new", line: line++ },
        });
      }
    }
    fs.writeFileSync(
      path.join(sessionDir, "findings.json"),
      JSON.stringify({
        round,
        width: "medium",
        depth: "medium",
        findings,
        counts,
      }),
    );
  }

  /// resetReviewCycle が操作する workflow.db（TADO_HOME 配下）を作る。
  /// execute_work より後の review steps を passed / failed に置き、
  /// resetReviewCycle 後に pending へ戻ることを検証できるようにする。
  function writeWorkflowDb(): string {
    const dbDir = path.join(tmp, "tado-home", ".tado");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "workflow.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE steps (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, step_key TEXT NOT NULL, step_index INTEGER NOT NULL, status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0)",
    );
    const sessionId = path.basename(sessionDir);
    const rows: Array<[string, number, string]> = [
      ["identify_plan", 0, "passed"],
      ["execute_work", 1, "passed"],
      ["run_reviewers", 2, "passed"],
      ["start_difit_review", 3, "passed"],
      ["await_human_review", 4, "passed"],
      ["collect_verdict", 5, "failed"],
    ];
    for (const [key, index, status] of rows) {
      db.run(
        "INSERT INTO steps (session_id, step_key, step_index, status, retry_count) VALUES (?, ?, ?, ?, 0)",
        [sessionId, key, index, status],
      );
    }
    db.close();
    return dbPath;
  }

  /// workflow.db（TADO_HOME 配下）に gate_events を用意し、confirmed / rejected イベントを
  /// 追記する（execute_work の revise 理由検証テスト用。session_id は本セッションが既定）。
  function writeGateEvent(
    stepKey: string,
    answers: Record<string, unknown> | null,
    options: { sessionId?: string; event?: "confirmed" | "rejected" } = {},
  ): string {
    const dbDir = path.join(tmp, "tado-home", ".tado");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "workflow.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE IF NOT EXISTS gate_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, step_key TEXT NOT NULL, event TEXT NOT NULL, answers_json TEXT)",
    );
    db.run(
      "INSERT INTO gate_events (session_id, step_key, event, answers_json) VALUES (?, ?, ?, ?)",
      [
        options.sessionId ?? path.basename(sessionDir),
        stepKey,
        options.event ?? "confirmed",
        answers === null ? null : JSON.stringify(answers),
      ],
    );
    db.close();
    return dbPath;
  }

  /// gate_events の revise イベント（`{"decision":{"value":"revise","input":"<reason>"}}`）を追記する。
  function writeReviseGateEvent(
    stepKey: string,
    reason: string,
    options: { sessionId?: string; event?: "confirmed" | "rejected" } = {},
  ): string {
    return writeGateEvent(stepKey, { decision: { value: "revise", input: reason } }, options);
  }

  function stepStatus(dbPath: string, key: string): string | undefined {
    const db = new Database(dbPath);
    const row = db
      .query("SELECT status FROM steps WHERE session_id = ? AND step_key = ?")
      .get(path.basename(sessionDir), key) as { status?: string } | undefined;
    db.close();
    return row?.status;
  }

  describe("start_difit_review", () => {
    it("difit-start.json の port/url/comments 契約と live セッション、サーバ上の実コメントが揃えば pass", () => {
      fakeGit();
      writeEffort();
      const body = "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\nreal body";
      fakeMtDifitThreads([body]);
      writeDifitState();
      fs.writeFileSync(
        path.join(sessionDir, "difit-comments.json"),
        JSON.stringify([
          { type: "thread", filePath: "src/a.ts", position: { side: "new", line: 1 }, body },
        ]),
      );
      fs.writeFileSync(
        path.join(sessionDir, "difit-start.json"),
        '{"port":4966,"url":"http://localhost:4966","comments":1}\n',
      );

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("port=4966");
    });

    it("difit-start.json が無ければ fail", () => {
      fakeGit();
      writeDifitState();

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("fail");
    });

    it("difit-start.json に port/url が無ければ fail（stdout 契約の検証）", () => {
      fakeGit();
      writeDifitState();
      fs.writeFileSync(path.join(sessionDir, "difit-start.json"), '{"comments":2}\n');

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("fail");
    });

    it(".difit/difit-review.json が無ければ fail（start 実行の機械検証）", () => {
      fakeGit();
      fs.writeFileSync(
        path.join(sessionDir, "difit-start.json"),
        '{"port":4966,"url":"http://localhost:4966","comments":0}\n',
      );

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("fail");
    });

    it("difit サーバの pid が死んでいれば fail（JSON 契約の検証）", () => {
      fakeGit();
      writeDifitState({ pid: 2147483647 });
      fs.writeFileSync(
        path.join(sessionDir, "difit-start.json"),
        '{"port":4966,"url":"http://localhost:4966","comments":0}\n',
      );

      expect(stepCheck("start_difit_review")(makeCtx()).status).toBe("fail");
    });

    it("buildPrompt は URL 提示と再入時のサーバ再利用を指示する", () => {
      const step = def.steps.find((s) => s.key === "start_difit_review")!;
      const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
      expect(prompt).toContain("mt difit start");
      expect(prompt).toContain("difit-comments.json");
      expect(prompt).toContain("再利用");
      expect(prompt).toContain("difit-start.json");
      // stdout の url を人間と report へ提示する（表示の自動化は行わない）
      expect(prompt).toContain("url");
      expect(prompt).toContain("提示");
    });

    it("effort.json の target が state.selection に反映されていなければ fail（base 単独起動の乖離検出）", () => {
      fakeGit();
      writeEffort({ target: "feature" });
      const body = "**🚨 must · 🐛 issue · 🎯 req-1**\n\n**詳細**:\n\nreal body";
      fakeMtDifitThreads([body]);
      // target を提示しない起動（単独 base）: selection は target "." のまま
      writeDifitState();
      fs.writeFileSync(
        path.join(sessionDir, "difit-comments.json"),
        JSON.stringify([
          { type: "thread", filePath: "src/a.ts", position: { side: "new", line: 1 }, body },
        ]),
      );
      fs.writeFileSync(
        path.join(sessionDir, "difit-start.json"),
        '{"port":4966,"url":"http://localhost:4966","comments":1}\n',
      );

      const result = stepCheck("start_difit_review")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("一致しません");
    });
  });

  describe("collect_context (plan-run 固有: effort.json round 検証)", () => {
    const step = () => def.steps.find((s) => s.key === "collect_context")!;

    it("effort.json の round が有効なら pass する", () => {
      fakeGit();
      fs.writeFileSync(path.join(sessionDir, "diff.txt"), "");
      writeEffort({ round: 1 });

      const result = step().check(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("round=1");
    });

    it("effort.json が無ければ fail（round limit へ到達できないままループしない）", () => {
      fakeGit();
      fs.writeFileSync(path.join(sessionDir, "diff.txt"), "");

      const result = step().check(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("effort.json");
    });

    it("effort.json の round が不正なら fail", () => {
      fakeGit();
      fs.writeFileSync(path.join(sessionDir, "diff.txt"), "");
      writeEffort({ round: 0 });

      const result = step().check(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("round");
    });

    it("untracked が diff.txt に欠落していれば fail（打ち切られた差分を機械照合へ渡さない）", () => {
      fakeGit({ untracked: ["src/dropped.ts"] });
      fs.writeFileSync(path.join(sessionDir, "diff.txt"), "");
      writeEffort({ round: 1 });

      const result = step().check(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("src/dropped.ts");
    });
  });

  describe("agent_verdict（自律/人相の振り分け）", () => {
    it("must>0 なら fail し execute_work 反復を示す", () => {
      writeEffort();
      writeFindings({ must: 2, should: 1, want: 0 });

      const result = stepCheck("agent_verdict")(makeCtx());

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("goto execute_work");
    });

    it("effort.json が無ければ error（round を前進できない fail-closed。無言 no-op にしない）", () => {
      writeFindings({ must: 2, should: 1, want: 0 });

      const result = stepCheck("agent_verdict")(makeCtx());

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("failed to prepare next review round");
      expect(result.reasons.join("\n")).toContain("effort.json");
    });

    it("effort.json の round が不正なら error（破損 effort.json の無言 no-op を防ぐ）", () => {
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "medium", depth: "medium", round: "one" }),
      );
      writeFindings({ must: 1, should: 0, want: 0 });

      const result = stepCheck("agent_verdict")(makeCtx());

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("invalid round");
      // round は進まない（破損 effort.json を書き換えない）
      const effort = JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: unknown;
      };
      expect(effort.round).toBe("one");
    });

    it("findings の round が前回 verdict から進んでいなければ pass で round_stall_gate（人間）へエスカレーションする", () => {
      writeEffort();
      writeFindings({ must: 1, should: 0, want: 0 });
      // 前ラウンドの verdict が同じ round（前回のループバックで round が進まなかった）
      fs.writeFileSync(
        path.join(sessionDir, "verdict.json"),
        JSON.stringify({
          round: 1,
          width: "medium",
          depth: "medium",
          passed: false,
          blocking_threads: [],
        }),
      );

      const result = stepCheck("agent_verdict")(makeCtx());

      // error + goto execute_work の決定論的反復にしない（人間ゲートへ到達させる）
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("進んでいません");
      expect(result.reasons.join("\n")).toContain("round_stall_gate");
      // 停滞検出では round を進めない（前進の主体は execute_work の check）
      const effort = JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: number;
      };
      expect(effort.round).toBe(1);

      // round_stall_gate の condition が同じ写像で true になる（人間エスカレーションの配線）
      const gate = def.steps.find((s) => s.key === "round_stall_gate")!;
      expect(gate.type).toBe("human_gate");
      expect(gate.condition!({ sessionDir, gateAnswers: {}, artifacts: [] })).toBe(true);
      expect(gate.humanGate!.reviseTargetStep).toBe("execute_work");
    });

    it("must==0 なら pass し人相へ進む", () => {
      writeFindings({ must: 0, should: 1, want: 0 });

      const result = stepCheck("agent_verdict")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("human phase");
    });

    it("findings.json が不正なら error", () => {
      fs.writeFileSync(path.join(sessionDir, "findings.json"), "not json");

      const result = stepCheck("agent_verdict")(makeCtx());

      expect(result.status).toBe("error");
    });

    it("round 4 かつ must>0 は自動ループを止め collect_verdict の round limit へエスカレーションする（fail で goto すると gate へ到達しない）", () => {
      writeEffort({ round: 4 });
      writeFindings({ must: 1, should: 0, want: 0 }, 4);

      const result = stepCheck("agent_verdict")(makeCtx());

      // fail -> onFail goto execute_work だと round が進まないまま永久に反復し、
      // round_limit_gate へ到達できない。pass で collect_verdict へ進める。
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("autonomous round limit reached");
      expect(result.reasons.join("\n")).toContain("collect_verdict");
      expect(result.reasons.join("\n")).toContain("round_limit_gate");
      // round は 4 のまま（LIMIT+1 へ前進させると resolve_effort の上限判定で abort する）
      const effort = JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: number;
      };
      expect(effort.round).toBe(4);
    });

    it("round 3 かつ must>0 は round を 4 に進めず pass で collect_verdict の round limit 判定へ渡す", () => {
      writeEffort({ round: 3 });
      writeFindings({ must: 1, should: 0, want: 0 }, 3);

      const result = stepCheck("agent_verdict")(makeCtx());

      // round 3 >= LIMIT 到達で pass。エスカレーションは collect_verdict →
      // round_limit_gate が行う（round を 4 に進めると resolve_effort の
      // onFail: abort でセッションが終了し、release にも到達しない）。
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("autonomous round limit reached: round=3 >= 3");
      expect(result.reasons.join("\n")).toContain("round_limit_gate");
      const effort = JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: number;
      };
      expect(effort.round).toBe(3);
    });

    it("must>0 のループバックで effort.json の round を +1 する（round limit の到達性）", () => {
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "medium", depth: "medium", round: 1 }),
      );
      writeFindings({ must: 1, should: 0, want: 0 });

      const result = stepCheck("agent_verdict")(makeCtx());

      expect(result.status).toBe("fail");
      const effort = JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: number;
      };
      expect(effort.round).toBe(2);
    });

    it("goto 先が execute_work である", () => {
      const step = def.steps.find((s) => s.key === "agent_verdict")!;
      expect(step.onFail).toEqual({ action: "goto", target: "execute_work", requeueSource: true });
    });
  });

  // 旧レビューサイクル（別ワークフロー由来の start / inject / check）は Step import により
  // resolve_effort / collect_context / run_reviewers / normalize_findings / start_difit_review /
  // await_human_review / collect_verdict に置換されたため削除
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

    it("round が上限を超えた effort.json（round_limit_gate の revise 再入）は abort させず pass する", () => {
      // execute_work の check が round を 3→4 に前進させた後の再入。mt-review-diff の
      // check は上限超過を fail で返すが、onFail: abort の plan-run では人間ゲート
      // （collect_verdict → round_limit_gate）へ到達できなくなるため継続再入を許容する。
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "high", depth: "low", base: "main", round: 4 }),
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("round limit continuation");
      expect(result.reasons.join("\n")).toContain("round_limit_gate");
    });

    it("round が上限を超えても width が不正なら fail のまま（round 以外の契約は維持する）", () => {
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "super", depth: "low", round: 4 }),
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("invalid width");
    });

    it("round が上限を超えても base が不正なら fail のまま（共有 validateEffort の契約）", () => {
      fs.writeFileSync(
        path.join(sessionDir, "effort.json"),
        JSON.stringify({ width: "high", depth: "low", base: "bad ref", round: 4 }),
      );
      const result = stepCheck("resolve_effort")(makeCtx());
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("invalid base");
    });
  });

  describe("execute_work (round 前進の写像)", () => {
    const runExecuteWorkCheck = () => {
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      return stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );
    };
    const readEffortRound = (): number =>
      (
        JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
          round: number;
        }
      ).round;

    it("レビュー済みラウンドへの再入（round_limit_gate の revise）は round を +1 してから次ラウンドへ渡す", () => {
      writeEffort({ round: 3 });
      fs.writeFileSync(
        path.join(sessionDir, "verdict.json"),
        JSON.stringify({
          round: 3,
          width: "medium",
          depth: "medium",
          passed: false,
          blocking_threads: [],
        }),
      );

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(readEffortRound()).toBe(4);
      expect(result.reasons.join("\n")).toContain("round を次ラウンドへ前進");
    });

    it("通常のループバック（effort.round > verdict.round）では前進しない", () => {
      writeEffort({ round: 2 });
      fs.writeFileSync(
        path.join(sessionDir, "verdict.json"),
        JSON.stringify({
          round: 1,
          width: "medium",
          depth: "medium",
          passed: false,
          blocking_threads: [],
        }),
      );

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(readEffortRound()).toBe(2);
      expect(result.reasons.join("\n")).not.toContain("round を次ラウンドへ前進");
    });

    it("verdict 不在（初回レビュー前）では前進しない", () => {
      writeEffort({ round: 1 });

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(readEffortRound()).toBe(1);
    });

    it("workflow.db を読めない場合は revise 検証不能の warning を理由に残して pass する（無音にしない）", () => {
      // beforeEach は TADO_HOME を空の tmp に向けるため workflow.db が無い = 検証不能経路
      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("warning");
      expect(result.reasons.join("\n")).toContain("workflow.db");
    });

    /// revise-feedback.json の契約オブジェクトを書く。
    const writeReviseFeedback = (
      items: Array<{ stepKey: string; reason: string }>,
      sessionId = path.basename(sessionDir),
    ): void => {
      fs.writeFileSync(
        path.join(sessionDir, "revise-feedback.json"),
        JSON.stringify({ sessionId, items }),
      );
    };

    it("本セッションの confirmed revise と revise-feedback.json が一致すれば pass する", () => {
      writeReviseGateEvent("await_human_review", "設計方針の修正理由");
      writeReviseFeedback([{ stepKey: "await_human_review", reason: "設計方針の修正理由" }]);

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("revise-feedback.json を検証");
      expect(result.reasons.join("\n")).toContain("await_human_review");
    });

    it("confirmed revise があるのに revise-feedback.json が無ければ fail（抽出未実施の検出）", () => {
      writeReviseGateEvent("round_limit_gate", "継続する理由");

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("revise-feedback.json");
      expect(result.reasons.join("\n")).toContain("confirmed");
    });

    it("別セッションの revise は期待値に混入せず、ファイルの sessionId 不一致を fail にする", () => {
      // workflow.db は全セッション共有。別セッションの confirmed revise を本セッションの
      // 期待値に含めない（session_id で絞る）ことを固定する。
      writeReviseGateEvent("await_human_review", "別 Issue の revise 理由", {
        sessionId: "20260101-000000-other",
      });
      writeReviseFeedback(
        [{ stepKey: "await_human_review", reason: "別 Issue の revise 理由" }],
        "20260101-000000-other",
      );

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("sessionId");
      expect(result.reasons.join("\n")).toContain(path.basename(sessionDir));
    });

    it("workflow.db に confirmed revise が無いのに items があるファイルは fail（捏造・混入の検出）", () => {
      // gate_events はあるが本セッションの revise イベントは無い状態を作る
      writeGateEvent("identify_plan", { decision: { value: "approve" } });
      writeReviseFeedback([{ stepKey: "await_human_review", reason: "DB に証跡のない理由" }]);

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("confirmed revise が無い");
    });

    it("revise 理由の原文不一致・空 reason・余剰 items を fail にする", () => {
      writeReviseGateEvent("round_stall_gate", "原文の理由");
      writeReviseFeedback([{ stepKey: "round_stall_gate", reason: "改変された理由" }]);
      const altered = runExecuteWorkCheck();
      expect(altered.status).toBe("fail");
      expect(altered.reasons.join("\n")).toContain("一致しません");

      // 余剰 items（multiset 突合）
      writeReviseFeedback([
        { stepKey: "round_stall_gate", reason: "原文の理由" },
        { stepKey: "await_human_review", reason: "余剰" },
      ]);
      const extra = runExecuteWorkCheck();
      expect(extra.status).toBe("fail");
      expect(extra.reasons.join("\n")).toContain("余剰 1 件");

      // 空 reason はスキーマ違反
      writeReviseFeedback([{ stepKey: "round_stall_gate", reason: "  " }]);
      const empty = runExecuteWorkCheck();
      expect(empty.status).toBe("fail");
      expect(empty.reasons.join("\n")).toContain("reason");
    });

    it("confirmed でも approve のイベントは revise として扱わない（ファイル不要）", () => {
      writeGateEvent("await_human_review", { decision: { value: "approve" } });

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("confirmed revise なし");
    });

    it("confirmed revise の answers_json から理由を抽出できなければ error（無音にしない）", () => {
      writeGateEvent("await_human_review", { decision: { value: "revise" } });

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("修正理由を抽出できません");
    });

    it("rejected イベント（TTY 不在）は revise として扱わない", () => {
      writeGateEvent(
        "await_human_review",
        { decision: { value: "revise", input: "rejected の理由" } },
        { event: "rejected" },
      );

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("confirmed revise なし");
    });
  });

  describe("normalize_findings (Step import)", () => {
    // normalize check は diff.txt の完全性照合（untracked 一覧）にも git を使う。
    beforeEach(() => {
      fakeGit();
    });

    /// findings の位置（src/a.ts:1..10）を `+` 行として含む diff と、
    /// 生 findings（reviewer-outputs.json）を書く補助。
    function writeDiffAndRaw(rawFindings: unknown[]): void {
      const added = Array.from({ length: 10 }, (_, i) => `+line${i + 1}`);
      fs.writeFileSync(
        path.join(sessionDir, "diff.txt"),
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -0,0 +1,10 @@",
          ...added,
          "",
        ].join("\n"),
      );
      fs.writeFileSync(path.join(sessionDir, "reviewer-outputs.json"), JSON.stringify(rawFindings));
    }

    it("valid findings.json と導出一致の difit-comments.json があれば pass", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "difit-comments.json"), "[]");
      writeDiffAndRaw([]);
      const result = stepCheck("normalize_findings")(makeCtx());
      expect(result.status).toBe("pass");
    });

    it("difit-comments.json が findings の部分集合なら fail（循環検証の遮断）", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [
          {
            axis: "req-1",
            severity: "must",
            detail: "must detail",
            filePath: "src/a.ts",
            position: { side: "new", line: 1 },
          },
          {
            axis: "logic-3",
            severity: "should",
            detail: "should detail",
            filePath: "src/a.ts",
            position: { side: "new", line: 10 },
          },
        ],
        counts: { must: 1, should: 1, want: 0 },
      };
      const raw = JSON.stringify(findings);
      fs.writeFileSync(path.join(sessionDir, "findings.json"), raw);
      writeDiffAndRaw(findings.findings);
      const derived = buildDifitComments(raw);
      fs.writeFileSync(path.join(sessionDir, "difit-comments.json"), JSON.stringify([derived[0]]));
      const result = stepCheck("normalize_findings")(makeCtx());
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("欠落 1 件");
    });

    it("findings.json が不正なら error", () => {
      fs.writeFileSync(path.join(sessionDir, "findings.json"), "not json");
      const result = stepCheck("normalize_findings")(makeCtx());
      expect(result.status).toBe("error");
    });

    it("difit-start.json が無くても pass（起動は後段の責務）", () => {
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "difit-comments.json"), "[]");
      writeDiffAndRaw([]);
      const result = stepCheck("normalize_findings")(makeCtx());
      expect(result.status).toBe("pass");
    });
  });

  describe("await_human_review (Step import: plan-run が condition を override)", () => {
    const conditionOf = () => def.steps.find((s) => s.key === "await_human_review")!.condition!;
    const conditionCtx = (): ConditionCtx => ({ sessionDir, gateAnswers: {}, artifacts: [] });

    it("condition: 自律ループ中（must>0）は false（engine が human gate を skip する）", () => {
      writeFindings({ must: 1, should: 0, want: 0 });

      expect(conditionOf()(conditionCtx())).toBe(false);
    });

    it("condition: must=0 の人相段階は true（human gate を実行する）", () => {
      writeFindings({ must: 0, should: 1, want: 0 });

      expect(conditionOf()(conditionCtx())).toBe(true);
    });

    it("condition: findings.json を読めない場合は true（skip しない fail-closed）", () => {
      expect(conditionOf()(conditionCtx())).toBe(true);
    });

    it("condition は plan-run が override する（mt-review-diff の step は condition を持たず単独では常に提示）", () => {
      const step = def.steps.find((s) => s.key === "await_human_review")!;
      expect(awaitHumanReviewStep.condition).toBeUndefined();
      expect(step.condition).toBeDefined();
      expect(step.condition).not.toBe(awaitHumanReviewStep.condition);
    });

    it("revise が reviseTargetStep: execute_work に配線される（plan-run override の契約）", () => {
      const step = def.steps.find((s) => s.key === "await_human_review")!;
      // mt-review-diff 単独では reviseTargetStep を持たない（onFail: abort でゲート自身に戻る）
      expect(awaitHumanReviewStep.humanGate!.reviseTargetStep).toBeUndefined();
      // plan-run では修正サイクルへ戻す
      expect(step.humanGate!.reviseTargetStep).toBe("execute_work");
      const question = step.humanGate!.questions.find((q) => q.key === "decision")!;
      const revise = question.choices!.find((c) => c.value === "revise")!;
      // 入力した修正理由の消費先（gateAnswers → execute_work の修正指示）を案内する
      expect(revise.desc).toContain("execute_work");
      expect(revise.desc).toContain("gateAnswers");
      expect(awaitHumanReviewStep.humanGate!.questions[0].choices).not.toBe(question.choices);
    });
  });

  describe("collect_verdict (Step import, round上限3)", () => {
    it("verdict が check --dry-run と一致し passed=true なら done 後始末して pass", () => {
      fakeGit();
      writeEffort();
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
      // 後始末後の pid 終了確認を通すため、生存しない pid を使う
      writeDifitState({ pid: 2147483647 });
      fakeMtDifitGate({
        checkJson: JSON.stringify({ passes: true, blocking_threads: [] }),
        checkExit: 0,
      });
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );
      expect(result.status).toBe("pass");
      expect(doneCalled()).toBe(true);
    });

    it("round 4 の通過済みは round_limit_passed_gate へエスカレーションし、dry-run 突合を理由に載せる", () => {
      fakeGit();
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
      writeEffort({ round: 4 });
      writeDifitState();
      // 上限エスカレーションでも daemon 突合を実行する（無検証のまま終端させない）
      fakeMtDifitGate({ checkJson: JSON.stringify({ passes: true, blocking_threads: [] }) });
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("round_limit_passed_gate");
      expect(result.reasons.join("\n")).toContain("round limit");
      expect(result.reasons.join("\n")).toContain("daemon 突合 ok");

      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      // 未通過ゲートは passed=true では提示しない（文言の事実誤認を避ける）
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(false);
      const passedGate = def.steps.find((s) => s.key === "round_limit_passed_gate")!;
      expect(passedGate.type).toBe("human_gate");
      expect(passedGate.condition!(gateCtx)).toBe(true);
      const question = passedGate.humanGate!.questions.find((q) => q.key === "decision")!;
      expect(question.description).toContain("通過済み");
      expect(question.description).not.toContain("未通過");
      const approve = question.choices!.find((c) => c.value === "approve")!;
      expect(approve.label).toContain("通過済み");
      expect(approve.label).toContain("後始末");
      // 通過済みに「もう1巡」は提示しない
      expect(question.choices!.find((c) => c.value === "revise")).toBeUndefined();
      // 後始末ステップは両ゲートの受容経路で実行される
      expect(def.steps.find((s) => s.key === "release_difit_session")!.condition!(gateCtx)).toBe(
        true,
      );
    });

    it("実パイプライン: round 前進の写像ごとに execute_work → resolve_effort → collect_verdict → round_limit_gate（revise は round+1 で再入）まで到達する", () => {
      // 実パイプラインでは effort.json の round をループバック時に進め、findings.json →
      // verdict.json の順に継承する。テストでも verdict の round を直接 4 に書かず、
      // 各前進主体（agent_verdict / execute_work / collect_verdict）の写像を通して到達させる。
      fakeGit();
      const writeEffortAt = (round: number) => {
        fs.writeFileSync(
          path.join(sessionDir, "effort.json"),
          JSON.stringify({ width: "medium", depth: "medium", round }),
        );
      };
      const readEffortRound = (): number =>
        (
          JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
            round: number;
          }
        ).round;
      const writeFindingsAtRound = (round: number, must: number) => {
        fs.writeFileSync(
          path.join(sessionDir, "findings.json"),
          JSON.stringify({
            round,
            width: "medium",
            depth: "medium",
            findings:
              must > 0
                ? [
                    {
                      axis: "req-1",
                      severity: "must",
                      detail: "must detail",
                      filePath: "src/a.ts",
                      position: { side: "new", line: 1 },
                    },
                  ]
                : [],
            counts: { must, should: 0, want: 0 },
          }),
        );
      };
      const writeExecutionResult = () => {
        const resultPath = path.join(sessionDir, "execution-result.json");
        fs.writeFileSync(
          resultPath,
          JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
        );
        return stepCheck("execute_work")(
          makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
        );
      };
      const blockedThread = {
        id: "t1",
        taxonomy: "question",
        body: "⚠️ should body",
        replies: [],
      };
      const writeBlockedVerdict = (round: number) => {
        const verdict = {
          round,
          width: "medium",
          depth: "medium",
          passed: false,
          blocking_threads: [blockedThread],
        };
        fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
        return verdict;
      };
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };

      // round 1: must>0 → agent_verdict の前進写像で round 2 へ
      writeEffortAt(1);
      expect(writeExecutionResult().status).toBe("pass");
      expect(stepCheck("resolve_effort")(makeCtx()).status).toBe("pass");
      fs.writeFileSync(path.join(sessionDir, "diff.txt"), "");
      expect(stepCheck("collect_context")(makeCtx()).status).toBe("pass");
      writeFindingsAtRound(1, 1);
      expect(stepCheck("agent_verdict")(makeCtx()).status).toBe("fail");
      expect(readEffortRound()).toBe(2);

      // round 2: 同様に round 3 へ
      expect(writeExecutionResult().status).toBe("pass");
      expect(stepCheck("resolve_effort")(makeCtx()).status).toBe("pass");
      writeFindingsAtRound(2, 1);
      expect(stepCheck("agent_verdict")(makeCtx()).status).toBe("fail");
      expect(readEffortRound()).toBe(3);

      // round 3: must>0 でも round を 4 に進めず pass で collect_verdict へ渡す。
      // collect_verdict が上限を検出して pass（エスカレーション）へ変換し、
      // round_limit_gate / release_difit_session の condition が true になる。
      expect(writeExecutionResult().status).toBe("pass");
      expect(stepCheck("resolve_effort")(makeCtx()).status).toBe("pass");
      writeFindingsAtRound(3, 1);
      expect(stepCheck("agent_verdict")(makeCtx()).status).toBe("pass");
      expect(readEffortRound()).toBe(3);
      const blocked3 = writeBlockedVerdict(3);
      writeDifitState();
      fakeMtDifitGate({
        checkJson: JSON.stringify({ passes: false, blocking_threads: [blockedThread] }),
        checkExit: 1,
      });
      const escalated3 = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(blocked3) },
        }),
      );
      expect(escalated3.status).toBe("pass");
      expect(escalated3.reasons.join("\n")).toContain("round_limit_gate");
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(true);
      expect(def.steps.find((s) => s.key === "release_difit_session")!.condition!(gateCtx)).toBe(
        true,
      );

      // round_limit_gate の「もう1巡続ける（revise）」再入: execute_work の前進写像で
      // round 3 → 4。resolve_effort は round 4 > LIMIT でも abort せず pass する。
      expect(writeExecutionResult().status).toBe("pass");
      expect(readEffortRound()).toBe(4);
      expect(stepCheck("resolve_effort")(makeCtx()).status).toBe("pass");
      expect(stepCheck("collect_context")(makeCtx()).status).toBe("pass");
      writeFindingsAtRound(4, 1);
      expect(stepCheck("agent_verdict")(makeCtx()).status).toBe("pass");
      const blocked4 = writeBlockedVerdict(4);
      const escalated4 = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(blocked4) },
        }),
      );
      expect(escalated4.status).toBe("pass");
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(true);

      // 受容経路: release_difit_session が mt difit done で後始末まで到達する
      writeDifitState({ pid: 2147483647 });
      const released = stepCheck("release_difit_session")(makeCtx());
      expect(released.status).toBe("pass");
      expect(doneCalled()).toBe(true);
    });

    it("verdict が subagentOutput にだけ存在しても round limit を検出し、condition が読めるようファイルへ永続化する", () => {
      // origCheck と同じ解決チェーン（artifacts → セッションファイル → subagentOutput）で
      // verdict を解決する。ファイル経路しか見ないと上限到達を復旧経路へ落としてしまう。
      const verdict = {
        round: 3,
        width: "medium",
        depth: "medium",
        passed: false,
        blocking_threads: [],
      };
      fakeGit();
      writeEffort({ round: 3 });
      writeDifitState();
      fakeMtDifitGate({});
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("round_limit_gate");
      // round_limit_gate / release_difit_session の condition は attemptResult を持たない
      // ため、subagentOutput 経由の verdict をファイルへ永続化して判定経路を揃える。
      const persisted = JSON.parse(
        fs.readFileSync(path.join(sessionDir, "verdict.json"), "utf-8"),
      ) as { round: number };
      expect(persisted.round).toBe(3);
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(true);
      expect(def.steps.find((s) => s.key === "release_difit_session")!.condition!(gateCtx)).toBe(
        true,
      );
    });

    it("task 失敗（error）でも verdict が round limit なら pass で human gate へエスカレーションする（決定論的反復の停止）", () => {
      // verdict.json は round limit に達しているが collect_verdict task 自体が失敗しており、
      // origCheck は error（attemptResult 未完了）を返す。error を上限判定から外すと、
      // 決定論的に再発する error が round を前進させながら execute_work を無制限に反復する。
      writeEffort({ round: 4 });
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
        passed: false,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      // round_limit_gate の condition 自体は true（verdict が上限到達）であることを確認
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(true);

      const result = stepCheck("collect_verdict")(
        makeCtx({ attemptResult: { status: "failed", errors: "task failed" } }),
      );

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("error");
      expect(result.reasons.join("\n")).toContain("round_limit_gate");
      expect(result.reasons.join("\n")).toContain("task failed");
    });

    it("verdict を解決できない error が連続上限（effort.json round >= 3）に達したら pass でエスカレーションする", () => {
      // verdict が無い/不正の error は round 判定に載らないため、effort.json の round を
      // ループカウンタとして連続 error を打ち切る（無制限反復の停止）。
      fakeGit();
      writeEffort({ round: 3 });
      const result = stepCheck("collect_verdict")(
        makeCtx({ attemptResult: { status: "failed", errors: "report 未完" } }),
      );

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("verdict を解決できない error");
      expect(result.reasons.join("\n")).toContain("round=3");
      // condition（attemptResult を持たない）は effort.json の round で上限判定する
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(true);
    });

    it("verdict を解決できない error でも effort.json round < 3 なら error のまま復旧経路へ載せる", () => {
      fakeGit();
      writeEffort({ round: 1 });
      const dbPath = writeWorkflowDb();
      const result = stepCheck("collect_verdict")(
        makeCtx({ attemptResult: { status: "failed", errors: "report 未完" } }),
      );

      expect(result.status).toBe("error");
      // 次ラウンドとして round を前進させ、反復回数を上限判定へ写像する
      expect(
        (
          JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
            round: number;
          }
        ).round,
      ).toBe(2);
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(false);
      expect(stepStatus(dbPath, "collect_verdict")).toBe("pending");
    });

    it("verdict.round が findings.round に追従しなくても実効ラウンドで上限到達を検出しエスカレーションする", () => {
      // verdict.round=1 のまま findings.round が 4 に前進したケース。verdict だけを見ると
      // 上限未到達 → execute_work 反復になる（終端しない）。実効ラウンド max で判定する。
      fakeGit();
      writeEffort({ round: 4 });
      const findings = {
        round: 4,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      const staleVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: false,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(staleVerdict));

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(staleVerdict) },
        }),
      );

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("実効ラウンド 4");
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(true);
    });

    it("round_limit_gate / round_limit_passed_gate は collect_verdict の後段にのみ置かれ、通常通過では condition が false", () => {
      const keys = def.steps.map((s) => s.key);
      for (const key of ["round_limit_gate", "round_limit_passed_gate"]) {
        expect(keys.indexOf(key)).toBeGreaterThan(keys.indexOf("collect_verdict"));
        expect(keys.indexOf(key)).toBeLessThan(keys.indexOf("finalize_done"));
      }

      const passedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(passedVerdict));
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      expect(def.steps.find((s) => s.key === "round_limit_gate")!.condition!(gateCtx)).toBe(false);
      expect(def.steps.find((s) => s.key === "round_limit_passed_gate")!.condition!(gateCtx)).toBe(
        false,
      );
    });

    it("daemon が block なのに verdict が pass 偽装なら fail (daemon 偽装検出)", () => {
      fakeGit();
      writeEffort();
      writeDifitState();
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      // daemon 出力（`mt difit check --dry-run` の stdout）と verdict を突合する契約。
      // validateVerdictJson は passed を読み、突合は passes / blocking_threads の
      // canonicalize 一致で行う（verdict 側に passes フィールドは存在しない）。
      const verdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      const daemonGate = {
        passes: false,
        blocking_threads: [{ id: "n1", taxonomy: "issue", body: "🐛 issue real", replies: [] }],
      };
      fakeMtDifitGate({
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
      expect(doneCalled()).toBe(false);
    });

    it("blocking_threads を改変した verdict は不一致 fail (daemon 偽装検出)", () => {
      fakeGit();
      writeEffort();
      writeDifitState();
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
        blocking_threads: [{ id: "n1", taxonomy: "issue", body: "🐛 issue real", replies: [] }],
      };
      fakeMtDifitGate({
        checkJson: JSON.stringify(daemonGate),
        checkExit: 1,
      });
      const tampered = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: false,
        blocking_threads: [
          { id: "n1", taxonomy: "issue", body: "🐛 issue rewritten", replies: [] },
        ],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(tampered));
      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(tampered) },
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("does not match");
      expect(doneCalled()).toBe(false);
    });

    it("verdict が無い/不正な場合は findings から合成せず error（削除した到達不能分岐の回帰検出）", () => {
      // verdict.json も subagentOutput も無い。旧実装は findings must=0 から
      // pass を合成していたが、origCheck の契約（pass = verdict 検証込み）に一本化した
      const findings = {
        round: 1,
        width: "medium",
        depth: "medium",
        findings: [],
        counts: { must: 0, should: 0, want: 0 },
      };
      fs.writeFileSync(path.join(sessionDir, "findings.json"), JSON.stringify(findings));

      const result = stepCheck("collect_verdict")(makeCtx());

      expect(result.status).toBe("error");
      expect(result.status).not.toBe("pass");
    });

    it("daemon と突合済みの blocked verdict は fail し execute_work 反復の理由を返す", () => {
      fakeGit();
      writeEffort();
      writeDifitState();
      writeFindings({ must: 0, should: 0, want: 0 });
      const blockedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: false,
        blocking_threads: [
          { id: "t1", taxonomy: "question", body: "⚠️ should real body", replies: [] },
        ],
      };
      const daemonGate = {
        passes: false,
        blocking_threads: [
          { id: "t1", taxonomy: "question", body: "⚠️ should real body", replies: [] },
        ],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(blockedVerdict));
      fakeMtDifitGate({ checkJson: JSON.stringify(daemonGate), checkExit: 1 });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(blockedVerdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("⚠️ should real body");
      expect(doneCalled()).toBe(false);
      expect(def.steps.find((s) => s.key === "collect_verdict")!.onFail).toEqual({
        action: "goto",
        target: "execute_work",
        requeueSource: true,
      });
    });

    it("非通過復旧（突合不一致）は次ラウンドとして round を前進させ、round 停滞の検出を招かない", () => {
      fakeGit();
      writeEffort({ round: 2 });
      writeFindings({ must: 1, should: 0, want: 0 }, 2);
      writeDifitState();
      const verdict = {
        round: 2,
        width: "medium",
        depth: "medium",
        passed: false,
        blocking_threads: [
          { id: "t1", taxonomy: "question", body: "⚠️ should real body", replies: [] },
        ],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(verdict));
      // daemon 側の blocking_threads を改変して突合不一致（非通過復旧）を作る
      fakeMtDifitGate({
        checkJson: JSON.stringify({
          passes: false,
          blocking_threads: [
            { id: "t1", taxonomy: "question", body: "⚠️ should rewritten", replies: [] },
          ],
        }),
        checkExit: 1,
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(verdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("does not match");
      // reset だけでは round が据え置かれ、次ラウンドの agent_verdict が停滞として
      // execute_work を反復する。復旧分岐でも blocked 経路と同じ写像で round を進める。
      const effort = JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: number;
      };
      expect(effort.round).toBe(3);
    });

    it("daemon の selection_drift.detection=detected なら done せず fail し、リビジョンセレクタ復旧手順を返す", () => {
      fakeGit();
      writeEffort();
      writeDifitState();
      writeFindings({ must: 0, should: 0, want: 0 });
      const passedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(passedVerdict));
      fakeMtDifitGate({
        checkJson: JSON.stringify({
          passes: true,
          blocking_threads: [],
          selection_drift: {
            detection: "detected",
            expected: { base: "1111111", target: "2222222", baseMode: "merge-base" },
            current: { base: "3333333", target: "4444444" },
          },
        }),
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(passedVerdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("リビジョンセレクタ");
      expect(result.reasons.join("\n")).toContain("起動時の選択");
      expect(result.reasons.join("\n")).toContain("resolve / reply");
      expect(doneCalled()).toBe(false);
    });

    it("daemon の selection_drift.detection=unavailable（probe 失敗）は fail-closed で fail する", () => {
      fakeGit();
      writeEffort();
      writeDifitState();
      writeFindings({ must: 0, should: 0, want: 0 });
      const passedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(passedVerdict));
      fakeMtDifitGate({
        checkJson: JSON.stringify({
          passes: true,
          blocking_threads: [],
          selection_drift: {
            detection: "unavailable",
            expected: { base: "1111111", target: "2222222" },
            current: null,
          },
        }),
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(passedVerdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("検知不能");
      expect(result.reasons.join("\n")).toContain("probe 失敗");
      expect(result.reasons.join("\n")).toContain("mt difit start");
      expect(doneCalled()).toBe(false);
    });

    it("check --dry-run の stderr（同一性照合エラー等）を fail 理由に伝搬する", () => {
      fakeGit();
      writeEffort();
      writeDifitState();
      writeFindings({ must: 0, should: 0, want: 0 });
      const passedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(passedVerdict));
      fakeMtDifitGate({
        checkJson: JSON.stringify({
          passes: false,
          blocking_threads: [{ id: "n1", taxonomy: "issue", body: "real", replies: [] }],
        }),
        checkExit: 1,
        checkStderr: "mt difit: 記録された pid が記録 port を LISTEN していません",
      });

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(passedVerdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("mt difit stderr:");
      expect(result.reasons.join("\n")).toContain("LISTEN していません");
      expect(doneCalled()).toBe(false);
    });

    it("check --dry-run がゲート出力を返さない（セッション不在）fail はレビューサイクルを再キューして round を前進させる", () => {
      fakeGit();
      writeEffort({ round: 1 });
      writeDifitState();
      writeFindings({ must: 0, should: 0, want: 0 });
      const passedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(passedVerdict));
      // checkJson 未指定 → check --dry-run が exit 1（ゲート出力なし）
      fakeMtDifitGate({});
      const dbPath = writeWorkflowDb();

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(passedVerdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("ゲート出力");
      // start_difit_review を含む review steps が pending に戻り、次ラウンドでセッションが復旧する
      expect(stepStatus(dbPath, "start_difit_review")).toBe("pending");
      expect(stepStatus(dbPath, "run_reviewers")).toBe("pending");
      expect(stepStatus(dbPath, "collect_verdict")).toBe("pending");
      // execute_work は resetReviewCycle の対象外（onFail の requeueSource が再キューする）
      expect(stepStatus(dbPath, "execute_work")).toBe("passed");
      // 復旧は次ラウンドとして round が前進する（据え置きは round 停滞の検出で
      // execute_work を反復するため、ここで写像を固定する）
      const effort = JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: number;
      };
      expect(effort.round).toBe(2);
    });

    it("done 実行時点のゲート非通過 fail はレビューサイクルを再キューして execute_work へ戻す", () => {
      fakeGit();
      writeEffort();
      writeFindings({ must: 0, should: 0, want: 0 });
      const passedVerdict = {
        round: 1,
        width: "medium",
        depth: "medium",
        passed: true,
        blocking_threads: [],
      };
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), JSON.stringify(passedVerdict));
      // 後始末後の pid 終了確認を通すため、生存しない pid を使う
      writeDifitState({ pid: 2147483647 });
      fakeMtDifitGate({
        checkJson: JSON.stringify({ passes: true, blocking_threads: [] }),
        doneJson: JSON.stringify({
          passes: false,
          blocking_threads: [
            {
              id: "h1",
              taxonomy: "human",
              file: "src/a.ts",
              line: 1,
              body: "追加の人間コメント",
              replies: [],
            },
          ],
        }),
      });
      const dbPath = writeWorkflowDb();

      const result = stepCheck("collect_verdict")(
        makeCtx({
          attemptResult: { status: "completed", subagentOutput: JSON.stringify(passedVerdict) },
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("非通過");
      // difit セッションは done で終了済み。次ラウンドの start_difit_review で再作成する
      expect(stepStatus(dbPath, "start_difit_review")).toBe("pending");
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(false);
    });
  });

  describe("release_difit_session (round limit 受容の後始末)", () => {
    it("round_limit_gate の直後（finalize_done より前）に置かれ、受容時のみ condition が true", () => {
      const keys = def.steps.map((s) => s.key);
      expect(keys.indexOf("release_difit_session")).toBeGreaterThan(
        keys.indexOf("round_limit_gate"),
      );
      expect(keys.indexOf("release_difit_session")).toBeLessThan(keys.indexOf("finalize_done"));

      const release = def.steps.find((s) => s.key === "release_difit_session")!;
      const gateCtx = { sessionDir, gateAnswers: {}, artifacts: [] };
      fs.writeFileSync(
        path.join(sessionDir, "verdict.json"),
        JSON.stringify({
          round: 3,
          width: "medium",
          depth: "medium",
          passed: false,
          blocking_threads: [],
        }),
      );
      expect(release.condition!(gateCtx)).toBe(true);
      fs.writeFileSync(
        path.join(sessionDir, "verdict.json"),
        JSON.stringify({
          round: 3,
          width: "medium",
          depth: "medium",
          passed: true,
          blocking_threads: [],
        }),
      );
      expect(release.condition!(gateCtx)).toBe(false);
    });

    it("task は readonly で、状態を変更せず report のみ行うことを指示する", () => {
      const step = def.steps.find((s) => s.key === "release_difit_session")!;
      expect(step.task!.readonly).toBe(true);
      const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
      expect(prompt).toContain("状態を変更しない");
      expect(prompt).toContain("read-only");
      expect(prompt).toContain("report のみ");
      expect(prompt).toContain("mt difit done");
      expect(prompt).toContain("実行しない");
      // 後始末は check が担う（task に状態確認・done 実行の work を残さない）
      expect(prompt).toContain("check");
      expect(prompt).not.toContain("有無を確認し、report する");
    });

    it("受容経路で mt difit done を実行し、state 消失を検証して pass する", () => {
      fakeGit();
      writeDifitState({ pid: 2147483647 });
      fakeMtDifitGate({});

      const result = stepCheck("release_difit_session")(makeCtx());

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("state removed");
      expect(doneCalled()).toBe(true);
      expect(fs.existsSync(path.join(tmp, "repo", ".difit", "difit-review.json"))).toBe(false);
    });

    it("done 前に控えた pid が生存していれば error（release 経路の orphan 検出）", () => {
      fakeGit();
      writeDifitState({ pid: process.pid });
      fakeMtDifitGate({});

      const result = stepCheck("release_difit_session")(makeCtx());

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("生存");
      expect(result.reasons.join("\n")).toContain(String(process.pid));
      expect(doneCalled()).toBe(true);
    });

    it("done 後も state ファイルが残っていれば error（後始末未完の検出）", () => {
      fakeGit();
      writeDifitState({ pid: 2147483647 });
      // state を削除しない done（後始末失敗のシミュレーション）
      writeScript(
        "mt",
        `[ "$1" = "difit" ] || exit 64
[ "$2" = "done" ] || exit 64
printf '%s\\n' '{"passes":true,"blocking_threads":[]}'
exit 0`,
      );

      const result = stepCheck("release_difit_session")(makeCtx());

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain(".difit/difit-review.json");
    });

    it("round_limit_gate の description / choices が後始末経路（approve=自動、abort=手動 done）を案内する", () => {
      const gate = def.steps.find((s) => s.key === "round_limit_gate")!;
      const question = gate.humanGate!.questions.find((q) => q.key === "decision")!;
      expect(question.description).toContain("mt difit done");
      expect(question.description).toContain("release_difit_session");
      const approve = question.choices!.find((c) => c.value === "approve")!;
      expect(approve.desc).toContain("release_difit_session");
      const abortChoice = question.choices!.find((c) => c.value === "abort")!;
      expect(abortChoice.desc).toContain("mt difit done");
      // 未通過前提の文言は未通過ゲートにのみ残る（通過済みは passed gate が担当）
      expect(question.description).toContain("未通過");
    });

    it("round_limit_passed_gate の description / choices が通過済みの後始末経路を案内し、未通過の文言を出さない", () => {
      const gate = def.steps.find((s) => s.key === "round_limit_passed_gate")!;
      const question = gate.humanGate!.questions.find((q) => q.key === "decision")!;
      expect(question.description).toContain("通過済み");
      expect(question.description).toContain("release_difit_session");
      expect(question.description).toContain("mt difit done");
      expect(question.description).not.toContain("未通過");
      const approve = question.choices!.find((c) => c.value === "approve")!;
      expect(approve.label).toContain("上限到達");
      expect(approve.label).toContain("通過済み");
      expect(approve.desc).toContain("release_difit_session");
      const abortChoice = question.choices!.find((c) => c.value === "abort")!;
      expect(abortChoice.desc).toContain("mt difit done");
      // 通過済みに「もう1巡（revise）」は提示しない
      expect(question.choices!.find((c) => c.value === "revise")).toBeUndefined();
      expect(gate.humanGate!.reviseTargetStep).toBeUndefined();
    });
  });
});

describe("execute_work (difit feedback)", () => {
  it("再実行時の修正ソースに人間ゲートの revise 理由（gateAnswers）と本セッション限定の読み取り手順を明記する", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-gate-answers-"));
    try {
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });
      expect(prompt).toContain("gateAnswers");
      expect(prompt).toContain("await_human_review");
      expect(prompt).toContain("answers_json");
      expect(prompt).toContain("修正理由");
      // workflow.db は全セッション共有のため、必ず session_id と confirmed で絞る
      // （別セッションの revise 入力が executor へ混入するのを機械的に防ぐ）
      expect(prompt).toContain(`session_id = '${path.basename(tmp)}'`);
      expect(prompt).toContain("event = 'confirmed'");
      // step_attempts 経由の読み取りも steps.session_id で本セッションに絞る
      expect(prompt).toContain("step_attempts");
      expect(prompt).toContain("steps.session_id");
      // 抽出結果は session ファイルへ保存し、check が DB と突合する
      expect(prompt).toContain("revise-feedback.json");
      expect(prompt).toContain(`${path.basename(tmp)}`);
      expect(prompt).toContain("sessionId");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("difit-check.json の blocking_threads を表示専用で使い、Rust 分類規則を写経しない", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-feedback-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          passes: false,
          blocking_threads: [
            {
              id: "t1",
              file: "src/a.ts",
              line: 10,
              taxonomy: "issue",
              body: "⚠️ should real body",
              replies: [],
            },
          ],
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      expect(prompt).toContain("difit の人間フィードバック");
      expect(prompt).toContain("⚠️ should real body");
      expect(prompt).toContain("taxonomy / blocking は Rust 判定の値をそのまま使う");
      expect(prompt).toContain("taxonomy == human");
      // 旧写経（author 判定・ヘッダトークン解釈）は残さない
      expect(prompt).not.toContain("親 author");
      expect(prompt).not.toContain("1 行目ヘッダ");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("difit-check.json の selection_drift.detection=detected なら executor フィードバックに復旧手順を表示する", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-drift-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          passes: true,
          blocking_threads: [],
          selection_drift: {
            detection: "detected",
            expected: { base: "1111111", target: "2222222", baseMode: "merge-base" },
            current: { base: "3333333", target: "4444444" },
          },
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      expect(prompt).toContain("選択ドリフト");
      expect(prompt).toContain("リビジョンセレクタ");
      expect(prompt).toContain("起動時の選択");
      expect(prompt).toContain("resolve");
      // drift が真なら passes=true でもフィードバックを返す（無音で通過させない）
      expect(prompt).toContain("difit の人間フィードバック");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("difit-check.json の selection_drift.detection=unavailable なら executor に検知不能と復旧依頼を表示する", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-unavailable-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          passes: true,
          blocking_threads: [],
          selection_drift: {
            detection: "unavailable",
            expected: { base: "1111111", target: "2222222" },
            current: null,
          },
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      expect(prompt).toContain("検知不能");
      expect(prompt).toContain("probe 失敗");
      expect(prompt).toContain("mt difit start");
      expect(prompt).toContain("difit の人間フィードバック");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("difit-check.json の selection_drift.detection=none はフィードバックを出さない（passes=true）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-none-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          passes: true,
          blocking_threads: [],
          selection_drift: {
            detection: "none",
            expected: { base: "1111111", target: "2222222" },
            current: { base: "1111111", target: "2222222" },
          },
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      expect(prompt).not.toContain("difit の人間フィードバック");
      expect(prompt).not.toContain("検知不能");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("difit-check.json の selection_drift 契約違反は passes=true でも無音にせず、resolve 禁止と復旧依頼を表示する", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-contract-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          passes: true,
          blocking_threads: [],
          // 解釈不能な selection_drift（旧形式）は parseDifitCheck が
          // selection_drift_error（契約違反マーカー）へ変換する
          selection_drift: { detection: "drifted" },
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      // driftFailure（detected / unavailable）と同じく、passes=true でも無音にしない
      expect(prompt).toContain("difit の人間フィードバック");
      expect(prompt).toContain("契約違反");
      expect(prompt).toContain("選択状態を検証できません");
      expect(prompt).toContain("drifted");
      expect(prompt).toContain("mt difit resolve");
      expect(prompt).toContain("mt difit start");
      // 同一性検証を迂回する port 直読み / difit CLI 直叩きは表示しない
      expect(prompt).not.toContain("difit comment resolve");
      expect(prompt).not.toContain("jq -r .port");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("done 出力（selection_drift 欠落・passes=false）は契約違反と誤診せず blocking フィードバックを返す", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-done-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          passes: false,
          blocking_threads: [
            {
              id: "h1",
              taxonomy: "human",
              file: "src/a.ts",
              line: 1,
              body: "追加の人間コメント",
              replies: [],
            },
          ],
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      expect(prompt).toContain("difit の人間フィードバック");
      expect(prompt).toContain("追加の人間コメント");
      // done は selection_drift を省略する正当な経路。フィールド欠落を契約違反と断定しない
      expect(prompt).not.toContain("契約違反");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes=true かつ blocking 非空の契約違反では blocking 一覧を無音で捨てず、契約違反として提示する", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-passes-blocking-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          // 契約では passes=true ⇒ blocking_threads 空。不整合出力を無音にしない
          passes: true,
          blocking_threads: [
            {
              id: "t1",
              taxonomy: "issue",
              file: "src/a.ts",
              line: 3,
              body: "契約違反 body",
              replies: [],
            },
          ],
          selection_drift: { detection: "none" },
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      expect(prompt).toContain("difit の人間フィードバック");
      expect(prompt).toContain("契約違反");
      expect(prompt).toContain("passes=true");
      // blocking 一覧が修正対象として残る（旧 2 段 early return の無音分岐を廃止）
      expect(prompt).toContain("契約違反 body");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("passes=false かつ blocking 空かつ drift なしはフィードバックを出さない（早期 return の 1 条件化）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-empty-"));
    try {
      fs.writeFileSync(
        path.join(tmp, "difit-check.json"),
        JSON.stringify({
          passes: false,
          blocking_threads: [],
          selection_drift: { detection: "none" },
        }),
      );
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      expect(prompt).not.toContain("difit の人間フィードバック");
      expect(prompt).not.toContain("契約違反");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolve 手順が mt difit resolve <threadId> に一本化され、port 直読み・difit CLI 直叩きを指示しない", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-resolve-"));
    try {
      const step = def.steps.find((s) => s.key === "execute_work")!;
      const prompt = step.task!.buildPrompt({ sessionDir: tmp, artifacts: [] });

      // state 読み取り → pid↔port LISTEN 照合 → 選択固定 resolve → 人間スレッド拒否を
      // 1 コマンド化した mt difit resolve だけを resolve 手段として指示する。
      expect(prompt).toContain("mt difit resolve <threadId>");
      expect(prompt).toContain("LISTEN");
      expect(prompt).toContain("人間コメントのスレッドは拒否");
      // 同一性検証を迂回する port 直読み / difit CLI 直叩きは指示しない
      expect(prompt).not.toContain("difit comment resolve");
      expect(prompt).not.toContain("jq -r .port");
      expect(prompt).not.toContain('--port "$PORT"');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("formatComment (GFM Markdown) snapshots", () => {
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
          // ヘッダは severity / taxonomy / axis の絵文字を含む
          const severityEmoji = { must: "🚨", should: "⚠️", want: "💡" }[severity];
          const taxonomyToken = severity === "must" ? "🐛 issue" : "🙋 question";
          expect(result.body).toMatch(new RegExp(`^\\*\\*${severityEmoji} ${severity} · `));
          expect(result.body).toContain(taxonomyToken);
          expect(result.body).toContain("**対象**:");
          expect(result.body).toContain("**詳細**:");
          if (withLine) {
            expect(result.body).toContain("`src/example.ts:42`");
          } else {
            expect(result.body).toContain("`src/example.ts`");
          }
          // 旧形式の [] プレフィックスと独自 markup は生成しない
          expect(result.body).not.toContain("[issue]");
          expect(result.body).not.toContain("[question]");
          expect(result.body).not.toContain("<box");
        });
      }
    }
  }

  it("keeps full detail in body (no truncation)", () => {
    const longDetail = "a".repeat(100) + " 詳細続き";
    const result = formatComment({
      severity: "must",
      axis: "req-2",
      detail: longDetail,
      filePath: "src/long.ts",
      line: 10,
    });
    expect(result.body).toContain(longDetail);
  });

  it("renders markdown without HTML escaping", () => {
    const result = formatComment({
      severity: "should",
      axis: "logic-1",
      detail: "if (a < b && c > d) { & check }",
      filePath: "src/escape.ts",
      line: 5,
    });
    expect(result.body).toContain("if (a < b && c > d) { & check }");
    expect(result.body).not.toContain("&lt;");
  });

  it("detail / suggestions の Markdown 画像・リンク記法を無害化する（外部 URL の自動取得防止）", () => {
    const result = formatComment({
      severity: "must",
      axis: "logic-2",
      detail:
        "差分引用: ![pixel](https://external.example/pixel.png) と [link](https://external.example/)",
      filePath: "src/link.ts",
      line: 5,
      suggestions: ["![s](https://external.example/s.png) を削除"],
    });
    // 画像 / リンクとして解釈されない（`[` / `]` がエスケープされる）
    expect(result.body).not.toContain("![pixel](");
    expect(result.body).toContain("!\\[pixel\\]");
    expect(result.body).not.toContain("[link](");
    expect(result.body).toContain("\\[link\\]");
    expect(result.body).not.toContain("![s](");
    expect(result.body).toContain("!\\[s\\]");

    // コードスパン内は Markdown 記法が解釈されないため表示を変えない
    const withCodeSpan = formatComment({
      severity: "want",
      axis: "logic-4",
      detail: "`threads[]` の配列操作",
      filePath: "src/code.ts",
      line: 1,
    });
    expect(withCodeSpan.body).toContain("`threads[]`");
  });

  it("renders suggestions as a bullet list when provided", () => {
    const result = formatComment({
      severity: "want",
      axis: "arch-1",
      detail: "改善提案あり",
      filePath: "src/with-suggest.ts",
      line: 7,
      suggestions: ["提案1: 変数名を明確化", "提案2: 関数を分割"],
    });
    expect(result.body).toContain("**提案**:");
    expect(result.body).toContain("- 提案1: 変数名を明確化");
    expect(result.body).toContain("- 提案2: 関数を分割");
  });

  it("omits 提案 section when suggestions empty", () => {
    const result = formatComment({
      severity: "must",
      axis: "req-1",
      detail: "詳細のみ",
      filePath: "src/no-suggest.ts",
      line: 1,
    });
    expect(result.body).not.toContain("**提案**:");
  });

  it("preserves multiline detail as plain markdown", () => {
    const result = formatComment({
      severity: "should",
      axis: "logic-3",
      detail: "1行目\n2行目\n3行目",
      filePath: "src/multi.ts",
      line: 3,
    });
    expect(result.body).toContain("1行目\n2行目\n3行目");
  });

  it("uses (ファイルレベル) target when filePath missing", () => {
    const result = formatComment({
      severity: "must",
      axis: "logic-1",
      detail: "ファイルレベル指摘",
    });
    expect(result.body).toContain("**対象**: (ファイルレベル)");
  });
});

describe("buildDifitComments integration", () => {
  it("generates difit thread imports for mixed axes with and without line", () => {
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
    const comments = buildDifitComments(review);
    // filePathなし / positionなし / old_side は除外され、new側のみが残る
    expect(comments).toHaveLength(2);
    for (const c of comments) {
      expect(c.type).toBe("thread");
      expect(typeof c.body).toBe("string");
      expect(c.filePath).toBeDefined();
      expect(c.position).toEqual({ side: "new", line: expect.any(Number) });
      expect(c.body as string).not.toContain("[");
      expect(c.body as string).toContain("**詳細**:");
    }
    const withLine = comments.find((c) => c.filePath === "src/a.ts");
    expect(withLine?.position).toEqual({ side: "new", line: 10 });
    const withLine2 = comments.find((c) => c.filePath === "src/d.ts");
    expect(withLine2?.position).toEqual({ side: "new", line: 99 });
    // filtered: b.ts / c.ts / e.ts は生成されない
    expect(comments.find((c) => c.filePath === "src/b.ts")).toBeUndefined();
    expect(comments.find((c) => c.filePath === "src/c.ts")).toBeUndefined();
    expect(comments.find((c) => c.filePath === "src/e.ts")).toBeUndefined();
    // snapshot for stability
    expect(comments).toMatchSnapshot();
  });

  it("renders suggestion into markdown body", () => {
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
    const comments = buildDifitComments(review);
    expect(comments).toHaveLength(1);
    expect(comments[0].body as string).toContain("- do X");
    expect(comments[0].body as string).toContain("- do Y");
  });

  it("returns empty array for invalid json", () => {
    expect(buildDifitComments(undefined)).toEqual([]);
    expect(buildDifitComments("not json")).toEqual([]);
    expect(buildDifitComments(JSON.stringify({ axes: null }))).toEqual([]);
  });

  it("body contains correct emoji mappings for all severities and axes", () => {
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
      expect(r.body).toContain(c.expectedEmoji);
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
      expect(r.body).toContain(c.emoji);
    }
  });
});
