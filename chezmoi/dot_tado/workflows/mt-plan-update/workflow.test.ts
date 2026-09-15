import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def from "./index.ts";
import type { CheckCtx, PromptCtx, GateAnswers } from "tado";
import type {
  StepDef,
  TaskStepDef,
  HumanGateStepDef,
  LoopStepDef,
} from "tado/types/workflow-def.ts";

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
  const step = def.steps.find((s) => s.key === key);
  if (!step || step.type !== "loop") throw new Error(`${key} is not a loop step`);
  return step;
}

describe("mt-plan-update workflow structure", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-update-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

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

  function answers(gateKey: string, value: string, input?: string): GateAnswers {
    return {
      [gateKey]: { decision: input === undefined ? { value } : { value, input } },
    };
  }

  function judgeCheck(judgeKey: string) {
    const step = findStep(judgeKey);
    if (step.type === "loop") throw new Error(`${judgeKey} is a loop step (has no check)`);
    return step.check;
  }

  function judgeCtx(
    loopKey: string,
    gateKey: string,
    value: string | undefined,
    input?: string,
    iteration = 1,
  ): CheckCtx {
    return makeCtx({
      gateAnswers: value === undefined ? {} : answers(gateKey, value, input),
      loop: { key: loopKey, iteration, maxIterations: 3 },
    });
  }

  it("analysis_cycle → analysis_exhausted → update_cycle → update_exhausted → update_issue → report の順序で動作する", () => {
    const keys = def.steps.map((s) => s.key);
    expect(keys).toEqual([
      "analysis_cycle",
      "analysis_exhausted",
      "update_cycle",
      "update_exhausted",
      "update_issue",
      "report",
    ]);
  });

  it("analysis_cycle の body は grill 先頭・judge 末尾である（旧 reviseTargetStep=grill）", () => {
    const loop = loopStep("analysis_cycle");
    expect(loop.maxIterations).toBe(3);
    expect(loop.onExhausted).toBe("escalate");
    expect(loop.body.map((s) => s.key)).toEqual(["grill", "confirm_analysis", "judge_analysis"]);
  });

  it("update_cycle の body は draft_body 先頭・judge 末尾である（旧 reviseTargetStep=draft_body）", () => {
    const loop = loopStep("update_cycle");
    expect(loop.maxIterations).toBe(3);
    expect(loop.onExhausted).toBe("escalate");
    expect(loop.body.map((s) => s.key)).toEqual(["draft_body", "confirm_update", "judge_update"]);
  });

  it("全 human_gate から reviseTargetStep と revise 選択が撤去されている", () => {
    for (const step of flattenSteps(def.steps)) {
      if (step.type !== "human_gate") continue;
      expect(`reviseTargetStep` in (step.humanGate ?? {})).toBe(false);
      for (const question of step.humanGate.questions) {
        for (const choice of question.choices ?? []) {
          expect(choice.value).not.toBe("revise");
        }
      }
    }
  });

  it("定義全体で step key は一意・loop body は非空である", () => {
    const keys = flattenSteps(def.steps).map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const step of def.steps) {
      if (step.type !== "loop") continue;
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  it("confirm_analysis / confirm_update は request_changes（input 必須）を持ち続ける", () => {
    for (const key of ["confirm_analysis", "confirm_update"]) {
      const gate = gateStep(key);
      const decision = gate.humanGate.questions.find((q) => q.key === "decision");
      const values = (decision?.choices ?? []).map((c) => c.value);
      expect(values).toEqual(["approve", "request_changes", "abort"]);
      const requestChanges = (decision?.choices ?? []).find((c) => c.value === "request_changes");
      expect(requestChanges?.input?.required).toBe(true);
    }
  });

  it("judge は approve→pass / request_changes→continue / abort→error / 未知・未回答→fail する", () => {
    const cases = [
      { judge: "judge_analysis", loop: "analysis_cycle", gate: "confirm_analysis" },
      { judge: "judge_update", loop: "update_cycle", gate: "confirm_update" },
    ] as const;
    for (const { judge, loop, gate } of cases) {
      const check = judgeCheck(judge);
      expect(check(judgeCtx(loop, gate, "approve", "補足")).status).toBe("pass");
      const continued = check(judgeCtx(loop, gate, "request_changes", "修正理由", 2));
      expect(continued.status).toBe("continue");
      expect(continued.reasons.join("\n")).toContain(`rewind ${loop}`);
      expect(check(judgeCtx(loop, gate, "abort")).status).toBe("error");
      expect(check(judgeCtx(loop, gate, "revise", "旧値")).status).toBe("fail");
      expect(check(judgeCtx(loop, gate, undefined)).status).toBe("fail");
      expect(check(judgeCtx(loop, gate, "request_changes", "")).status).toBe("fail");
    }
  });

  it("judge は最終反復の request_changes で枯渇マーカーを残して pass する", () => {
    const analysis = judgeCheck("judge_analysis")(
      judgeCtx("analysis_cycle", "confirm_analysis", "request_changes", "修正理由", 3),
    );
    expect(analysis.status).toBe("pass");
    const analysisMarker = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "analysis-cycle-exhausted.json"), "utf-8"),
    ) as { loop: string; gate: string; iteration: number };
    expect(analysisMarker).toEqual({
      loop: "analysis_cycle",
      gate: "confirm_analysis",
      iteration: 3,
    });
    const update = judgeCheck("judge_update")(
      judgeCtx("update_cycle", "confirm_update", "request_changes", "修正理由", 3),
    );
    expect(update.status).toBe("pass");
    const updateMarker = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "update-cycle-exhausted.json"), "utf-8"),
    ) as { loop: string; gate: string; iteration: number };
    expect(updateMarker).toEqual({ loop: "update_cycle", gate: "confirm_update", iteration: 3 });
  });

  it("judge は他ゲートの request_changes を拾わない（幽霊差し戻し防止）", () => {
    const result = judgeCheck("judge_analysis")(
      makeCtx({
        gateAnswers: {
          ...answers("confirm_analysis", "approve"),
          ...answers("confirm_update", "request_changes", "別ゲートの入力"),
        },
        loop: { key: "analysis_cycle", iteration: 1, maxIterations: 3 },
      }),
    );
    expect(result.status).toBe("pass");
  });

  it("judge は自 loop 外の文脈では error する", () => {
    const result = judgeCheck("judge_update")(
      makeCtx({
        gateAnswers: answers("confirm_update", "approve"),
        loop: { key: "analysis_cycle", iteration: 1, maxIterations: 3 },
      }),
    );
    expect(result.status).toBe("error");
    expect(result.reasons.join("\n")).toContain("update_cycle");
  });

  it("枯渇ゲートの condition は自 loop のマーカーでのみ true になる（相互隔離）", () => {
    const analysisGate = gateStep("analysis_exhausted");
    const updateGate = gateStep("update_exhausted");
    if (!analysisGate.condition || !updateGate.condition) {
      throw new Error("exhausted gates have no condition");
    }
    expect(analysisGate.condition(makeCtx())).toBe(false);
    expect(updateGate.condition(makeCtx())).toBe(false);
    fs.writeFileSync(
      path.join(sessionDir, "analysis-cycle-exhausted.json"),
      JSON.stringify({ loop: "analysis_cycle", gate: "confirm_analysis", iteration: 3 }),
    );
    expect(analysisGate.condition(makeCtx())).toBe(true);
    expect(updateGate.condition(makeCtx())).toBe(false);
    fs.writeFileSync(
      path.join(sessionDir, "update-cycle-exhausted.json"),
      JSON.stringify({ loop: "update_cycle", gate: "confirm_update", iteration: 3 }),
    );
    expect(updateGate.condition(makeCtx())).toBe(true);
  });

  it("枯渇ゲートは approve/abort のみを持ち request_changes を持たない", () => {
    for (const key of ["analysis_exhausted", "update_exhausted"]) {
      const gate = gateStep(key);
      const questions = gate.humanGate.questions;
      expect(questions.map((q) => q.key)).toEqual(["decision"]);
      expect(gate.humanGate.outcomeQuestionKey).toBe("decision");
      const values = (questions.find((q) => q.key === "decision")?.choices ?? []).map(
        (c) => c.value,
      );
      expect(values).toEqual(["approve", "abort"]);
    }
  });

  it("grill の prompt は confirm_analysis の追加入力を注入し、初回は「なし」とする", () => {
    const step = taskStep("grill");
    const withFeedback = step.task.buildPrompt(
      makePromptCtx({
        gateAnswers: answers("confirm_analysis", "request_changes", "前提を再検証すること"),
      }),
    );
    expect(withFeedback).toContain("前提を再検証すること");
    expect(withFeedback).toContain("confirm_analysis");
    expect(step.task.buildPrompt(makePromptCtx())).toContain("(なし。初回実行)");
  });

  it("draft_body の prompt は confirm_update の追加入力を注入し、初回は「なし」とする", () => {
    const step = taskStep("draft_body");
    const withFeedback = step.task.buildPrompt(
      makePromptCtx({
        gateAnswers: answers("confirm_update", "request_changes", "差分を修正すること"),
      }),
    );
    expect(withFeedback).toContain("差分を修正すること");
    expect(withFeedback).toContain("confirm_update");
    expect(step.task.buildPrompt(makePromptCtx())).toContain("(なし。初回実行)");
  });

  it("grill の prompt は他ゲートの差し戻しを注入しない", () => {
    const step = taskStep("grill");
    const prompt = step.task.buildPrompt(
      makePromptCtx({
        gateAnswers: answers("confirm_update", "request_changes", "別ゲートの入力"),
      }),
    );
    expect(prompt).not.toContain("別ゲートの入力");
    expect(prompt).toContain("(なし。初回実行)");
  });

  it("loop 外ステップの check は continue を返さない", () => {
    for (const key of ["analysis_exhausted", "update_exhausted", "update_issue", "report"]) {
      const step = findStep(key);
      if (step.type === "loop") throw new Error(`${key} is a loop step (has no check)`);
      expect(String(step.check)).not.toContain('"continue"');
    }
    // judge が唯一の continue 発生源であることは request_changes→continue の振る舞いテストで固定する。
    const result = judgeCheck("judge_analysis")(
      judgeCtx("analysis_cycle", "confirm_analysis", "request_changes", "修正理由", 1),
    );
    expect(result.status).toBe("continue");
  });
});
