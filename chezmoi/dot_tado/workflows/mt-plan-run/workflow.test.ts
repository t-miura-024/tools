import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import def from "./index.ts";
import { awaitHumanReviewStep } from "../mt-review-diff/index.ts";
import {
  buildDifitComments,
  REVIEW_ROUND_LIMIT,
  formatReviewComment as formatComment,
} from "../_shared/mt-review-helpers.ts";
import type { CheckCtx, ConditionCtx, PromptCtx, ArtifactRecord, GateAnswers } from "tado";
import type {
  StepDef,
  TaskStepDef,
  HumanGateStepDef,
  LoopStepDef,
} from "tado/types/workflow-def.ts";

/// loop 本体を再帰的に平坦化する（エンジンの flattenStepDefs と同じ順序）。
/// def.steps.find では loop 内のステップに到達できないため、テストはこの一覧を使う。
function flattenSteps(steps: StepDef[]): StepDef[] {
  const out: StepDef[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.type === "loop") out.push(...flattenSteps(step.body));
  }
  return out;
}

function findStep(key: string): StepDef {
  const step = flattenSteps(def.steps).find((s) => s.key === key);
  if (!step) throw new Error(`step not found: ${key}`);
  return step;
}

function taskStep(key: string): TaskStepDef {
  const step = findStep(key);
  if (step.type !== "task") throw new Error(`${key} is not a task step`);
  return step;
}

function gateStep(key: string): HumanGateStepDef {
  const step = findStep(key);
  if (step.type !== "human_gate") throw new Error(`${key} is not a human_gate step`);
  return step;
}

function loopStep(key: string): LoopStepDef {
  const step = findStep(key);
  if (step.type !== "loop") throw new Error(`${key} is not a loop step`);
  return step;
}

/// loop 行は実行ステップではないため check を持たない。loop 外から check を呼ぶテストは
/// このヘルパー経由で行い、loop 行の誤指定を型ではなく実行時エラーで検出する。
const stepCheck = (key: string) => {
  const step = findStep(key);
  if (step.type === "loop") throw new Error(`${key} is a loop step (has no check)`);
  return step.check;
};

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

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-workflow-"));
    binDir = path.join(tmp, "bin");
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(binDir);
    fs.mkdirSync(sessionDir);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
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

  function readEffortRound(): number {
    return (
      JSON.parse(fs.readFileSync(path.join(sessionDir, "effort.json"), "utf-8")) as {
        round: number;
      }
    ).round;
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
      threads?: Record<string, unknown>[];
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
    const lines = [`[ "$1" = "difit" ] || exit 64`];
    lines.push(`if [ "$2" = "threads" ]; then`, `  [ "$3" = "--json" ] || exit 65`);
    lines.push(
      `  printf '%s\\n' '${JSON.stringify({ passes: (options.threads ?? []).length === 0, blocking_threads: [], threads: options.threads ?? [], selection_drift: { detection: "none" } })}'`,
      `  exit 0`,
      `fi`,
    );
    lines.push(`if [ "$2" = "check" ]; then`);
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
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      attemptResult: { status: "completed" },
      artifacts: [],
      ...overrides,
    };
  }

  function makePromptCtx(overrides: Partial<PromptCtx> = {}): PromptCtx {
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      artifacts: [],
      ...overrides,
    };
  }

  function makeConditionCtx(overrides: Partial<ConditionCtx> = {}): ConditionCtx {
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      artifacts: [],
      ...overrides,
    };
  }

  /// decision 設問の gateAnswers（choice_with_input 形式）。
  function decisionAnswers(gateKey: string, value: string, input?: string): GateAnswers {
    return { [gateKey]: { decision: input === undefined ? { value } : { value, input } } };
  }

  /// tado の ArtifactRecord。requireStepArtifacts は report 申告済み（ctx.artifacts）の
  /// 成果物だけを読めるため、check テストは申告済みレコードを渡す。
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

  function writeVerdict(
    options: { round?: number; passed?: boolean; blocking?: boolean } = {},
  ): void {
    const blockingThreads =
      options.blocking === false
        ? []
        : [
            {
              id: "t1",
              taxonomy: "question",
              body: "⚠️ should body",
              replies: [],
            },
          ];
    fs.writeFileSync(
      path.join(sessionDir, "verdict.json"),
      JSON.stringify({
        round: options.round ?? 1,
        width: "medium",
        depth: "medium",
        passed: options.passed ?? false,
        blocking_threads: options.blocking === undefined ? [] : blockingThreads,
      }),
    );
  }

  function writeFeedback(items: Array<{ source: string; body: string }>): string {
    const filePath = path.join(sessionDir, "feedback.json");
    fs.writeFileSync(filePath, JSON.stringify({ items }));
    return filePath;
  }

  describe("loop structure (nested human/autonomous cycles)", () => {
    it("外側=人間サイクル / 内側=自律サイクルのネスト loop で、内側先頭が apply_feedback である", () => {
      const outer = loopStep("human_review_cycle");
      expect(outer.phase).toBe("人間サイクル");
      expect(outer.maxIterations).toBe(REVIEW_ROUND_LIMIT);
      expect(outer.onExhausted).toBe("escalate");
      const innerKey = outer.body.find((s) => s.key === "autonomous_review_cycle");
      if (!innerKey || innerKey.type !== "loop") {
        throw new Error("autonomous_review_cycle loop not found in human_review_cycle body");
      }
      expect(innerKey.phase).toBe("自律サイクル");
      expect(innerKey.maxIterations).toBe(REVIEW_ROUND_LIMIT);
      expect(innerKey.onExhausted).toBe("escalate");
      // 内側先頭は新設 apply_feedback（指摘統合＋修正指示組み立て）
      const head = innerKey.body[0];
      expect(head.key).toBe("apply_feedback");
      expect(head.type).toBe("task");
    });

    it("judge は各 loop 本体の末尾に置かれる（分岐点の一元化）", () => {
      const inner = loopStep("autonomous_review_cycle");
      expect(inner.body[inner.body.length - 1].key).toBe("collect_verdict");
      const outer = loopStep("human_review_cycle");
      expect(outer.body[outer.body.length - 1].key).toBe("judge_human");
    });

    it("上限受容ゲートと旧後始末は存在しない", () => {
      const keys = def.steps.map((s) => s.key);
      for (const key of ["round_limit_gate", "round_limit_passed_gate", "release_difit_session"]) {
        expect(keys).not.toContain(key);
      }
    });

    it("onFail に goto/target/reset/requeueSource が残っていない", () => {
      for (const step of flattenSteps(def.steps)) {
        if (step.type === "loop") continue;
        const serialized = JSON.stringify(step.onFail);
        expect(serialized).not.toContain("goto");
        expect(serialized).not.toContain("target");
        expect(serialized).not.toContain("reset");
        expect(serialized).not.toContain("requeueSource");
      }
    });

    it("全 human_gate から reviseTargetStep と revise 選択が撤去されている", () => {
      for (const step of flattenSteps(def.steps)) {
        if (step.type !== "human_gate") continue;
        expect(`reviseTargetStep` in step.humanGate).toBe(false);
        for (const question of step.humanGate.questions) {
          for (const choice of question.choices ?? []) {
            expect(choice.value).not.toBe("revise");
          }
        }
      }
    });

    it("loop 外ステップの check は continue を返さない（loop 外 continue の fail-fast）", () => {
      // エンジンは loop 外で返された continue を fail-fast させる。loop 内ステップ集合を
      // 定義から導出し、loop 外ステップの check 定義に判定 continue が混入していないことを固定する。
      // （新エンジン前提 loop/continue の fail-closed 検出。旧契約へのフォールバックは設けない）
      const inside = new Set<string>();
      const collect = (steps: StepDef[]) => {
        for (const s of steps) {
          inside.add(s.key);
          if (s.type === "loop") collect(s.body);
        }
      };
      for (const s of def.steps) if (s.type === "loop") collect(s.body);
      const outsideKeys = def.steps.filter((s) => s.type !== "loop").map((s) => s.key);
      expect(outsideKeys.length).toBeGreaterThan(0);
      for (const key of outsideKeys) {
        expect(stepCheck(key).toString()).not.toContain('"continue"');
      }
      // 対照: loop 内の継続判定（agent_verdict / collect_verdict）は continue を返す
      for (const key of ["agent_verdict"]) {
        expect(inside.has(key)).toBe(true);
        expect(stepCheck(key).toString()).toContain('"continue"');
      }
      // judge 系は 4 分岐（judgeGateRework）に委譲し、loop 内に置かれる
      for (const key of ["judge_human"]) {
        expect(inside.has(key)).toBe(true);
        expect(stepCheck(key).toString()).toContain("judgeGateRework");
      }
    });

    it("identify_plan は loop 外に置かれ、approve/abort のみ持つ（request_changes は巻き戻し不可のため撤去）", () => {
      expect(def.steps.find((s) => s.key === "identify_plan")!.type).toBe("human_gate");
      const question = gateStep("identify_plan").humanGate.questions.find(
        (q) => q.key === "decision",
      )!;
      const values = (question.choices ?? []).map((c) => c.value).sort();
      expect(values).toEqual(["abort", "approve"]);
      // やり直しは abort＋再実行へ誘導する（loop 外の continue は fail-fast）
      expect(question.description).toContain("再実行");
    });

    it("条件付き loop 内 human_gate の集合を固定する（skip registry の更新強制）", () => {
      // collectGateReworkRequests は全ゲートキーを動的走査する一方、skip 除外は
      // GATE_SKIP_CONDITIONS registry の固定表に依存する。新規 loop 内ゲート追加で
      // 表の更新を忘れると stale 回答が幽霊差し戻しになる。このテストは def 側の
      // 条件付き loop 内ゲート集合を固定し、追加時は registry 更新を強制する。
      // loop 外ゲートは登録対象外（request_changes が現れたら stale 扱いで捨てず fail）。
      const innerKeys = new Set<string>();
      for (const step of def.steps) {
        if (step.type !== "loop") continue;
        const walk = (body: StepDef[]): void => {
          for (const inner of body) {
            innerKeys.add(inner.key);
            if (inner.type === "loop") walk(inner.body);
          }
        };
        walk(step.body);
      }
      const conditionalInnerGates: string[] = [];
      for (const step of flattenSteps(def.steps)) {
        if (step.type !== "human_gate" || !innerKeys.has(step.key)) continue;
        if (step.condition !== undefined) conditionalInnerGates.push(step.key);
      }
      conditionalInnerGates.sort();
      expect(conditionalInnerGates).toEqual(["await_human_review"]);
    });

    it("loop 内 human_gate はいずれかの judge の走査対象にする（収集と作動の統合）", () => {
      // collect（collectGateReworkRequests）は全ゲートキーを動的走査する一方、
      // judge_autonomous / judge_human は固定ゲート読みである。新規 loop 内ゲートを
      // 追加して judge への配線を忘れると、新ゲートの差し戻しが作動しない。
      // このテストは def 側の loop 内ゲート集合を導出し、いずれかの judge の check
      // 定義が当該ゲートキーに言及していることを強制する（ai-2。追加時は judge 拡張）。
      const innerKeys = new Set<string>();
      for (const step of def.steps) {
        if (step.type !== "loop") continue;
        const walk = (body: StepDef[]): void => {
          for (const inner of body) {
            innerKeys.add(inner.key);
            if (inner.type === "loop") walk(inner.body);
          }
        };
        walk(step.body);
      }
      const innerGates: string[] = [];
      for (const step of flattenSteps(def.steps)) {
        if (step.type !== "human_gate" || !innerKeys.has(step.key)) continue;
        innerGates.push(step.key);
      }
      expect(innerGates.length).toBeGreaterThan(0);
      const judgeSources = [stepCheck("judge_human").toString()];
      for (const gateKey of innerGates) {
        expect(judgeSources.some((src) => src.includes(gateKey))).toBe(true);
      }
    });
  });

  describe("apply_feedback (inner loop head)", () => {
    const runApplyFeedbackCheck = (artifacts: ArtifactRecord[] = []) =>
      stepCheck("apply_feedback")(makeCtx({ artifacts }));

    it("feedback.json が無ければ fail（申告・実在の強制）", () => {
      expect(runApplyFeedbackCheck().status).toBe("fail");
    });

    it("feedback.json が不正なら fail", () => {
      fs.writeFileSync(path.join(sessionDir, "feedback.json"), "not json");
      const filePath = path.join(sessionDir, "feedback.json");
      expect(runApplyFeedbackCheck([artifactRecord("feedback.json", filePath)]).status).toBe(
        "fail",
      );

      fs.writeFileSync(path.join(sessionDir, "feedback.json"), JSON.stringify({ items: "x" }));
      expect(runApplyFeedbackCheck([artifactRecord("feedback.json", filePath)]).status).toBe(
        "fail",
      );

      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({ items: [{ source: "findings", body: "  " }] }),
      );
      const empty = runApplyFeedbackCheck([artifactRecord("feedback.json", filePath)]);
      expect(empty.status).toBe("fail");
      expect(empty.reasons.join("\n")).toContain("body");
    });

    it("items 空（初回）でも pass する", () => {
      const filePath = writeFeedback([]);

      const result = runApplyFeedbackCheck([artifactRecord("feedback.json", filePath)]);

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("指摘なし");
    });

    it("統合指示があれば件数を理由に載せて pass する", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、gate 差し戻しと
      // should 指摘の双方を原文被覆する items が必要（双方向の被覆検証）。
      writeFindings({ must: 0, should: 1, want: 0 });
      const filePath = writeFeedback([
        { source: "findings", body: "should detail 0" },
        { source: "gate:await_human_review", body: "修正理由の原文" },
      ]);

      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "修正理由の原文"),
        }),
      );

      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("2 件");
    });

    it("task が未完了なら error", () => {
      const result = stepCheck("apply_feedback")(
        makeCtx({ attemptResult: { status: "failed", errors: "boom" } }),
      );

      expect(result.status).toBe("error");
    });

    it("buildPrompt は gateAnswers の差し戻し原文と feedback.json 契約を示し、repo 編集と workflow.db を禁じる", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、差し戻しが prompt に載る。
      writeFindings({ must: 0, should: 0, want: 0 });
      const step = taskStep("apply_feedback");
      const prompt = step.task.buildPrompt(
        makePromptCtx({
          gateAnswers: {
            await_human_review: { decision: { value: "request_changes", input: "直す理由" } },
          },
        }),
      );
      expect(prompt).toContain("直す理由");
      expect(prompt).toContain("feedback.json");
      expect(prompt).toContain("リポジトリのファイルを編集しない");
      expect(prompt).toContain("workflow.db");
      expect(prompt).not.toContain("sqlite");
    });

    it("buildPrompt は追加入力の欠落を捏造せず、異常マーカーで記録する", () => {
      // stall 検出状態（must>0 かつ findings.round <= verdict.round）にし、
      // round_stall_gate の回答が skip 除外されないようにする（世代管理）。
      writeFindings({ must: 1, should: 0, want: 0 });
      writeVerdict({ round: 1 });
      const step = taskStep("apply_feedback");
      const prompt = step.task.buildPrompt(
        makePromptCtx({
          gateAnswers: { round_stall_gate: { decision: { value: "request_changes" } } },
        }),
      );
      expect(prompt).not.toContain("(追加入力なし)");
      expect(prompt).toContain("追加入力がありません");
    });

    it("buildPrompt は loop 外ゲートの差し戻しを統合対象外として記録する", () => {
      const step = taskStep("apply_feedback");
      const prompt = step.task.buildPrompt(
        makePromptCtx({
          gateAnswers: { identify_plan: { decision: { value: "request_changes", input: "直す" } } },
        }),
      );
      expect(prompt).toContain("identify_plan");
      expect(prompt).toContain("loop 外");
    });

    it("request_changes の追加入力が欠落したら fail する（捏造しない）", () => {
      // stall 検出状態にし、回答が skip 除外（stale 扱い）されないようにする。
      writeFindings({ must: 1, should: 0, want: 0 });
      writeVerdict({ round: 1 });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: { round_stall_gate: { decision: { value: "request_changes" } } },
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("追加入力");
    });

    it("空白のみの追加入力も欠落として fail する", () => {
      writeFindings({ must: 1, should: 0, want: 0 });
      writeVerdict({ round: 1 });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: decisionAnswers("round_stall_gate", "request_changes", "   "),
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("追加入力");
    });

    it("loop 外ゲートの request_changes は fail する（巻き戻し不可の無音消失を防ぐ）", () => {
      const filePath = writeFeedback([{ source: "gate:identify_plan", body: "直す理由" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: decisionAnswers("identify_plan", "request_changes", "直す理由"),
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("loop 外");
    });

    it("gate 差し戻しがあるのに items が空なら fail する（空素通り防止）", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、差し戻しが収集される。
      writeFindings({ must: 0, should: 0, want: 0 });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す理由"),
        }),
      );
      expect(result.status).toBe("fail");
    });

    it("findings must があるのに items が空なら fail する（空素通り防止）", () => {
      writeFindings({ must: 1, should: 0, want: 0 });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
    });

    it("verdict blocking があるのに items が空なら fail する（空素通り防止）", () => {
      writeVerdict({ round: 1, passed: false, blocking: true });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
    });

    it("gate 差し戻しの原文が items に含まれなければ fail する（欠落検出）", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、差し戻しが収集される。
      writeFindings({ must: 0, should: 0, want: 0 });
      const filePath = writeFeedback([{ source: "findings", body: "別件の指摘" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す理由の原文"),
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("原文");
    });

    it("gate 差し戻しの原文を gate:<stepKey> で含めば pass する（一般形の動的走査）", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、差し戻しが収集される。
      writeFindings({ must: 0, should: 0, want: 0 });
      const filePath = writeFeedback([
        { source: "gate:await_human_review", body: "直す理由の原文" },
      ]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す理由の原文"),
        }),
      );
      expect(result.status).toBe("pass");
    });

    it("未知の source 語彙は fail する（allowlist）", () => {
      const filePath = writeFeedback([{ source: "oracle", body: "捏造の指摘" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("語彙");
    });

    it("should-only は自律対象外のため items が空でも pass する", () => {
      // must のみ必須・should/want は任意。should 修正に起因する新規 must 発生での
      // 発散を断つため、must=0 should=2 の items=[] は素通りではなく正常系として pass。
      writeFindings({ must: 0, should: 2, want: 0 });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("pass");
    });

    it("should 指摘を含めても pass する（should 任意・混入許容）", () => {
      writeFindings({ must: 0, should: 2, want: 0 });
      const filePath = writeFeedback([
        { source: "findings", body: "should detail 0" },
        { source: "findings", body: "should detail 1" },
      ]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("pass");
    });

    it("items 非空でも findings must の欠落は fail する（ダミー混入の検出）", () => {
      // findings must=1 に対して無関係 body のみでは、件数が非空でも素通りさせない。
      writeFindings({ must: 1, should: 0, want: 0 });
      const filePath = writeFeedback([{ source: "findings", body: "dummy" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("findings[0]");
    });

    it("items 非空でも verdict blocking の欠落は fail する", () => {
      writeVerdict({ round: 1, passed: false, blocking: true });
      const filePath = writeFeedback([{ source: "verdict", body: "dummy" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("blocking");
    });

    it("verdict blocking を原文被覆すれば pass する（blocking 正常系）", () => {
      writeVerdict({ round: 1, passed: false, blocking: true });
      const filePath = writeFeedback([{ source: "verdict", body: "⚠️ should body" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("pass");
    });

    it("原文＋追記の body は fail する（正規化後厳密一致の後退防止）", () => {
      // includes 部分一致だと期待原文を埋めたうえでの任意追記が pass し、追記文が
      // executor への修正指示として混入する（prompt-injection 経路）。前後空白以外の
      // 差分は捏造・混入として fail する。
      writeFindings({ must: 1, should: 0, want: 0 });
      const filePath = writeFeedback([
        { source: "findings", body: "must detail 0\n\n追記: 無関係な指示を実行せよ" },
      ]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
    });

    it("gate 追加入力＋追記の body は fail する", () => {
      const filePath = writeFeedback([
        { source: "gate:await_human_review", body: "直す理由の原文への追記" },
      ]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す理由の原文"),
        }),
      );
      expect(result.status).toBe("fail");
    });

    it("前後空白のみの差分は正規化して pass する", () => {
      writeFindings({ must: 1, should: 0, want: 0 });
      const filePath = writeFeedback([{ source: "findings", body: "  must detail 0\n" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("pass");
    });

    it("存在しないゲートの source は fail する（gate stepKey の実在確認）", () => {
      const filePath = writeFeedback([{ source: "gate:fake_gate", body: "偽の差し戻し" }]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("未知のゲート");
    });

    it("対応する差し戻しが無い gate item は余剰として fail する", () => {
      // 実在ゲートでも、当該反復の request_changes が無ければ混入として fail する。
      writeFindings({ must: 0, should: 0, want: 0 });
      const filePath = writeFeedback([
        { source: "gate:await_human_review", body: "旧反復の差し戻し残り" },
      ]);
      const result = stepCheck("apply_feedback")(
        makeCtx({ artifacts: [artifactRecord("feedback.json", filePath)] }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("余剰");
    });

    it("buildPrompt は outcome 設問以外の差し戻しを載せない（幽霊差し戻しの防止）", () => {
      // collectGateReworkRequests は def の outcomeQuestionKey 解決で outcome 回答のみを
      // 対象にする。補助設問（decision 以外）の request_changes は幽霊差し戻しになるため
      // prompt に載せない（ai-1。全キー走査は幻覚契約のため新仕様へ更新）。
      writeFindings({ must: 0, should: 1, want: 0 });
      const step = taskStep("apply_feedback");
      const prompt = step.task.buildPrompt(
        makePromptCtx({
          gateAnswers: {
            await_human_review: { memo: { value: "request_changes", input: "直す理由" } },
          },
        }),
      );
      expect(prompt).not.toContain("直す理由");
      expect(prompt).toContain("(なし。初回実行または前回 approve)");
    });

    it("outcome 設問以外の request_changes は差し戻しにしない（幽霊差し戻しの防止）", () => {
      // def 登録ゲート（await_human_review の outcome は decision）の補助設問だけに
      // request_changes があっても、差し戻し対象にしない。items=[] で pass する。
      // decision 固定の旧実装ではなく outcome 解決の新仕様へ更新（ai-1）。
      writeFindings({ must: 0, should: 0, want: 0 });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: {
            await_human_review: { memo: { value: "request_changes", input: "直す理由" } },
          },
        }),
      );
      expect(result.status).toBe("pass");
      expect(result.reasons.join("\n")).toContain("指摘なし");
    });

    it("def 未登録ゲートの request_changes は全キー走査で検出する（見落としの fail-closed）", () => {
      // outcome 解決できないゲート（旧定義残留・直 craft）は decision 優先の全キー走査で
      // 検出し、items 空なら gate 欠落として fail する。
      writeFindings({ must: 0, should: 0, want: 0 });
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: {
            legacy_gate: { memo: { value: "request_changes", input: "直す理由" } },
          },
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("legacy_gate");
    });

    it("型不正の gate 回答は無視して throw しない（無検証 .value アクセスの防止）", () => {
      // GateAnswers 契約外の形状（null・value 非文字列）。旧実装は .value 直アクセスで
      // TypeError になり構造化 error/fail を迂回した。不正形は差し戻し無しとして扱う。
      const filePath = writeFeedback([]);
      const result = stepCheck("apply_feedback")(
        makeCtx({
          artifacts: [artifactRecord("feedback.json", filePath)],
          gateAnswers: {
            await_human_review: { decision: null },
          } as unknown as GateAnswers,
        }),
      );
      expect(result.status).toBe("pass");
    });
  });

  describe("judge_human (outer loop check)", () => {
    it("自律段階では完了へ進めない", () => {
      writeFindings({ must: 1, should: 0, want: 0 });

      const result = stepCheck("judge_human")(makeCtx());

      expect(result.status).toBe("error");
    });

    it("人相段階で未回答なら error（pass フォールバックなし）", () => {
      writeFindings({ must: 0, should: 1, want: 0 });

      const result = stepCheck("judge_human")(makeCtx());

      expect(result.status).toBe("error");
    });

    it("findings.json が不正なら condition は false（提示せず error へ一本化）で、judge_human の check は error", () => {
      // 不正時に condition が true を返すと、提示→回答→破棄の無駄な往復が固定される。
      // 不正は自律段階の異常であり、gate を提示せず judge_human の check が error で止める
      // （req-2。condition と check の共有関数の分離）。
      fs.writeFileSync(path.join(sessionDir, "findings.json"), "not json");

      expect(gateStep("await_human_review").condition!(makeConditionCtx())).toBe(false);

      const result = stepCheck("judge_human")(
        makeCtx({ gateAnswers: decisionAnswers("await_human_review", "approve") }),
      );

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("すり替え");
    });

    it("request_changes なら round を進めず continue する（人間 loop では進めない）", () => {
      writeEffort({ round: 1 });
      writeFindings({ must: 0, should: 1, want: 0 });

      const result = stepCheck("judge_human")(
        makeCtx({ gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す") }),
      );

      expect(result.status).toBe("continue");
      expect(result.reasons.join("\n")).toContain("human_review_cycle");
      expect(result.reasons.join("\n")).toContain("autonomous_review_cycle");
      expect(readEffortRound()).toBe(1);
    });

    it("judge_human は effort.json が無くても continue する（判定と前進の分離）", () => {
      // arch-1: 判定（decideGateRework の純粋写像）と round 前進（advanceReviewRound）は
      // 分離する。人間 loop の継続は前進しないため effort.json に触れず、欠落でも
      // continue する。自律 judge（judge_autonomous）は前進するため欠落では error
      // （対照テスト「round を前進できなければ error」）。
      writeFindings({ must: 0, should: 1, want: 0 });

      const result = stepCheck("judge_human")(
        makeCtx({ gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す") }),
      );

      expect(result.status).toBe("continue");
      expect(fs.existsSync(path.join(sessionDir, "effort.json"))).toBe(false);
    });

    it("未知値は fail する（pass へ丸めない）", () => {
      writeFindings({ must: 0, should: 1, want: 0 });

      const result = stepCheck("judge_human")(
        makeCtx({ gateAnswers: decisionAnswers("await_human_review", "hold") }),
      );

      expect(result.status).toBe("fail");
    });

    it("旧 revise 値は fail し、移行先を案内する（互換受理なし）", () => {
      writeFindings({ must: 0, should: 1, want: 0 });

      const result = stepCheck("judge_human")(
        makeCtx({ gateAnswers: decisionAnswers("await_human_review", "revise") }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("revise");
      expect(result.reasons.join("\n")).toContain("request_changes");
    });

    it("abort は未知値 fail と分離して error になる（中断意図の記録）", () => {
      writeFindings({ must: 0, should: 1, want: 0 });

      const result = stepCheck("judge_human")(
        makeCtx({ gateAnswers: decisionAnswers("await_human_review", "abort") }),
      );

      expect(result.status).toBe("error");
      expect(result.reasons.join("\n")).toContain("abort");
      expect(result.reasons.join("\n")).not.toContain("想定外");
    });

    it("型不正の回答値は TypeError にせず error になる（無検証 .value アクセスの防止）", () => {
      // GateAnswers 契約外の形状（null・value 非文字列）。旧実装は .value 直アクセスで
      // TypeError になり構造化 error を迂回した。不正形は未回答（undefined）として扱い、
      // pass フォールバックなしの error にする。
      writeFindings({ must: 0, should: 1, want: 0 });
      const malformed: GateAnswers[] = [
        { await_human_review: { decision: null } } as unknown as GateAnswers,
        { await_human_review: { decision: { value: 123 } } } as unknown as GateAnswers,
      ];
      for (const gateAnswers of malformed) {
        const result = stepCheck("judge_human")(makeCtx({ gateAnswers }));
        expect(result.status).toBe("error");
        expect(result.reasons.join("\n")).toContain("回答がありません");
      }
    });
  });

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
      const step = taskStep("start_difit_review");
      const prompt = step.task.buildPrompt(makePromptCtx());
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
    const step = () => taskStep("collect_context");

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

  describe("resolve_effort (human_gate 廃止 — Issue body コメント or medium/medium)", () => {
    it("human_gate を持たず task 型である", () => {
      const step = taskStep("resolve_effort");
      expect(step.type).toBe("task");
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

  describe("execute_work (loop 反復の round 前進なし)", () => {
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

    it("execution-result.json の申告があれば pass する（DB 検証なし）", () => {
      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
    });

    it("execution-result.json の申告が無ければ fail する", () => {
      const result = stepCheck("execute_work")(makeCtx());

      expect(result.status).toBe("fail");
    });

    it("round を前進させない（前進の主体は自律 loop の継続判定のみ）", () => {
      writeEffort({ round: 3 });
      writeVerdict({ round: 3 });

      const result = runExecuteWorkCheck();

      expect(result.status).toBe("pass");
      expect(readEffortRound()).toBe(3);
    });

    it("gate 差し戻しがあるのに feedback.json がなければ fail する（apply_feedback との接続）", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、差し戻しが収集される。
      writeFindings({ must: 0, should: 0, want: 0 });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({
          artifacts: [artifactRecord("execution-result.json", resultPath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す理由"),
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("feedback.json");
    });

    it("gate 差し戻しがあり feedback.json の items が非空なら pass する", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、差し戻しが収集される。
      writeFindings({ must: 0, should: 0, want: 0 });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({ items: [{ source: "gate:await_human_review", body: "直す理由" }] }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({
          artifacts: [artifactRecord("execution-result.json", resultPath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す理由"),
        }),
      );

      expect(result.status).toBe("pass");
    });

    it("buildPrompt は feedback.json を修正ソースの先頭に置き、workflow.db/sqlite を指示しない", () => {
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt(makePromptCtx());
      expect(prompt).toContain("feedback.json");
      expect(prompt).toContain("apply_feedback");
      expect(prompt).not.toContain("workflow.db");
      expect(prompt).not.toContain("sqlite");
      expect(prompt).not.toContain("revise-feedback");
    });

    it("gate 差し戻しの原文が items に無ければ非空でも fail する（被覆の再検証）", () => {
      // 人相段階（must=0）のため await_human_review は skip されず、差し戻しが収集される。
      writeFindings({ must: 0, should: 0, want: 0 });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({
          items: [{ source: "gate:await_human_review", body: "無関係な修正指示" }],
        }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({
          artifacts: [artifactRecord("execution-result.json", resultPath)],
          gateAnswers: decisionAnswers("await_human_review", "request_changes", "直す理由の原文"),
        }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("原文のまま");
    });

    it("findings must があるのに findings 対応が無ければ fail する（対応 source 強制）", () => {
      writeFindings({ must: 1, should: 0, want: 0 });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({ items: [{ source: "verdict", body: "⚠️ should body" }] }),
      );
      writeVerdict({ round: 1, passed: false, blocking: true });
      const result = stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("source=findings");
    });

    it("verdict blocking があるのに verdict 対応が無ければ fail する（対応 source 強制）", () => {
      writeVerdict({ round: 1, passed: false, blocking: true });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({ items: [{ source: "findings", body: "must detail" }] }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("source=verdict");
    });

    it("must/blocking の対応 source が揃えば pass する", () => {
      writeFindings({ must: 1, should: 0, want: 0 });
      writeVerdict({ round: 1, passed: false, blocking: true });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({
          items: [
            { source: "findings", body: "must detail 0" },
            { source: "verdict", body: "⚠️ should body" },
          ],
        }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );

      expect(result.status).toBe("pass");
    });

    it("findings should-only は自律対象外のため feedback.json が空でも pass する", () => {
      // apply_feedback は must のみ必須・should/want は任意。execute_work の needsFeedback も
      // must のみのため、should-only は接続検証の対象外として pass する。
      writeFindings({ must: 0, should: 1, want: 0 });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );

      expect(result.status).toBe("pass");
    });

    it("findings should-only でも findings 対応があれば pass する（任意混入の許容）", () => {
      writeFindings({ must: 0, should: 1, want: 0 });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({ items: [{ source: "findings", body: "should detail 0" }] }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );

      expect(result.status).toBe("pass");
    });

    it("findings must があるのに無関係 body のみなら非空でも fail する（dummy すり替えの検出）", () => {
      // logic-2: source 存在のみでは apply 通過後の差し替え（TOCTOU）や dummy が素通り
      // する。execute_work 側でも apply と同じ期待で厳密被覆を再検証する。
      writeFindings({ must: 1, should: 0, want: 0 });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({ items: [{ source: "findings", body: "dummy" }] }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("findings[0]");
    });

    it("verdict blocking があるのに無関係 body のみなら非空でも fail する", () => {
      writeVerdict({ round: 1, passed: false, blocking: true });
      const resultPath = path.join(sessionDir, "execution-result.json");
      fs.writeFileSync(
        resultPath,
        JSON.stringify({ changedFiles: [], checks: [], unresolvedIssues: [] }),
      );
      fs.writeFileSync(
        path.join(sessionDir, "feedback.json"),
        JSON.stringify({ items: [{ source: "verdict", body: "dummy" }] }),
      );
      const result = stepCheck("execute_work")(
        makeCtx({ artifacts: [artifactRecord("execution-result.json", resultPath)] }),
      );

      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("blocking");
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
    const conditionOf = () => gateStep("await_human_review").condition!;

    it("condition: 自律ループ中（must>0）は false（engine が human gate を skip する）", () => {
      writeFindings({ must: 1, should: 0, want: 0 });

      expect(conditionOf()(makeConditionCtx())).toBe(false);
    });

    it("condition: must=0 の人相段階は true（human gate を実行する）", () => {
      writeFindings({ must: 0, should: 1, want: 0 });

      expect(conditionOf()(makeConditionCtx())).toBe(true);
    });

    it("condition: findings.json を読めない場合は false（提示せず judge の error へ一本化）", () => {
      // 不正・欠落は自律段階の異常であり、人間レビューにすり替えない。gate を提示せず、
      // judge_human の check が findings を再検証して error で止める（req-2）。
      expect(conditionOf()(makeConditionCtx())).toBe(false);
    });

    it("condition は plan-run が override する（mt-review-diff の step は condition を持たず単独では常に提示）", () => {
      const step = gateStep("await_human_review");
      expect(awaitHumanReviewStep.condition).toBeUndefined();
      expect(step.condition).toBeDefined();
      expect(step.condition).not.toBe(awaitHumanReviewStep.condition);
    });

    it("reviseTargetStep を持たず、request_changes が judge_human 経由の差し戻しを案内する", () => {
      const step = gateStep("await_human_review");
      // mt-review-diff 単独では reviseTargetStep を持たない（plan-run も付与しない）
      expect("reviseTargetStep" in awaitHumanReviewStep.humanGate!).toBe(false);
      expect("reviseTargetStep" in step.humanGate).toBe(false);
      const question = step.humanGate.questions.find((q) => q.key === "decision")!;
      expect(question.choices!.find((c) => c.value === "revise")).toBeUndefined();
      const requestChanges = question.choices!.find((c) => c.value === "request_changes")!;
      expect(requestChanges.input?.required).toBe(true);
      // 入力した修正理由の消費先（gateAnswers → apply_feedback の feedback.json）を案内する
      expect(requestChanges.desc).toContain("judge_human");
      expect(requestChanges.desc).toContain("feedback.json");
      expect(awaitHumanReviewStep.humanGate!.questions[0].choices).not.toBe(question.choices);
    });

    it("人間サイクル（外側 loop 本体）に置かれる", () => {
      const outer = loopStep("human_review_cycle");
      expect(outer.body.some((s) => s.key === "await_human_review")).toBe(true);
      const inner = loopStep("autonomous_review_cycle");
      expect(inner.body.some((s) => s.key === "await_human_review")).toBe(false);
    });
  });

  describe("自律上限から人間レビューへの引き渡し", () => {
    const humanAnswers = (value: string) =>
      decisionAnswers("await_human_review", value, "修正してください");
    function prepare(round: number, must = 0, should = 0) {
      fakeGit();
      writeDifitState({ pid: 99999999 });
      writeEffort({ round });
      writeFindings({ must, should, want: 1 }, round);
    }
    async function normalizeClock(iteration: number) {
      await taskStep("normalize_findings").beforeStep!({
        ...makePromptCtx(),
        stepKey: "normalize_findings",
        attemptNumber: 1,
        loop: { key: "autonomous_review_cycle", iteration, maxIterations: REVIEW_ROUND_LIMIT },
      });
    }
    function thread(taxonomy: string) {
      return {
        id: "t1",
        taxonomy,
        blocking: true,
        filePath: "src/a.ts",
        body: "remaining",
        replies: [],
      };
    }

    it("自律5ラウンドを消費すると既存登録・verdict検証後に人間ゲートへ進む", async () => {
      prepare(1, 1, 1);
      for (let round = 1; round <= REVIEW_ROUND_LIMIT; round++) {
        await normalizeClock(round);
        expect(readEffortRound()).toBe(round);
        writeFindings({ must: 1, should: 1, want: 1 }, round);
        expect(stepCheck("agent_verdict")(makeCtx()).status).toBe(
          round < REVIEW_ROUND_LIMIT ? "continue" : "pass",
        );
      }
      writeVerdict({ round: REVIEW_ROUND_LIMIT, passed: false, blocking: true });
      fakeMtDifitGate({
        checkJson: JSON.stringify({
          passes: false,
          blocking_threads: [
            { id: "t1", taxonomy: "question", body: "⚠️ should body", replies: [] },
          ],
        }),
      });
      expect(stepCheck("collect_verdict")(makeCtx()).status).toBe("pass");
      expect(doneCalled()).toBe(false);
      expect(gateStep("await_human_review").condition!(makeConditionCtx())).toBe(true);
      const keys = loopStep("autonomous_review_cycle").body.map((step) => step.key);
      expect(keys.slice(keys.indexOf("agent_verdict"))).toEqual([
        "agent_verdict",
        "start_difit_review",
        "collect_verdict",
      ]);
    });

    it("must=0・should/want残存でも自律反復せず人間へ渡しセッションを保持する", () => {
      prepare(1, 0, 1);
      writeVerdict({ round: 1, passed: false, blocking: true });
      fakeMtDifitGate({
        checkJson: JSON.stringify({
          passes: false,
          blocking_threads: [
            { id: "t1", taxonomy: "question", body: "⚠️ should body", replies: [] },
          ],
        }),
      });
      expect(stepCheck("agent_verdict")(makeCtx()).status).toBe("pass");
      expect(stepCheck("collect_verdict")(makeCtx()).status).toBe("pass");
      expect(doneCalled()).toBe(false);
      expect(gateStep("await_human_review").condition!(makeConditionCtx())).toBe(true);
    });

    it("通過済みverdictでも人間承認前にcleanupしない", () => {
      prepare(2);
      writeVerdict({ round: 2, passed: true, blocking: false });
      fakeMtDifitGate({ checkJson: '{"passes":true,"blocking_threads":[]}' });
      expect(stepCheck("collect_verdict")(makeCtx()).status).toBe("pass");
      expect(doneCalled()).toBe(false);
    });

    it("人間差し戻し1〜4回後の自律予算は1から5で、round更新は冪等", async () => {
      prepare(5, 1);
      fakeMtDifitGate();
      // 人間1〜4回目の差し戻し。外側 loop の continue が内側 iteration を1へ戻すため、
      // 自律ラウンドは毎回 1 から数え直される（同じフック再実行でも加算しない）。
      for (let human = 1; human < REVIEW_ROUND_LIMIT; human++) {
        writeFindings({ must: 1, should: 0, want: 0 }, 5);
        expect(
          stepCheck("judge_human")(makeCtx({ gateAnswers: humanAnswers("request_changes") }))
            .status,
        ).toBe("continue");
        expect(doneCalled()).toBe(false);
        for (let round = 1; round <= REVIEW_ROUND_LIMIT; round++) {
          await normalizeClock(round);
          await normalizeClock(round);
          expect(readEffortRound()).toBe(round);
          writeFindings({ must: 1, should: 0, want: 0 }, round);
          expect(stepCheck("agent_verdict")(makeCtx()).status).toBe(
            round === REVIEW_ROUND_LIMIT ? "pass" : "continue",
          );
        }
      }
    });

    it("実tado next/reportで自律5回×人間5回を進め、最後の差し戻しだけpausedになる", () => {
      const engineHome = path.join(tmp, "engine");
      const workflowDir = path.join(engineHome, "workflows", "round-limit-contract");
      fs.mkdirSync(workflowDir, { recursive: true });
      // 外部作業・人間のTTY入力は対象外。実defのloop設定・roundフック・判定を再利用し、
      // findings生成とrequest_changes入力だけをfixture化する。DBの手動更新は行わない。
      fs.writeFileSync(
        path.join(workflowDir, "index.ts"),
        `
import def from ${JSON.stringify(path.join(import.meta.dir, "index.ts"))};
const human = def.steps.find(s => s.key === "human_review_cycle");
const autonomous = human.body.find(s => s.key === "autonomous_review_cycle");
const normalize = autonomous.body.find(s => s.key === "normalize_findings");
const verdict = autonomous.body.find(s => s.key === "agent_verdict");
const judge = human.body.find(s => s.key === "judge_human");
const task = { action: "orchestrate", buildPrompt: () => "boundary test" };
export default {
  id: "round-limit-contract",
  steps: [{ ...human, body: [
    { ...autonomous, body: [
      { ...normalize, task, check: () => ({ status: "pass", reasons: [] }) },
      { ...verdict, task },
    ] },
    { ...judge, task, check: ctx => judge.check({ ...ctx, gateAnswers: {
      await_human_review: { decision: { value: "request_changes", input: "test fixture" } },
    } }) },
  ] }],
};
`,
      );
      const cli = path.resolve(
        path.dirname(fileURLToPath(import.meta.resolve("tado"))),
        "../cli/main.ts",
      );
      const run = (args: string[], input?: object) => {
        const result = Bun.spawnSync([process.execPath, cli, ...args], {
          env: { ...process.env, TADO_HOME: engineHome },
          stdin: input ? Buffer.from(JSON.stringify(input)) : undefined,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return JSON.parse(result.stdout.toString());
      };
      const initialized = run([
        "init",
        "--workflow",
        "round-limit-contract",
        "--title",
        "boundary test",
      ]);
      const sessionArgs = ["--session", initialized.sessionId];
      const effortPath = path.join(initialized.sessionDir, "effort.json");
      fs.writeFileSync(effortPath, JSON.stringify({ round: 1 }));
      const report = (stepKey: string) =>
        run(["report", ...sessionArgs], { stepKey, status: "completed" });
      for (let human = 1; human <= REVIEW_ROUND_LIMIT; human++) {
        for (let round = 1; round <= REVIEW_ROUND_LIMIT; round++) {
          const next = run(["next", ...sessionArgs]);
          expect(next.stepKey).toBe("normalize_findings");
          expect(next.context.loop.iteration).toBe(round);
          const effort = JSON.parse(fs.readFileSync(effortPath, "utf-8"));
          expect(effort.round).toBe(round);
          writeFindings({ must: 1, should: 0, want: 0 }, effort.round);
          fs.copyFileSync(
            path.join(sessionDir, "findings.json"),
            path.join(initialized.sessionDir, "findings.json"),
          );
          expect(report("normalize_findings").nextAction).toBe("continue");
          expect(run(["next", ...sessionArgs]).stepKey).toBe("agent_verdict");
          expect(report("agent_verdict").nextAction).toBe(
            round < REVIEW_ROUND_LIMIT ? "repeat" : "continue",
          );
        }
        const next = run(["next", ...sessionArgs]);
        expect(next.stepKey).toBe("judge_human");
        expect(next.context.loop.iteration).toBe(human);
        const result = report("judge_human");
        expect(result.checkResult.status).toBe("continue");
        expect(result.nextAction).toBe(human < REVIEW_ROUND_LIMIT ? "repeat" : "escalate");
        expect(run(["status", ...sessionArgs]).sessionStatus).toBe(
          human < REVIEW_ROUND_LIMIT ? "running" : "paused",
        );
      }
    }, 30_000);

    it("findingsにmustが残っていても人間が最新difitで解決済みなら承認・cleanupできる", () => {
      prepare(5, 1);
      fakeMtDifitGate({ threads: [thread("question"), thread("want")] });
      expect(
        stepCheck("judge_human")(makeCtx({ gateAnswers: humanAnswers("approve") })).status,
      ).toBe("pass");
      expect(doneCalled()).toBe(true);
    });

    it("doneがshould/wantだけで非通過ならmust=0として承認できる", () => {
      prepare(5, 1);
      fakeMtDifitGate({
        threads: [thread("question"), thread("want")],
        doneJson: JSON.stringify({
          passes: false,
          blocking_threads: [
            { id: "t8", taxonomy: "question", body: "should", replies: [] },
            { id: "t9", taxonomy: "want", body: "want", replies: ["human reply"] },
          ],
        }),
      });
      expect(
        stepCheck("judge_human")(makeCtx({ gateAnswers: humanAnswers("approve") })).status,
      ).toBe("pass");
      expect(doneCalled()).toBe(true);
    });

    it("doneが非通過かつblocking空（判定不能出力）なら検証済みでも承認しない", () => {
      prepare(5, 1);
      fakeMtDifitGate({
        threads: [thread("question")],
        doneJson: '{"passes":false,"blocking_threads":[]}',
      });
      const result = stepCheck("judge_human")(makeCtx({ gateAnswers: humanAnswers("approve") }));
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("ゲート結果を取得できていない");
      expect(doneCalled()).toBe(true);
    });

    it("done時点で未解決mustが追加されていれば承認しない", () => {
      prepare(5, 1);
      fakeMtDifitGate({
        threads: [thread("question")],
        doneJson: JSON.stringify({
          passes: false,
          blocking_threads: [{ id: "t9", taxonomy: "issue", body: "late must", replies: [] }],
        }),
      });
      const result = stepCheck("judge_human")(makeCtx({ gateAnswers: humanAnswers("approve") }));
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("未解決 must=1");
    });

    it("findingsがmust=0でも最新difitに未解決mustがあれば承認・cleanupしない", () => {
      prepare(1);
      fakeMtDifitGate({ threads: [thread("issue")] });
      const result = stepCheck("judge_human")(makeCtx({ gateAnswers: humanAnswers("approve") }));
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("未解決 must=1");
      expect(doneCalled()).toBe(false);
    });

    it("上限時も破損verdict・不一致・task失敗を人間レビューへの正常通過に変換しない", () => {
      prepare(5, 1);
      writeVerdict({ round: 5, passed: false, blocking: true });
      fakeMtDifitGate({ checkJson: '{"passes":true,"blocking_threads":[]}' });
      expect(stepCheck("collect_verdict")(makeCtx()).status).toBe("fail");
      expect(
        stepCheck("collect_verdict")(makeCtx({ attemptResult: { status: "failed" } })).status,
      ).toBe("error");
      fs.writeFileSync(path.join(sessionDir, "verdict.json"), "invalid");
      expect(stepCheck("collect_verdict")(makeCtx()).status).toBe("error");
      expect(doneCalled()).toBe(false);
    });

    it("finalize_doneは旧再計画artifactを要求せず承認後のIssue閉鎖を検証する", () => {
      writeScript("gh", `printf '%s\\n' '{"state":"CLOSED"}'`);
      const file = path.join(sessionDir, "plan-number.txt");
      fs.writeFileSync(file, "97");
      const result = stepCheck("finalize_done")(
        makeCtx({ artifacts: [artifactRecord("plan-number.txt", file)] }),
      );
      expect(result.status).toBe("pass");
      expect(taskStep("finalize_done").task.buildPrompt!(makePromptCtx())).not.toContain(
        "replan-plan-number",
      );
    });
  });
});

describe("execute_work (difit feedback)", () => {
  it("再実行時の修正ソースに feedback.json（apply_feedback の統合指示）を先頭に明記し、workflow.db を指示しない", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-feedback-"));
    try {
      const step = taskStep("apply_feedback");
      expect(step).toBeDefined();
      const execStep = taskStep("execute_work");
      const prompt = execStep.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });
      expect(prompt).toContain("feedback.json");
      expect(prompt).toContain("apply_feedback");
      expect(prompt).not.toContain("workflow.db");
      expect(prompt).not.toContain("sqlite");
      expect(prompt).not.toContain("revise-feedback");
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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

      expect(prompt).not.toContain("difit の人間フィードバック");
      expect(prompt).not.toContain("契約違反");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("resolve 手順が mt difit resolve <threadId> に一本化され、port 直読み・difit CLI 直叩きを指示しない", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-difit-resolve-"));
    try {
      const step = taskStep("execute_work");
      const prompt = step.task.buildPrompt({
        sessionDir: tmp,
        sessionId: path.basename(tmp),
        gateAnswers: {},
        loop: null,
        artifacts: [],
      });

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
