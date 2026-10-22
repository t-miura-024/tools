import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ArtifactRecord, CheckCtx, ConditionCtx, PromptCtx, StepCtx } from "tado";
import type {
  HumanGateStepDef,
  LoopStepDef,
  StepDef,
  TaskStepDef,
} from "tado/types/workflow-def.ts";
import def from "./index.ts";
import type { PlanReviewFinding, PlanReviewFindings } from "./helper/review-findings.ts";
import { computeCounts } from "./helper/review-findings.ts";
import { renderReviewBody } from "./helper/render-review-body.ts";
import { requireChildReviewIfChildrenExist } from "./helper/require-child-review-if-children-exist.ts";

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

const stepCheck = (key: string) => {
  const step = findStep(key);
  if (step.type === "loop") throw new Error(`${key} is a loop step (has no check)`);
  return step.check;
};

const stepCondition = (key: string) => {
  const step = findStep(key);
  if (step.type === "loop") throw new Error(`${key} is a loop step (has no condition)`);
  return step.condition;
};

interface FindingOverrides {
  severity?: PlanReviewFinding["severity"];
  perspective?: PlanReviewFinding["perspective"];
  type?: PlanReviewFinding["type"];
  target?: string;
  evidence?: string;
  problem?: string;
  proposedQuestion?: string | null;
  proposedOptions?: string[];
  proposedFix?: string | null;
}

function makeFindings(
  options: {
    round?: number;
    cycleRound?: number;
    reviewedTargets?: string[];
    findings?: FindingOverrides[];
  } = {},
): PlanReviewFindings {
  const round = options.round ?? 1;
  const cycleRound = options.cycleRound ?? 1;
  const reviewedTargets = options.reviewedTargets ?? ["issue-body.md"];
  const findings: PlanReviewFinding[] = (options.findings ?? []).map((override, index) => {
    const type = override.type ?? "decision";
    return {
      id: `R${round}-F${index + 1}`,
      severity: override.severity ?? "must",
      perspective: override.perspective ?? "A",
      type,
      target: override.target ?? "issue-body.md#§完了条件",
      evidence: override.evidence ?? "根拠",
      problem: override.problem ?? "問題",
      proposedQuestion:
        override.proposedQuestion !== undefined
          ? override.proposedQuestion
          : type === "mechanical"
            ? null
            : "質問",
      proposedOptions: override.proposedOptions ?? [],
      proposedFix:
        override.proposedFix !== undefined
          ? override.proposedFix
          : type === "mechanical"
            ? "修正"
            : null,
    };
  });
  return {
    reviewer: "mt-plan-reviewer",
    round,
    cycleRound,
    reviewedTargets,
    findings,
    counts: computeCounts(findings),
  };
}

describe("plan-create workflow structure", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-"));
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

  function makeStepCtx(overrides: Partial<StepCtx> = {}): StepCtx {
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      artifacts: [],
      stepKey: "review-body",
      attemptNumber: 1,
      ...overrides,
    };
  }

  function artifactRecord(key: string, filePath: string, stepKey = "test"): ArtifactRecord {
    return {
      id: 0,
      sessionId: path.basename(sessionDir),
      stepKey,
      artifactKey: key,
      filePath,
      createdAt: "2026-01-01 00:00:00",
    };
  }

  function writeSessionFile(name: string, content: string): string {
    const filePath = path.join(sessionDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function writeFindings(findings: PlanReviewFindings): string {
    return writeSessionFile("review-findings.json", JSON.stringify(findings, null, 2));
  }

  function writeReviewBody(findings: PlanReviewFindings): string {
    return writeSessionFile("review-body.md", renderReviewBody(findings));
  }

  function reviewBodyCtx(
    options: {
      findings?: PlanReviewFindings;
      children?: string[];
      owner?: string;
    } = {},
  ): CheckCtx {
    const issueBody = writeSessionFile(
      "issue-body.md",
      "## ✅ 完了条件\n\n- 条件\n\n## 🧭 方針\n\n方針\n",
    );
    const owner = options.owner ?? "someone";
    const repoInfoPath = writeSessionFile(
      "repo-info.json",
      JSON.stringify({ owner, repo: "x", nameWithOwner: `${owner}/x` }),
    );
    const findings =
      options.findings ??
      makeFindings({
        cycleRound: 1,
        reviewedTargets: ["issue-body.md", ...(options.children ?? [])],
      });
    const findingsPath = writeFindings(findings);
    const bodyPath = writeReviewBody(findings);
    for (const child of options.children ?? []) {
      writeSessionFile(child, "## ✅ 完了条件\n\n- 子条件\n");
    }
    return makeCtx({
      artifacts: [
        artifactRecord("issue-body.md", issueBody, "draft-body"),
        artifactRecord("repo-info.json", repoInfoPath, "after-init"),
        artifactRecord("review-findings.json", findingsPath, "review-body"),
        artifactRecord("review-body.md", bodyPath, "review-body"),
      ],
      loop: { key: "review-fix-cycle", iteration: findings.cycleRound, maxIterations: 3 },
    });
  }

  it("review-cycle → review-exhausted → create-refined → finalize の順序で動作する", () => {
    expect(def.steps.map((s) => s.key)).toEqual([
      "review-cycle",
      "review-exhausted",
      "create-refined",
      "finalize",
    ]);
  });

  it("外側 loop は review-fix-cycle 先頭・judge-review 末尾で最終承認を含む", () => {
    expect(loopStep("review-cycle").body.map((s) => s.key)).toEqual([
      "review-fix-cycle",
      "review-fix-exhausted",
      "judge-fix-exhausted",
      "prepare",
      "review-gate",
      "judge-review",
    ]);
  });

  it("内側 loop は grill → draft-body → review-body → judge-must の順序である", () => {
    expect(loopStep("review-fix-cycle").body.map((s) => s.key)).toEqual([
      "grill",
      "draft-body",
      "review-body",
      "judge-must",
    ]);
  });

  it("内側・外側とも上限 3・onExhausted=escalate である", () => {
    const inner = loopStep("review-fix-cycle");
    const outer = loopStep("review-cycle");
    expect(inner.maxIterations).toBe(3);
    expect(inner.onExhausted).toBe("escalate");
    expect(outer.maxIterations).toBe(3);
    expect(outer.onExhausted).toBe("escalate");
  });

  it("定義全体で step key は一意・loop body は非空である", () => {
    const keys = flattenSteps(def.steps).map((step) => step.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const step of flattenSteps(def.steps)) {
      if (step.type !== "loop") continue;
      expect(step.body.length).toBeGreaterThan(0);
    }
  });

  it("review-gate は最終承認として review-findings / review-decisions を提示する", () => {
    const gate = gateStep("review-gate");
    expect(gate.humanGate.presentArtifacts).toEqual([
      "issue-body.md",
      "review-body.md",
      "review-findings.json",
      "review-decisions.md",
      "prepare-decision.json",
    ]);
    const decision = gate.humanGate.questions.find((q) => q.key === "decision");
    const values = (decision?.choices ?? []).map((choice) => choice.value);
    expect(values).toEqual(["approve", "request_changes", "abort"]);
    const approve = (decision?.choices ?? []).find((choice) => choice.value === "approve");
    const requestChanges = (decision?.choices ?? []).find(
      (choice) => choice.value === "request_changes",
    );
    expect(approve?.desc ?? "").toContain("must");
    expect(requestChanges?.input?.required).toBe(true);
  });

  it("review-gate は must 残存時の承認不可を文言で明示する", () => {
    const gate = gateStep("review-gate");
    const decision = gate.humanGate.questions.find((q) => q.key === "decision");
    const approve = (decision?.choices ?? []).find((choice) => choice.value === "approve");
    expect(approve?.desc ?? "").toContain("ゼロが機械検証済み");
  });

  it("review-fix-exhausted は must 残存の承認を持たず retry / abort のみである", () => {
    const gate = gateStep("review-fix-exhausted");
    const question = gate.humanGate.questions[0];
    expect(question.key).toBe("decision");
    expect((question.choices ?? []).map((choice) => choice.value)).toEqual(["retry", "abort"]);
    expect(gate.condition).toBeDefined();
  });

  it("review-exhausted は approve / abort のみで request_changes を持たない", () => {
    const gate = gateStep("review-exhausted");
    const question = gate.humanGate.questions[0];
    expect((question.choices ?? []).map((choice) => choice.value)).toEqual(["approve", "abort"]);
    expect(gate.humanGate.presentArtifacts).toContain("review-findings.json");
    expect(gate.humanGate.presentArtifacts).toContain("review-decisions.md");
  });

  function reviewPromptCtx(): PromptCtx {
    writeSessionFile("issue-body.md", "## ✅ 完了条件\n\n- 条件\n\n## 🧭 方針\n\n方針\n");
    const repoInfoPath = writeSessionFile(
      "repo-info.json",
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    return makePromptCtx({
      artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
    });
  }

  it("review-body の buildPrompt は独立レビュアー起動を指示し、自己レビューを指示しない", () => {
    const step = taskStep("review-body");
    const prompt = step.task.buildPrompt(reviewPromptCtx());
    expect(prompt).toContain("mt-plan-reviewer");
    expect(prompt).toContain("起草者から独立");
    expect(prompt).toContain("指摘を自分で評価・取捨選択・修正しない");
    expect(prompt).not.toContain("SubAgent は使わず");
    expect(prompt).not.toContain("自己レビューし");
  });

  it("review-body の buildPrompt は 5 観点と全子 body を対象にする", () => {
    writeSessionFile("issue-body-1.md", "## ✅ 完了条件\n\n- 子条件\n");
    const prompt = taskStep("review-body").task.buildPrompt(reviewPromptCtx());
    expect(prompt).toContain("issue-body-1.md");
    expect(prompt).toContain("reviewedTargets");
    expect(prompt).toContain("plan-format");
  });

  it("review-body の check は valid な findings と review-body で pass する", () => {
    expect(stepCheck("review-body")(reviewBodyCtx()).status).toBe("pass");
  });

  it("review-body の check は findings 未申告で fail する", () => {
    const ctx = reviewBodyCtx();
    const result = stepCheck("review-body")(
      makeCtx({
        artifacts: ctx.artifacts.filter((a) => a.artifactKey !== "review-findings.json"),
        loop: ctx.loop,
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("review-findings.json");
  });

  it("review-body の check は子 body が reviewedTargets に無いと fail する", () => {
    const result = stepCheck("review-body")(
      reviewBodyCtx({
        findings: makeFindings({ cycleRound: 1, reviewedTargets: ["issue-body.md"] }),
        children: ["issue-body-1.md"],
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("issue-body-1.md");
  });

  it("review-body の check は存在しない reviewedTarget で fail する", () => {
    const result = stepCheck("review-body")(
      reviewBodyCtx({
        findings: makeFindings({
          cycleRound: 1,
          reviewedTargets: ["issue-body.md", "issue-body-9.md"],
        }),
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("存在しないファイル");
  });

  it("review-body の check は t-miura-024 以外の C 観点指摘で fail する", () => {
    const result = stepCheck("review-body")(
      reviewBodyCtx({
        owner: "someone",
        findings: makeFindings({ findings: [{ perspective: "C" }] }),
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("C 観点");
  });

  it("review-body の check は t-miura-024 の C 観点指摘を許可する", () => {
    const result = stepCheck("review-body")(
      reviewBodyCtx({
        owner: "t-miura-024",
        findings: makeFindings({ findings: [{ perspective: "C" }] }),
      }),
    );
    expect(result.status).toBe("pass");
  });

  it("review-body の check は cycleRound 不一致で fail する", () => {
    const ctx = reviewBodyCtx({ findings: makeFindings({ cycleRound: 2 }) });
    const result = stepCheck("review-body")({
      ...ctx,
      loop: { key: "review-fix-cycle", iteration: 1, maxIterations: 3 },
    });
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("cycleRound");
  });

  it("review-body の afterStep は生 JSON を正規化し review-body を生成する", async () => {
    writeSessionFile(
      "review-findings.json",
      JSON.stringify({
        reviewer: "mt-plan-reviewer",
        reviewedTargets: ["issue-body.md"],
        findings: [
          {
            severity: "must",
            perspective: "B",
            type: "decision",
            target: "issue-body.md#§完了条件",
            evidence: "完了条件が曖昧",
            problem: "完了条件が検証不能",
            proposedQuestion: "どう判定しますか",
            proposedOptions: ["A", "B", "C"],
          },
        ],
      }),
    );
    const step = taskStep("review-body");
    const artifacts = await step.afterStep!(
      makeStepCtx({ loop: { key: "review-fix-cycle", iteration: 1, maxIterations: 3 } }),
    );
    expect(artifacts.map((a) => a.key)).toEqual(["review-findings.json", "review-body.md"]);
    const normalized = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "review-findings.json"), "utf-8"),
    ) as PlanReviewFindings;
    expect(normalized.round).toBe(1);
    expect(normalized.cycleRound).toBe(1);
    expect(normalized.findings[0].id).toBe("R1-F1");
    expect(normalized.counts.must).toBe(1);
    expect(fs.readFileSync(path.join(sessionDir, "review-body.md"), "utf-8")).toContain(
      "## レビュー結果",
    );
    expect(fs.readFileSync(path.join(sessionDir, "review-round.txt"), "utf-8").trim()).toBe("1");
  });

  it("review-body の afterStep はコードフェンス付き JSON も受け付ける", async () => {
    writeSessionFile(
      "review-findings.json",
      "```json\n" +
        JSON.stringify({
          reviewer: "mt-plan-reviewer",
          reviewedTargets: ["issue-body.md"],
          findings: [],
        }) +
        "\n```",
    );
    const step = taskStep("review-body");
    await step.afterStep!(
      makeStepCtx({ loop: { key: "review-fix-cycle", iteration: 1, maxIterations: 3 } }),
    );
    const normalized = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "review-findings.json"), "utf-8"),
    ) as PlanReviewFindings;
    expect(normalized.counts.must).toBe(0);
  });

  it("review-body の afterStep は不正 JSON で throw する", async () => {
    writeSessionFile("review-findings.json", "not-json");
    const step = taskStep("review-body");
    await expect(
      step.afterStep!(
        makeStepCtx({ loop: { key: "review-fix-cycle", iteration: 1, maxIterations: 3 } }),
      ),
    ).rejects.toThrow();
  });
});

describe("plan-create grill decisions", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-grill-"));
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

  function artifactRecord(key: string, filePath: string): ArtifactRecord {
    return {
      id: 0,
      sessionId: path.basename(sessionDir),
      stepKey: "grill",
      artifactKey: key,
      filePath,
      createdAt: "2026-01-01 00:00:00",
    };
  }

  function writeSessionFile(name: string, content: string): string {
    const filePath = path.join(sessionDir, name);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function writeDecisions(content: string): string {
    return writeSessionFile("review-decisions.md", content);
  }

  function grillCtx(overrides: Partial<CheckCtx> = {}): CheckCtx {
    return makeCtx(overrides);
  }

  it("findings が無い初回は pass する", () => {
    expect(stepCheck("grill")(grillCtx()).status).toBe("pass");
  });

  it("must 指摘への決定が揃っていれば pass する", () => {
    const findings = makeFindings({
      round: 1,
      findings: [{ severity: "must", problem: "問題A" }],
    });
    writeSessionFile("review-findings.json", JSON.stringify(findings));
    const decisionsPath = writeDecisions(
      "## レビュー R1\n\n### R1-F1: 問題A\n- 指摘: 問題A\n- 種別: decision\n- 決定: adopt\n- 内容: 対応する\n",
    );
    const result = stepCheck("grill")(
      grillCtx({ artifacts: [artifactRecord("review-decisions.md", decisionsPath)] }),
    );
    expect(result.status).toBe("pass");
  });

  it("must 指摘があるのに決定ファイルが無ければ fail する", () => {
    writeSessionFile(
      "review-findings.json",
      JSON.stringify(makeFindings({ findings: [{ severity: "must" }] })),
    );
    const result = stepCheck("grill")(grillCtx());
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("review-decisions.md");
  });

  it("must 指摘の 1 件が決定に欠けていれば fail する", () => {
    const findings = makeFindings({
      findings: [{ severity: "must" }, { severity: "must" }],
    });
    writeSessionFile("review-findings.json", JSON.stringify(findings));
    const decisionsPath = writeDecisions(
      "## レビュー R1\n\n### R1-F1: 問題\n- 指摘: 問題\n- 種別: decision\n- 決定: adopt\n- 内容: 対応\n",
    );
    const result = stepCheck("grill")(
      grillCtx({ artifacts: [artifactRecord("review-decisions.md", decisionsPath)] }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("R1-F2");
  });

  it("決定行の値が不正なら fail する", () => {
    const findings = makeFindings({ findings: [{ severity: "must" }] });
    writeSessionFile("review-findings.json", JSON.stringify(findings));
    const decisionsPath = writeDecisions(
      "## レビュー R1\n\n### R1-F1: 問題\n- 指摘: 問題\n- 種別: decision\n- 決定: ok\n- 内容: 対応\n",
    );
    const result = stepCheck("grill")(
      grillCtx({ artifacts: [artifactRecord("review-decisions.md", decisionsPath)] }),
    );
    expect(result.status).toBe("fail");
  });

  it("人間差し戻しへの決定が揃っていれば pass する", () => {
    const decisionsPath = writeDecisions(
      "## 人間差し戻し\n- 入力: スコープを見直す\n- 決定: modify\n- 内容: スコープを縮小する\n",
    );
    const result = stepCheck("grill")(
      grillCtx({
        gateAnswers: {
          "review-gate": { decision: { value: "request_changes", input: "スコープを見直す" } },
        },
        artifacts: [artifactRecord("review-decisions.md", decisionsPath)],
      }),
    );
    expect(result.status).toBe("pass");
  });

  it("人間差し戻しへの決定が無ければ fail する", () => {
    const decisionsPath = writeDecisions("## レビュー R1\n\n指摘なし\n");
    const result = stepCheck("grill")(
      grillCtx({
        gateAnswers: {
          "review-gate": { decision: { value: "request_changes", input: "スコープを見直す" } },
        },
        artifacts: [artifactRecord("review-decisions.md", decisionsPath)],
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("人間差し戻し");
  });

  it("レビュー指摘モードの prompt は must 指摘と決定ファイルを注入する", () => {
    const findings = makeFindings({
      round: 2,
      findings: [
        {
          severity: "must",
          type: "decision",
          target: "issue-body.md#§完了条件",
          evidence: "根拠テキスト",
          problem: "問題テキスト",
          proposedQuestion: "質問テキスト",
        },
      ],
    });
    writeSessionFile("review-findings.json", JSON.stringify(findings));
    writeDecisions("## レビュー R1\n");
    const repoInfoPath = writeSessionFile(
      "repo-info.json",
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const prompt = taskStep("grill").task.buildPrompt(
      makePromptCtx({ artifacts: [artifactRecord("repo-info.json", repoInfoPath)] }),
    );
    expect(prompt).toContain("R2-F1");
    expect(prompt).toContain("根拠テキスト");
    expect(prompt).toContain("質問テキスト");
    expect(prompt).toContain("review-decisions.md");
    expect(prompt).toContain("AI は計画の意思決定をしない");
  });
});

describe("plan-create judge-must", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-judge-must-"));
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
      loop: { key: "review-fix-cycle", iteration: 1, maxIterations: 3 },
      attemptResult: { status: "completed" },
      artifacts: [],
      ...overrides,
    };
  }

  function writeFindings(findings: PlanReviewFindings): void {
    fs.writeFileSync(path.join(sessionDir, "review-findings.json"), JSON.stringify(findings));
  }

  const judge = () => stepCheck("judge-must");

  it("must=0 なら pass する", () => {
    writeFindings(makeFindings({ cycleRound: 1 }));
    expect(judge()(makeCtx()).status).toBe("pass");
  });

  it("must>0 かつ上限前なら continue する", () => {
    writeFindings(makeFindings({ cycleRound: 1, findings: [{ severity: "must" }] }));
    const result = judge()(makeCtx());
    expect(result.status).toBe("continue");
    expect(result.reasons.join("\n")).toContain("grill");
  });

  it("must>0 かつ上限なら pass する（人間ゲートへ）", () => {
    writeFindings(makeFindings({ cycleRound: 3, findings: [{ severity: "must" }] }));
    const result = judge()(
      makeCtx({ loop: { key: "review-fix-cycle", iteration: 3, maxIterations: 3 } }),
    );
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain("review-fix-exhausted");
  });

  it("loop 文脈が違えば error する", () => {
    writeFindings(makeFindings({ cycleRound: 1 }));
    expect(judge()(makeCtx({ loop: null })).status).toBe("error");
  });

  it("cycleRound 不一致なら error する", () => {
    writeFindings(makeFindings({ cycleRound: 2 }));
    expect(judge()(makeCtx()).status).toBe("error");
  });

  it("findings が不正なら error する", () => {
    fs.writeFileSync(path.join(sessionDir, "review-findings.json"), "not-json");
    expect(judge()(makeCtx()).status).toBe("error");
  });
});

describe("plan-create judge-fix-exhausted", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-judge-fix-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeCtx(value: string | undefined, input?: string, iteration = 1): CheckCtx {
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers:
        value === undefined
          ? {}
          : {
              "review-fix-exhausted": {
                decision: input === undefined ? { value } : { value, input },
              },
            },
      loop: { key: "review-cycle", iteration, maxIterations: 3 },
      attemptResult: { status: "completed" },
      artifacts: [],
    };
  }

  const judge = () => stepCheck("judge-fix-exhausted");

  it("retry は外側 loop の continue になる", () => {
    const result = judge()(makeCtx("retry", "追加指示", 1));
    expect(result.status).toBe("continue");
    expect(result.reasons.join("\n")).toContain("review-fix-cycle");
    expect(result.reasons.join("\n")).toContain("追加指示");
  });

  it("abort は error になる", () => {
    expect(judge()(makeCtx("abort")).status).toBe("error");
  });

  it("外側上限での retry は error になる", () => {
    const result = judge()(makeCtx("retry", undefined, 3));
    expect(result.status).toBe("error");
    expect(result.reasons.join("\n")).toContain("外側");
  });

  it("未回答は fail する", () => {
    expect(judge()(makeCtx(undefined)).status).toBe("fail");
  });

  it("未知値は fail する", () => {
    expect(judge()(makeCtx("approve")).status).toBe("fail");
  });

  it("loop 文脈が違えば error する", () => {
    const ctx = makeCtx("retry");
    expect(judge()({ ...ctx, loop: null }).status).toBe("error");
  });
});

describe("plan-create judge-review", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-judge-review-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeCtx(value: string | undefined, input?: string, iteration = 1): CheckCtx {
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers:
        value === undefined
          ? {}
          : { "review-gate": { decision: input === undefined ? { value } : { value, input } } },
      loop: { key: "review-cycle", iteration, maxIterations: 3 },
      attemptResult: { status: "completed" },
      artifacts: [],
    };
  }

  const judge = () => stepCheck("judge-review");

  it("approve は pass し stale マーカーを削除する", () => {
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 3 }),
    );
    const result = judge()(makeCtx("approve"));
    expect(result.status).toBe("pass");
    expect(fs.existsSync(path.join(sessionDir, "review-cycle-exhausted.json"))).toBe(false);
  });

  it("request_changes は上限前なら continue する", () => {
    const result = judge()(makeCtx("request_changes", "修正理由", 1));
    expect(result.status).toBe("continue");
    expect(result.reasons.join("\n")).toContain("rewind review-cycle to review-fix-cycle");
  });

  it("request_changes は上限でマーカーを残して pass する", () => {
    const result = judge()(makeCtx("request_changes", "修正理由", 3));
    expect(result.status).toBe("pass");
    const marker = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), "utf-8"),
    ) as { loop: string; gate: string; iteration: number };
    expect(marker).toEqual({ loop: "review-cycle", gate: "review-gate", iteration: 3 });
  });

  it("abort は error する", () => {
    expect(judge()(makeCtx("abort")).status).toBe("error");
  });

  it("未回答・未知値は fail する", () => {
    expect(judge()(makeCtx(undefined)).status).toBe("fail");
    expect(judge()(makeCtx("revise", "旧値")).status).toBe("fail");
  });

  it("request_changes の追加入力が空なら fail する", () => {
    expect(judge()(makeCtx("request_changes", "   ")).status).toBe("fail");
  });

  it("他ゲートの request_changes を拾わない", () => {
    const ctx = makeCtx("approve");
    const result = judge()({
      ...ctx,
      gateAnswers: {
        ...ctx.gateAnswers,
        "review-exhausted": { decision: { value: "request_changes", input: "別ゲート" } },
      },
    });
    expect(result.status).toBe("pass");
  });

  it("loop 文脈が違えば error する", () => {
    const ctx = makeCtx("approve");
    expect(judge()({ ...ctx, loop: null }).status).toBe("error");
  });
});

describe("plan-create review-exhausted", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-exhausted-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeCtx(): ConditionCtx {
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      artifacts: [],
    };
  }

  const condition = () => stepCondition("review-exhausted")!;

  it("マーカーが無ければ false", () => {
    expect(condition()(makeCtx())).toBe(false);
  });

  it("valid マーカーがあれば true", () => {
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 3 }),
    );
    expect(condition()(makeCtx())).toBe(true);
  });

  it("別 loop・別 gate・上限未満・破損は throw する（fail-closed）", () => {
    const write = (value: unknown) =>
      fs.writeFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), JSON.stringify(value));
    write({ loop: "other_loop", gate: "review-gate", iteration: 3 });
    expect(() => condition()(makeCtx())).toThrow();
    write({ loop: "review-cycle", gate: "other_gate", iteration: 3 });
    expect(() => condition()(makeCtx())).toThrow();
    write({ loop: "review-cycle", gate: "review-gate", iteration: 2 });
    expect(() => condition()(makeCtx())).toThrow();
    fs.writeFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), "not-json");
    expect(() => condition()(makeCtx())).toThrow();
  });

  it("overshoot（iteration > max）でも true", () => {
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 4 }),
    );
    expect(condition()(makeCtx())).toBe(true);
  });
});

describe("plan-create prepare", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-prepare-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeCtx(findings: PlanReviewFindings | undefined): CheckCtx {
    const decisionPath = path.join(sessionDir, "prepare-decision.json");
    fs.writeFileSync(
      decisionPath,
      JSON.stringify({ mode: "update", fromIssue: false, issueNumber: null, repo: "acme/demo" }),
    );
    if (findings !== undefined) {
      fs.writeFileSync(path.join(sessionDir, "review-findings.json"), JSON.stringify(findings));
    }
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: { key: "review-cycle", iteration: 1, maxIterations: 3 },
      attemptResult: { status: "completed" },
      artifacts: [
        {
          id: 0,
          sessionId: path.basename(sessionDir),
          stepKey: "prepare",
          artifactKey: "prepare-decision.json",
          filePath: decisionPath,
          createdAt: "2026-01-01 00:00:00",
        },
      ],
    };
  }

  it("must=0 なら pass する", () => {
    expect(stepCheck("prepare")(makeCtx(makeFindings())).status).toBe("pass");
  });

  it("must>0 なら fail する", () => {
    const result = stepCheck("prepare")(
      makeCtx(makeFindings({ findings: [{ severity: "must" }] })),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("findings が無ければ fail する", () => {
    expect(stepCheck("prepare")(makeCtx(undefined)).status).toBe("fail");
  });
});

describe("plan-create create-refined", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-create-refined-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeCtx(options: {
    findings: PlanReviewFindings;
    issueNumber?: string;
    children?: string[];
  }): CheckCtx {
    fs.writeFileSync(
      path.join(sessionDir, "issue-body.md"),
      "## ✅ 完了条件\n\n- 条件\n\n## 🧭 方針\n\n方針\n",
    );
    const findingsPath = path.join(sessionDir, "review-findings.json");
    fs.writeFileSync(findingsPath, JSON.stringify(options.findings));
    const reviewBodyPath = path.join(sessionDir, "review-body.md");
    fs.writeFileSync(reviewBodyPath, renderReviewBody(options.findings));
    const issueNumberPath = path.join(sessionDir, "issue-number.txt");
    fs.writeFileSync(issueNumberPath, options.issueNumber ?? "999999999");
    for (const child of options.children ?? []) {
      fs.writeFileSync(path.join(sessionDir, child), "## ✅ 完了条件\n\n- 子条件\n");
    }
    return {
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      attemptResult: { status: "completed" },
      artifacts: [
        {
          id: 0,
          sessionId: path.basename(sessionDir),
          stepKey: "review-body",
          artifactKey: "review-body.md",
          filePath: reviewBodyPath,
          createdAt: "2026-01-01 00:00:00",
        },
        {
          id: 1,
          sessionId: path.basename(sessionDir),
          stepKey: "create-refined",
          artifactKey: "issue-number.txt",
          filePath: issueNumberPath,
          createdAt: "2026-01-01 00:00:00",
        },
      ],
    };
  }

  it("must>0 なら GitHub 照合の前に fail する", () => {
    const result = stepCheck("create-refined")(
      makeCtx({ findings: makeFindings({ findings: [{ severity: "must" }] }) }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("must=0 なら must 理由では fail しない", () => {
    const result = stepCheck("create-refined")(makeCtx({ findings: makeFindings() }));
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).not.toContain("must");
  });

  it("枯渇マーカーがあっても must>0 は fail する", () => {
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 3 }),
    );
    const result = stepCheck("create-refined")(
      makeCtx({ findings: makeFindings({ findings: [{ severity: "must" }] }) }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("枯渇マーカー + must=0 は警告を出し、must 理由では fail しない", () => {
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 3 }),
    );
    const result = stepCheck("create-refined")(makeCtx({ findings: makeFindings() }));
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("人間差し戻しが上限");
    expect(result.reasons.join("\n")).not.toContain("must が");
  });

  it("枯渇マーカー破損は error にする（fail-open しない）", () => {
    fs.writeFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), "not-json");
    const result = stepCheck("create-refined")(makeCtx({ findings: makeFindings() }));
    expect(result.status).toBe("error");
    expect(result.reasons.join("\n")).toContain("枯渇マーカー");
  });

  it("子 body が reviewedTargets に無ければ fail する", () => {
    const result = stepCheck("create-refined")(
      makeCtx({
        findings: makeFindings({ reviewedTargets: ["issue-body.md"] }),
        children: ["issue-body-1.md"],
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("issue-body-1.md");
  });
});

describe("plan-create child review helper", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-child-"));
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

  it("子 body 列挙に失敗したら fail する（fail-closed）", () => {
    const result = requireChildReviewIfChildrenExist(
      makeCtx({ sessionDir: path.join(tmp, "does-not-exist") }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("列挙に失敗");
  });

  it("子 body が symlink なら fail する", () => {
    fs.writeFileSync(path.join(sessionDir, "issue-body.md"), "## ✅ 完了条件\n\n- 条件\n");
    fs.writeFileSync(path.join(sessionDir, "secret.txt"), "secret");
    fs.symlinkSync(path.join(sessionDir, "secret.txt"), path.join(sessionDir, "issue-body-1.md"));
    fs.writeFileSync(
      path.join(sessionDir, "review-findings.json"),
      JSON.stringify(makeFindings({ reviewedTargets: ["issue-body.md", "issue-body-1.md"] })),
    );
    const result = requireChildReviewIfChildrenExist(makeCtx());
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("symlink");
  });

  it("子 body が reviewedTargets に含まれていれば pass する", () => {
    fs.writeFileSync(path.join(sessionDir, "issue-body.md"), "## ✅ 完了条件\n\n- 条件\n");
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-findings.json"),
      JSON.stringify(makeFindings({ reviewedTargets: ["issue-body.md", "issue-body-1.md"] })),
    );
    expect(requireChildReviewIfChildrenExist(makeCtx()).status).toBe("pass");
  });
});

describe("plan-create owner branch", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-owner-"));
    sessionDir = path.join(tmp, "session");
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function artifactRecord(key: string, filePath: string): ArtifactRecord {
    return {
      id: 0,
      sessionId: path.basename(sessionDir),
      stepKey: "test",
      artifactKey: key,
      filePath,
      createdAt: "2026-01-01 00:00:00",
    };
  }

  function promptFor(key: string, owner: string): string {
    fs.writeFileSync(
      path.join(sessionDir, "issue-body.md"),
      "## ✅ 完了条件\n\n- 条件\n\n## 🧭 方針\n\n方針\n",
    );
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner, repo: "x", nameWithOwner: `${owner}/x` }),
    );
    return taskStep(key).task.buildPrompt({
      sessionDir,
      sessionId: path.basename(sessionDir),
      gateAnswers: {},
      loop: null,
      artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
    });
  }

  it("owner分岐（withDocs）の3箇所は同期する", () => {
    for (const key of ["grill", "draft-body", "review-body"]) {
      expect(promptFor(key, "t-miura-024")).toContain("mt-domain-modeling");
      expect(promptFor(key, "t-miura-024")).toContain("GHERKIN-FORMAT");
      expect(promptFor(key, "someone")).not.toContain("mt-domain-modeling");
      expect(promptFor(key, "someone")).not.toContain("GHERKIN-FORMAT");
    }
  });
});

describe("plan-create human gates", () => {
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
});
