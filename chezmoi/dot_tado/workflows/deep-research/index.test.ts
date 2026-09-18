import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def from "./index.ts";
import { GATE_SKIP_CONDITIONS } from "./helper/gate-skip-conditions.ts";
import { currentGateDecision } from "./helper/current-gate-decision.ts";
import type { CheckCtx, ConditionCtx, PromptCtx, GateAnswers } from "tado";
import type {
  StepDef,
  TaskStepDef,
  HumanGateStepDef,
  LoopStepDef,
} from "tado/types/workflow-def.ts";

const LOOP_KEY = "plan-approval-cycle";
const HEAD_KEY = "phase3-planner";
const GATE_KEY = "phase3b-plan-approval";
const JUDGE_KEY = "judge-plan-approval";
const EXHAUSTED_KEY = "plan-approval-exhausted-gate";

/// loop 本体を再帰的に平坦化する（エンジンの flattenStepDefs と同じ順序）。
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

/// loop 行は実行ステップではないため check を持たない。
const stepCheck = (key: string) => {
  const step = findStep(key);
  if (step.type === "loop") throw new Error(`${key} is a loop step (has no check)`);
  return step.check;
};

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

function judgeLoop(iteration: number): { key: string; iteration: number; maxIterations: number } {
  return { key: LOOP_KEY, iteration, maxIterations: 3 };
}

let tmp: string = "";
let sessionDir: string = "";

describe("plan-approval-cycle (revise loop replacement)", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-deep-research-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("loop は maxIterations=3・onExhausted=escalate で、本体は作業→ゲート→judge の順である", () => {
    const loop = loopStep(LOOP_KEY);
    expect(loop.maxIterations).toBe(3);
    expect(loop.onExhausted).toBe("escalate");
    expect(loop.body.length).toBeGreaterThan(0);
    expect(loop.body.map((s) => s.key)).toEqual([HEAD_KEY, GATE_KEY, JUDGE_KEY]);
    expect(loop.body[loop.body.length - 1].key).toBe(JUDGE_KEY);
  });

  it("定義全体で key は一意である", () => {
    const keys = flattenSteps(def.steps).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("内側ゲートは approve/request_changes/abort を持ち、request_changes は input 必須である", () => {
    const question = gateStep(GATE_KEY).humanGate.questions.find((q) => q.key === "decision")!;
    const values = (question.choices ?? []).map((c) => c.value).sort();
    expect(values).toEqual(["abort", "approve", "request_changes"]);
    const rc = (question.choices ?? []).find((c) => c.value === "request_changes")!;
    expect(rc.input?.required).toBe(true);
  });

  it("judge は approve を pass にする", () => {
    const result = stepCheck(JUDGE_KEY)(
      makeCtx({ gateAnswers: decisionAnswers(GATE_KEY, "approve"), loop: judgeLoop(1) }),
    );
    expect(result.status).toBe("pass");
  });

  it("judge は request_changes（追加入力あり・上限前）を continue にし、巻き戻し先を理由に載せる", () => {
    for (const iteration of [1, 2]) {
      const result = stepCheck(JUDGE_KEY)(
        makeCtx({
          gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "問いを増やす"),
          loop: judgeLoop(iteration),
        }),
      );
      expect(result.status).toBe("continue");
      expect(result.reasons.join("\n")).toContain(HEAD_KEY);
    }
  });

  it("judge は最終反復の request_changes を pass で抜け、枯渇ゲートへの受け渡しを理由に載せる", () => {
    const result = stepCheck(JUDGE_KEY)(
      makeCtx({
        gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "問いを増やす"),
        loop: judgeLoop(3),
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain(EXHAUSTED_KEY);
    expect(result.reasons.join("\n")).toContain("問いを増やす");
  });

  it("judge は request_changes の追加入力が空・欠落なら fail にする（軽量検証）", () => {
    for (const answers of [
      decisionAnswers(GATE_KEY, "request_changes", "   "),
      decisionAnswers(GATE_KEY, "request_changes"),
    ]) {
      const result = stepCheck(JUDGE_KEY)(makeCtx({ gateAnswers: answers, loop: judgeLoop(1) }));
      expect(result.status).toBe("fail");
    }
  });

  it("judge は abort を error にする", () => {
    const result = stepCheck(JUDGE_KEY)(
      makeCtx({ gateAnswers: decisionAnswers(GATE_KEY, "abort"), loop: judgeLoop(1) }),
    );
    expect(result.status).toBe("error");
  });

  it("judge は未回答を error・未知値（旧 revise 含む）を fail にし、移行先を案内する", () => {
    const missing = stepCheck(JUDGE_KEY)(makeCtx({ gateAnswers: {}, loop: judgeLoop(1) }));
    expect(missing.status).toBe("error");
    expect(missing.reasons.join("\n")).toContain("回答がありません");
    const unknown = stepCheck(JUDGE_KEY)(
      makeCtx({ gateAnswers: decisionAnswers(GATE_KEY, "revise", "直す"), loop: judgeLoop(1) }),
    );
    expect(unknown.status).toBe("fail");
    expect(unknown.reasons.join("\n")).toContain("request_changes");
  });

  it("judge は自 loop 外の文脈では error する", () => {
    const outside = stepCheck(JUDGE_KEY)(
      makeCtx({ gateAnswers: decisionAnswers(GATE_KEY, "approve"), loop: null }),
    );
    expect(outside.status).toBe("error");
    expect(outside.reasons.join("\n")).toContain(LOOP_KEY);
    const other = stepCheck(JUDGE_KEY)(
      makeCtx({
        gateAnswers: decisionAnswers(GATE_KEY, "approve"),
        loop: { key: "other-loop", iteration: 1, maxIterations: 3 },
      }),
    );
    expect(other.status).toBe("error");
  });

  it("judge は最終反復の request_changes で枯渇マーカーへ input を永続化する", () => {
    const result = stepCheck(JUDGE_KEY)(
      makeCtx({
        gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "問いを増やす"),
        loop: judgeLoop(3),
      }),
    );
    expect(result.status).toBe("pass");
    const marker = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "plan-approval-exhausted.json"), "utf-8"),
    ) as { loop: string; gate: string; iteration: number; input: string };
    expect(marker.loop).toBe(LOOP_KEY);
    expect(marker.gate).toBe(GATE_KEY);
    expect(marker.iteration).toBe(3);
    expect(marker.input).toBe("問いを増やす");
  });

  it("judge は overshoot 反復（iteration > max）でも枯渇マーカーを残して pass する（fail-closed）", () => {
    const result = stepCheck(JUDGE_KEY)(
      makeCtx({
        gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "問いを増やす"),
        loop: judgeLoop(4),
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain(EXHAUSTED_KEY);
  });

  it("judge は approve で stale マーカーを削除する", () => {
    fs.writeFileSync(
      path.join(sessionDir, "plan-approval-exhausted.json"),
      JSON.stringify({ loop: LOOP_KEY, gate: GATE_KEY, iteration: 3, input: "旧差し戻し" }),
    );
    const result = stepCheck(JUDGE_KEY)(
      makeCtx({ gateAnswers: decisionAnswers(GATE_KEY, "approve"), loop: judgeLoop(1) }),
    );
    expect(result.status).toBe("pass");
    expect(fs.existsSync(path.join(sessionDir, "plan-approval-exhausted.json"))).toBe(false);
  });

  it("judge は他ゲートの回答を拾わない（幽霊差し戻しを作らない）", () => {
    const ghost = stepCheck(JUDGE_KEY)(
      makeCtx({
        gateAnswers: {
          ...decisionAnswers("other_gate", "request_changes", "他ゲートの差し戻し"),
        },
        loop: judgeLoop(1),
      }),
    );
    expect(ghost.status).toBe("error");
    const approved = stepCheck(JUDGE_KEY)(
      makeCtx({
        gateAnswers: {
          ...decisionAnswers(GATE_KEY, "approve"),
          ...decisionAnswers("other_gate", "request_changes", "他ゲートの差し戻し"),
        },
        loop: judgeLoop(1),
      }),
    );
    expect(approved.status).toBe("pass");
  });

  it("judge は decideGateRework 定型に委譲し、当該ゲートを固定読みする", () => {
    const source = stepCheck(JUDGE_KEY).toString();
    expect(source).toContain("decideGateRework");
    expect(source).toContain(GATE_KEY);
    expect(source).toContain('"continue"');
  });

  it("枯渇 condition はマーカーがあるときのみ true である（gateAnswers 値のみでは判定しない）", () => {
    const condition = gateStep(EXHAUSTED_KEY).condition!;
    // マーカー不在では gateAnswers が request_changes でも false（正常 pass で非提示）
    expect(condition(makeConditionCtx())).toBe(false);
    expect(
      condition(
        makeConditionCtx({ gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "直す") }),
      ),
    ).toBe(false);
    // valid マーカーがあれば gateAnswers が空でも true
    fs.writeFileSync(
      path.join(sessionDir, "plan-approval-exhausted.json"),
      JSON.stringify({ loop: LOOP_KEY, gate: GATE_KEY, iteration: 3, input: "直す" }),
    );
    expect(condition(makeConditionCtx())).toBe(true);
  });

  it("枯渇 condition は別 loop・別 gate・iteration 不足・input 欠落・破損で throw する（fail-closed）", () => {
    const condition = gateStep(EXHAUSTED_KEY).condition!;
    for (const marker of [
      { loop: "other_loop", gate: GATE_KEY, iteration: 3, input: "直す" },
      { loop: LOOP_KEY, gate: "other_gate", iteration: 3, input: "直す" },
      { loop: LOOP_KEY, gate: GATE_KEY, iteration: 2, input: "直す" },
      { loop: LOOP_KEY, gate: GATE_KEY, iteration: 3 },
    ]) {
      fs.writeFileSync(
        path.join(sessionDir, "plan-approval-exhausted.json"),
        JSON.stringify(marker),
      );
      expect(() => condition(makeConditionCtx())).toThrow();
    }
    fs.writeFileSync(path.join(sessionDir, "plan-approval-exhausted.json"), "not-json");
    expect(() => condition(makeConditionCtx())).toThrow();
  });

  it("枯渇ゲートは loop 外に置かれ、approve/abort のみ持つ", () => {
    expect(def.steps.some((s) => s.key === EXHAUSTED_KEY)).toBe(true);
    expect(def.steps.find((s) => s.key === EXHAUSTED_KEY)!.type).toBe("human_gate");
    const question = gateStep(EXHAUSTED_KEY).humanGate.questions.find((q) => q.key === "decision")!;
    const values = (question.choices ?? []).map((c) => c.value).sort();
    expect(values).toEqual(["abort", "approve"]);
  });

  it("条件付きステップは registry に登録され、step の condition と同一関数である", () => {
    const conditional = flattenSteps(def.steps).filter(
      (s) => s.type !== "loop" && s.condition !== undefined,
    );
    expect(conditional.map((s) => s.key).sort()).toEqual([EXHAUSTED_KEY]);
    for (const step of conditional) {
      if (step.type === "loop") throw new Error("unreachable");
      const condition = step.condition;
      if (condition === undefined) throw new Error(`condition missing: ${step.key}`);
      expect(GATE_SKIP_CONDITIONS[step.key]).toBe(condition);
    }
  });

  it("currentGateDecision は skip ゲートの旧回答を拾わない（世代管理）", () => {
    const ctx = makeConditionCtx({
      gateAnswers: {
        ...decisionAnswers(GATE_KEY, "approve"),
        ...decisionAnswers(EXHAUSTED_KEY, "request_changes", "旧回答"),
      },
    });
    // 枯渇 condition が false（内側 approve）の世代では枯渇ゲートの旧回答は不可視
    expect(currentGateDecision(ctx.gateAnswers, ctx, EXHAUSTED_KEY)).toBeUndefined();
    // 内側ゲート（常時提示）は最新回答を読む
    expect(currentGateDecision(ctx.gateAnswers, ctx, GATE_KEY)).toBe("approve");
    const active = makeConditionCtx({
      gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "直す"),
    });
    expect(currentGateDecision(active.gateAnswers, active, GATE_KEY)).toBe("request_changes");
  });

  it("先頭 worker の prompt は request_changes 追加入力を原文のまま注入する", () => {
    const buildPrompt = taskStep(HEAD_KEY).task.buildPrompt;
    const withFeedback = buildPrompt(
      makePromptCtx({
        gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "問いを増やす"),
        loop: judgeLoop(2),
      }),
    );
    expect(withFeedback).toContain("問いを増やす");
    expect(withFeedback).toContain(`gate:${GATE_KEY}`);
    const initial = buildPrompt(makePromptCtx({ loop: judgeLoop(1) }));
    expect(initial).not.toContain("問いを増やす");
  });

  it("Phase 4 の prompt は枯渇マーカーの input を再提示し、枯渇なしでは「なし」とする", () => {
    const buildPrompt = taskStep("phase4-researcher").task.buildPrompt;
    const initial = buildPrompt(makePromptCtx());
    expect(initial).toContain("なし");
    fs.writeFileSync(
      path.join(sessionDir, "plan-approval-exhausted.json"),
      JSON.stringify({ loop: LOOP_KEY, gate: GATE_KEY, iteration: 3, input: "問いを増やす" }),
    );
    const exhausted = buildPrompt(makePromptCtx());
    expect(exhausted).toContain("問いを増やす");
    expect(exhausted).toContain("plan-approval-exhausted.json");
  });

  it("loop 外ステップの check は continue を返さない（loop 外 continue の fail-fast）", () => {
    const outsideKeys = def.steps.filter((s) => s.type !== "loop").map((s) => s.key);
    expect(outsideKeys.length).toBeGreaterThan(0);
    expect(outsideKeys).toContain(EXHAUSTED_KEY);
    for (const key of outsideKeys) {
      expect(stepCheck(key).toString()).not.toContain('"continue"');
    }
  });
});
