import { describe, it, expect } from "bun:test";
import def from "./index.ts";
import type { CheckCtx, ConditionCtx, PromptCtx, GateAnswers } from "tado";
import type {
  StepDef,
  TaskStepDef,
  HumanGateStepDef,
  LoopStepDef,
} from "tado/types/workflow-def.ts";

const LOOP_KEY = "candidate-cycle";
const HEAD_KEY = "brainstorm";
const GATE_KEY = "present-gate";
const JUDGE_KEY = "judge-present";
const EXHAUSTED_KEY = "present-exhausted-gate";

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
    sessionDir: "/tmp/mt-propose-test-session",
    sessionId: "test-session",
    gateAnswers: {},
    loop: null,
    attemptResult: { status: "completed" },
    artifacts: [],
    ...overrides,
  };
}

function makePromptCtx(overrides: Partial<PromptCtx> = {}): PromptCtx {
  return {
    sessionDir: "/tmp/mt-propose-test-session",
    sessionId: "test-session",
    gateAnswers: {},
    loop: null,
    artifacts: [],
    ...overrides,
  };
}

function makeConditionCtx(overrides: Partial<ConditionCtx> = {}): ConditionCtx {
  return {
    sessionDir: "/tmp/mt-propose-test-session",
    sessionId: "test-session",
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

describe("candidate_cycle (revise loop replacement)", () => {
  it("loop は maxIterations=3・onExhausted=escalate で、本体は作業→ゲート→judge の順である", () => {
    const loop = loopStep(LOOP_KEY);
    expect(loop.maxIterations).toBe(3);
    expect(loop.onExhausted).toBe("escalate");
    expect(loop.body.length).toBeGreaterThan(0);
    expect(loop.body.map((s) => s.key)).toEqual([
      HEAD_KEY,
      "dedup-check",
      "review-score",
      GATE_KEY,
      JUDGE_KEY,
    ]);
    expect(loop.body[loop.body.length - 1].key).toBe(JUDGE_KEY);
    expect(loop.body[0].key).toBe(HEAD_KEY);
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
          gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "視点を追加する"),
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
        gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "視点を追加する"),
        loop: judgeLoop(3),
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain(EXHAUSTED_KEY);
    expect(result.reasons.join("\n")).toContain("視点を追加する");
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

  it("judge は未回答・未知値（旧 revise 含む）を fail にし、移行先を案内する", () => {
    const missing = stepCheck(JUDGE_KEY)(makeCtx({ gateAnswers: {}, loop: judgeLoop(1) }));
    expect(missing.status).toBe("fail");
    const unknown = stepCheck(JUDGE_KEY)(
      makeCtx({ gateAnswers: decisionAnswers(GATE_KEY, "revise", "直す"), loop: judgeLoop(1) }),
    );
    expect(unknown.status).toBe("fail");
    expect(unknown.reasons.join("\n")).toContain("request_changes");
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
    expect(ghost.status).toBe("fail");
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

  it("枯渇 condition は request_changes のときのみ true である", () => {
    const condition = gateStep(EXHAUSTED_KEY).condition!;
    expect(condition(makeConditionCtx())).toBe(false);
    expect(condition(makeConditionCtx({ gateAnswers: decisionAnswers(GATE_KEY, "approve") }))).toBe(
      false,
    );
    expect(condition(makeConditionCtx({ gateAnswers: decisionAnswers(GATE_KEY, "abort") }))).toBe(
      false,
    );
    expect(
      condition(
        makeConditionCtx({ gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "直す") }),
      ),
    ).toBe(true);
  });

  it("枯渇 condition は他ゲートの回答を読まない", () => {
    const condition = gateStep(EXHAUSTED_KEY).condition!;
    expect(
      condition(
        makeConditionCtx({
          gateAnswers: {
            ...decisionAnswers(GATE_KEY, "approve"),
            ...decisionAnswers(EXHAUSTED_KEY, "request_changes", "旧回答"),
          },
        }),
      ),
    ).toBe(false);
  });

  it("枯渇ゲートは loop 外に置かれ、approve/abort のみ持つ", () => {
    expect(def.steps.some((s) => s.key === EXHAUSTED_KEY)).toBe(true);
    expect(def.steps.find((s) => s.key === EXHAUSTED_KEY)!.type).toBe("human_gate");
    const question = gateStep(EXHAUSTED_KEY).humanGate.questions.find((q) => q.key === "decision")!;
    const values = (question.choices ?? []).map((c) => c.value).sort();
    expect(values).toEqual(["abort", "approve"]);
  });

  it("confirm_done は対象外のため approve/abort のまま変更しない", () => {
    const question = gateStep("confirm-done").humanGate.questions.find(
      (q) => q.key === "decision",
    )!;
    const values = (question.choices ?? []).map((c) => c.value).sort();
    expect(values).toEqual(["abort", "approve"]);
  });

  it("judge は自 loop 外の文脈では error する", () => {
    const outside = stepCheck(JUDGE_KEY)(
      makeCtx({ gateAnswers: decisionAnswers(GATE_KEY, "approve"), loop: null }),
    );
    expect(outside.status).toBe("error");
    expect(outside.reasons.join("\n")).toContain(LOOP_KEY);
  });

  it("judge は overshoot 反復（iteration > max）でも pass で抜ける（fail-closed）", () => {
    const result = stepCheck(JUDGE_KEY)(
      makeCtx({
        gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "視点を追加する"),
        loop: judgeLoop(4),
      }),
    );
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain(EXHAUSTED_KEY);
  });

  it("先頭 worker の prompt は request_changes 追加入力を原文のまま注入する", () => {
    const buildPrompt = taskStep(HEAD_KEY).task.buildPrompt;
    const withFeedback = buildPrompt(
      makePromptCtx({
        gateAnswers: decisionAnswers(GATE_KEY, "request_changes", "視点を追加する"),
        loop: judgeLoop(2),
      }),
    );
    expect(withFeedback).toContain("視点を追加する");
    expect(withFeedback).toContain(`gate:${GATE_KEY}`);
    const initial = buildPrompt(makePromptCtx({ loop: judgeLoop(1) }));
    expect(initial).not.toContain("視点を追加する");
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
