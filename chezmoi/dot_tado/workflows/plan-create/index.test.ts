import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def from "./index.ts";
import { requireChildReviewIfChildrenExist } from "./helper/require-child-review-if-children-exist.ts";
import type { CheckCtx, PromptCtx, ArtifactRecord, GateAnswers } from "tado";
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

const stepCheck = (key: string) => {
  const step = findStep(key);
  if (step.type === "loop") throw new Error(`${key} is a loop step (has no check)`);
  return step.check;
};

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

  function artifactRecord(key: string, filePath: string): ArtifactRecord {
    return {
      id: 0,
      sessionId: path.basename(sessionDir),
      stepKey: "review-body",
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

  function reviewBodyCtx(): CheckCtx {
    const issueBody = writeSessionFile(
      "issue-body.md",
      "## ✅ 完了条件\n\n- 条件\n\n## 🧭 方針\n\n方針\n",
    );
    const reviewBody = writeSessionFile(
      "review-body.md",
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n",
    );
    return makeCtx({
      artifacts: [
        artifactRecord("issue-body.md", issueBody),
        artifactRecord("review-body.md", reviewBody),
      ],
    });
  }

  it("review-cycle → review-exhausted → create-refined → finalize の順序で動作する", () => {
    const keys = def.steps.map((s) => s.key);
    expect(keys).toEqual(["review-cycle", "review-exhausted", "create-refined", "finalize"]);
  });

  it("review-cycle の body は grill 先頭・judge 末尾で作業ステップ群＋ゲートを含む", () => {
    const bodyKeys = loopStep("review-cycle").body.map((s) => s.key);
    expect(bodyKeys).toEqual([
      "grill",
      "draft-body",
      "review-body",
      "prepare",
      "review-gate",
      "judge-review",
    ]);
  });

  it("create_draft は残さない（冪等ガード付き create-refined に改名）", () => {
    const keys = def.steps.map((s) => s.key);
    expect(keys).not.toContain("create_draft");
    expect(keys).toContain("create-refined");
  });

  it("review-gate は Issue 実物ではなく session ファイルを対象にする", () => {
    const gate = gateStep("review-gate");
    expect(gate.humanGate.presentArtifacts).toEqual([
      "issue-body.md",
      "review-body.md",
      "prepare-decision.json",
    ]);
    expect(gate.humanGate.presentArtifacts).not.toContain("issue-number.txt");
  });

  it("review-gate の approve は refined 直接作成・abort は Issue を作らず終了する文言である", () => {
    const gate = gateStep("review-gate");
    const questions = gate.humanGate.questions;
    const decision = questions.find((q) => q.key === "decision");
    const approve = (decision?.choices ?? []).find((c) => c.value === "approve");
    const abort = (decision?.choices ?? []).find((c) => c.value === "abort");
    expect(approve?.label ?? "").toContain("refined");
    expect(abort?.desc ?? "").toContain("Issue を作成せず");
  });

  it("review-body の buildPrompt は 5 観点と must/should/want 重み付けを指示する", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = taskStep("review-body");
    const prompt = step.task.buildPrompt(
      makePromptCtx({ artifacts: [artifactRecord("repo-info.json", repoInfoPath)] }),
    );
    for (const perspective of ["A:", "B:", "C:", "D:", "E:"]) {
      expect(prompt).toContain(perspective);
    }
    expect(prompt).toContain("🚨 must");
    expect(prompt).toContain("⚠️ should");
    expect(prompt).toContain("💡 want");
    expect(prompt).toContain("review-body.md");
  });

  it("review-body の check はレビュー結果と指摘一覧の記載を求める", () => {
    const result = stepCheck("review-body")(reviewBodyCtx());
    expect(result.status).toBe("pass");
  });

  it("review-body の check は指摘一覧が無ければ fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "review-body.md"), "## レビュー結果\n\n概要\n");
    const result = stepCheck("review-body")(ctx);
    expect(result.status).toBe("fail");
  });

  it("review-body の check は前提ファイル（issue-body.md）欠落で fail", () => {
    const reviewBody = writeSessionFile(
      "review-body.md",
      "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n指摘なし\n",
    );
    const result = stepCheck("review-body")(
      makeCtx({ artifacts: [artifactRecord("review-body.md", reviewBody)] }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("issue-body.md");
  });

  it("review-body の buildPrompt は自己レビューの限界と must 残存時の request_changes 経路を明示する", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = taskStep("review-body");
    const prompt = step.task.buildPrompt(
      makePromptCtx({ artifacts: [artifactRecord("repo-info.json", repoInfoPath)] }),
    );
    expect(prompt).toContain("盲点");
    expect(prompt).toContain("request_changes");
    expect(prompt).toContain("approve は must/should がゼロの場合のみ");
  });

  it("review-gate の approve は must 残存時の選択不可を明示する", () => {
    const gate = gateStep("review-gate");
    const questions = gate.humanGate.questions;
    const decision = questions.find((q) => q.key === "decision");
    const approve = (decision?.choices ?? []).find((c) => c.value === "approve");
    const requestChanges = (decision?.choices ?? []).find((c) => c.value === "request_changes");
    expect(approve?.desc ?? "").toContain("must");
    expect(requestChanges?.desc ?? "").toContain("must/should");
  });

  it("create-refined の buildPrompt は must 残存到達時の escalate と自動集約の否定を含む", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain("escalate");
    expect(prompt).not.toContain("abort");
    expect(prompt).not.toContain("自動集約");
    expect(prompt).toContain("親子すべてを refined にする");
  });

  it("create-refined の buildPrompt は effort 検証の失敗分岐と冪等ガードを含む", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("冪等ガード");
    expect(prompt).toContain("issue-number-<n>.txt");
  });

  it("create-refined の check は issue-number.txt の申告を要求する", () => {
    expect(stepCheck("create-refined")(makeCtx()).status).toBe("fail");
  });

  function createRefinedCtx(options: { reviewBody: string; issueNumber?: string }): CheckCtx {
    const issueNumberPath = writeSessionFile("issue-number.txt", options.issueNumber ?? "123");
    const reviewBodyPath = writeSessionFile("review-body.md", options.reviewBody);
    return makeCtx({
      artifacts: [
        artifactRecord("issue-number.txt", issueNumberPath),
        artifactRecord("review-body.md", reviewBodyPath),
      ],
    });
  }

  const REVIEW_BODY_WITH_MUST =
    "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n";
  const REVIEW_BODY_CLEAN =
    "## レビュー結果\n\n概要（指摘件数: must 0 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n";

  it("create-refined の check は review-body.md 未申告で fail", () => {
    const issueNumberPath = writeSessionFile("issue-number.txt", "123");
    const result = stepCheck("create-refined")(
      makeCtx({ artifacts: [artifactRecord("issue-number.txt", issueNumberPath)] }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("review-body.md");
  });

  it("create-refined の check は must 残存（🚨 must）で fail（GitHub 照合の前に）", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({ reviewBody: REVIEW_BODY_WITH_MUST }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create-refined の check は must 数値申告（must 2）でも fail", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 2 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\nmust 2 件の詳細\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create-refined の check は must ゼロ（指摘なし）で must 理由では fail しない", () => {
    // NOTE: verifyIssueOpen は gh 不在・未認証・オフライン時も例外でなく fail 理由を返すため、
    // このテストは GitHub 非依存で決定的に fail（理由は must 以外）する。skip 条件は不要。
    const result = stepCheck("create-refined")(
      createRefinedCtx({ reviewBody: REVIEW_BODY_CLEAN, issueNumber: "999999999" }),
    );
    // GitHub 照合（存在しない番号）に進むため fail するが、理由は must ではない
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).not.toContain("must");
  });

  it("create-refined の buildPrompt は must 残存時の escalate→request_changes 誘導に一本化する", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("review-gate の request_changes");
    expect(prompt).not.toContain("新規セッション");
  });

  it("create-refined の buildPrompt は effort コメント初期値の一本化を明示し Q1/Q2 を持たない", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).not.toContain("Q1");
    expect(prompt).not.toContain("Q2");
    expect(prompt).toContain("初期値を決定値とする");
    expect(prompt).toContain("escalate");
  });

  it("review-gate は decision のみを持ち width/depth 質問を持たない", () => {
    const gate = gateStep("review-gate");
    const questions = gate.humanGate.questions;
    expect(questions.map((q) => q.key)).toEqual(["decision"]);
    expect(gate.humanGate.outcomeQuestionKey).toBe("decision");
  });

  it("create-refined の buildPrompt は番号検証手順（形式検証・escalate 分岐）を含む", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain("grep -Eq '^[0-9]+$'");
    expect(prompt).toContain("未検証の番号を渡さない");
  });

  it("review-body の buildPrompt は子 body 全件を必須レビュー対象とする", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = taskStep("review-body");
    const prompt = step.task.buildPrompt(
      makePromptCtx({ artifacts: [artifactRecord("repo-info.json", repoInfoPath)] }),
    );
    expect(prompt).toContain("全件を必須レビュー対象");
    expect(prompt).not.toContain("保証対象外");
  });

  it("review-body の check は子 body 実在時に子言及なしで fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    const result = stepCheck("review-body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("子レビュー");
  });

  it("review-body の check は子 body 実在時に子言及があれば pass", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n| 対象 | issue-body-1.md |\n",
    );
    const result = stepCheck("review-body")(ctx);
    expect(result.status).toBe("pass");
  });

  it("requireChildReviewIfChildrenExist は子 body 列挙に失敗したら fail（fail-closed）", () => {
    const result = requireChildReviewIfChildrenExist(
      makeCtx({ sessionDir: path.join(tmp, "does-not-exist"), artifacts: [] }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("子body列挙に失敗したため検証不能");
  });

  it("requireChildReviewIfChildrenExist は子 body が symlink なら fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "secret.txt"), "secret");
    fs.symlinkSync(path.join(sessionDir, "secret.txt"), path.join(sessionDir, "issue-body-1.md"));
    // 子言及があっても symlink 自体で fail する
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n| 対象 | issue-body-1.md |\n",
    );
    const result = requireChildReviewIfChildrenExist(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("symlink");
  });

  it("review-body の check は「対象外」一文のみでは子レビューとみなさず fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 0 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n\nissue-body-1.md は対象外とした。\n",
    );
    const result = stepCheck("review-body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("issue-body-1.md");
  });

  it("review-body の check は子ごとの対象見出しがあれば pass", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 対象: issue-body-1.md\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n",
    );
    const result = stepCheck("review-body")(ctx);
    expect(result.status).toBe("pass");
  });

  it("review-body の check は単漢字「子」のみでは子レビューとみなさず fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n指摘なし\n\n子供向けの表現に配慮した。\n",
    );
    const result = stepCheck("review-body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("子レビュー");
  });

  it("review-body の buildPrompt は review-gate での全文の直接確認を指示する", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = taskStep("review-body");
    const prompt = step.task.buildPrompt(
      makePromptCtx({ artifacts: [artifactRecord("repo-info.json", repoInfoPath)] }),
    );
    expect(prompt).toContain("review-body.md 全文");
    expect(prompt).not.toContain("grill-map");
  });

  it("create-refined の buildPrompt は effort 検証の grep に対象ファイルを指定する", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain('grep -E "<!-- effort: width=');
    expect(prompt).toContain("issue-body.md");
  });

  it("create-refined の buildPrompt は番号検証ループで存在しないパスの誤検出を避ける", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain('[ -f "$f" ] || continue');
  });

  it("create-refined の buildPrompt は Issue 作成ごとに直ちに番号を記録する", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain("1件作成するごとに直ちに");
    expect(prompt).toContain("issue-number-<n>.txt");
  });

  it("create-refined の buildPrompt は子未レビュー時の escalate ガードを含む", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain("子未レビュー");
    expect(prompt).toContain("escalate");
    expect(prompt).not.toContain("abort");
  });

  it("create-refined の check は子 body 実在時に子言及なしで fail（GitHub 照合の前に）", () => {
    const issueNumberPath = writeSessionFile("issue-number.txt", "123");
    const reviewBodyPath = writeSessionFile("review-body.md", REVIEW_BODY_CLEAN);
    writeSessionFile("issue-body-1.md", "## ✅ 完了条件\n\n- 子条件\n");
    const result = stepCheck("create-refined")(
      makeCtx({
        artifacts: [
          artifactRecord("issue-number.txt", issueNumberPath),
          artifactRecord("review-body.md", reviewBodyPath),
        ],
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("子レビュー");
  });

  it("create-refined の check は must 表記ゆれ（must: 1 / must=1 / 全角数字）でも fail", () => {
    for (const variant of [
      "概要（指摘件数: must: 1 / should 0 / want 0）",
      "概要（指摘件数: must=1 / should 0 / want 0）",
      "概要（指摘件数: must １ / should 0 / want 0）",
      "概要（指摘件数: mustが2件 / should 0 / want 0）",
    ]) {
      const result = stepCheck("create-refined")(
        createRefinedCtx({
          reviewBody: `## レビュー結果\n\n${variant}\n\n## 指摘一覧\n\n指摘なし\n`,
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("must");
    }
  });

  it("create-refined の check は絵文字のみの must 残存（🚨）でも fail", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n🚨 対応が必要\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create-refined の check はセクションのみで重み付け記載なしの review-body で fail", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody: "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n何らかの記載\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("review-body.md");
  });

  it("create-refined の buildPrompt は親子番号の全件検証を要求する", () => {
    const step = taskStep("create-refined");
    const prompt = step.task.buildPrompt(makePromptCtx());
    expect(prompt).toContain("issue-number-*.txt");
    expect(prompt).toContain("全件");
    expect(prompt).toContain("escalate");
  });

  it("create-refined の check は漢数字の must 残存（must一件）で fail", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must一件 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create-refined の check は全角英字の must 残存（ＭＵＳＴ １）で fail", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: ＭＵＳＴ １ / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create-refined の check は否定文（🚨なし）で must 理由では fail しない", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 0 / should 0 / want 0）🚨なし\n\n## 指摘一覧\n\n指摘なし\n",
        issueNumber: "999999999",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).not.toContain("must");
  });

  it("review-body の check は子2件で1件言及のみなら fail（全件要求）", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件1\n");
    fs.writeFileSync(path.join(sessionDir, "issue-body-2.md"), "## ✅ 完了条件\n\n- 子条件2\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n| 対象 | issue-body-1.md |\n",
    );
    const result = stepCheck("review-body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("issue-body-2.md");
  });

  it("create-refined の check は概要 must 0 で本文の良性 must 1 英文があっても must 理由では fail しない", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 0 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n\nNote: the system must 1 time be restarted for verification.\n",
        issueNumber: "999999999",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).not.toContain("must");
  });

  it("create-refined の check は概要の must 1 申告で fail", () => {
    const result = stepCheck("create-refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create-refined の check は枯渇経由の must 残存を警告として記録し must 理由では fail しない", () => {
    // 枯渇マーカーあり＋must 残存: ゲートの約束どおり作成へ進むため must では fail しない。
    // GitHub 照合（存在しない番号）では fail するが、理由に警告が含まれ must 文言の fail 理由は含まない。
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 3 }),
    );
    const result = stepCheck("create-refined")(
      createRefinedCtx({ reviewBody: REVIEW_BODY_WITH_MUST, issueNumber: "999999999" }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("警告");
    expect(result.reasons.join("\n")).not.toContain("approve 不可");
  });

  it("create-refined の check は枯渇マーカー破損で error に倒す（fail-open しない）", () => {
    fs.writeFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), "not-json");
    const result = stepCheck("create-refined")(
      createRefinedCtx({ reviewBody: REVIEW_BODY_CLEAN, issueNumber: "999999999" }),
    );
    expect(result.status).toBe("error");
    expect(result.reasons.join("\n")).toContain("枯渇マーカー");
  });

  it("owner分岐（withDocs）の3箇所は同期する", () => {
    const buildPrompt = (key: string, owner: string): string => {
      const repoInfoPath = path.join(sessionDir, "repo-info.json");
      fs.writeFileSync(
        repoInfoPath,
        JSON.stringify({ owner, repo: "x", nameWithOwner: `${owner}/x` }),
      );
      return taskStep(key).task.buildPrompt(
        makePromptCtx({ artifacts: [artifactRecord("repo-info.json", repoInfoPath)] }),
      );
    };
    for (const key of ["grill", "draft-body", "review-body"]) {
      expect(buildPrompt(key, "t-miura-024")).toContain("mt-domain-modeling");
      expect(buildPrompt(key, "someone")).not.toContain("mt-domain-modeling");
    }
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
});

describe("plan-create review-cycle loop", () => {
  let tmp: string;
  let sessionDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-create-loop-"));
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

  function answers(gateKey: string, value: string, input?: string): GateAnswers {
    return {
      [gateKey]: { decision: input === undefined ? { value } : { value, input } },
    };
  }

  function judgeCtx(value: string | undefined, input?: string, iteration = 1): CheckCtx {
    const gateAnswers = value === undefined ? {} : answers("review-gate", value, input);
    return makeCtx({
      gateAnswers,
      loop: { key: "review-cycle", iteration, maxIterations: 3 },
    });
  }

  const judgeCheck = () => {
    const step = flattenSteps(def.steps).find((s) => s.key === "judge-review");
    if (!step || step.type === "loop") throw new Error("judge-review not found");
    return step.check;
  };

  it("loop は maxIterations=3・onExhausted=escalate である", () => {
    const loop = loopStep("review-cycle");
    expect(loop.maxIterations).toBe(3);
    expect(loop.onExhausted).toBe("escalate");
  });

  it("judge は approve→pass する", () => {
    const result = judgeCheck()(judgeCtx("approve", "補足"));
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain("approved");
  });

  it("judge は request_changes→continue する（上限前）", () => {
    for (const iteration of [1, 2]) {
      const result = judgeCheck()(judgeCtx("request_changes", "修正理由", iteration));
      expect(result.status).toBe("continue");
      expect(result.reasons.join("\n")).toContain("rewind review-cycle to grill");
    }
  });

  it("judge は最終反復の request_changes で枯渇マーカーを残して pass する", () => {
    const result = judgeCheck()(judgeCtx("request_changes", "修正理由", 3));
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain("上限到達");
    const marker = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), "utf-8"),
    ) as { loop: string; gate: string; iteration: number };
    expect(marker.loop).toBe("review-cycle");
    expect(marker.gate).toBe("review-gate");
    expect(marker.iteration).toBe(3);
  });

  it("judge は abort→error する", () => {
    const result = judgeCheck()(judgeCtx("abort"));
    expect(result.status).toBe("error");
    expect(result.reasons.join("\n")).toContain("abort");
  });

  it("judge は未知値・未回答→fail する", () => {
    const unknown = judgeCheck()(judgeCtx("revise", "旧値"));
    expect(unknown.status).toBe("fail");
    expect(unknown.reasons.join("\n")).toContain("想定外");
    const missing = judgeCheck()(judgeCtx(undefined));
    expect(missing.status).toBe("fail");
    expect(missing.reasons.join("\n")).toContain("回答がありません");
  });

  it("judge は追加入力の欠落・空文字で fail する（捏造しない）", () => {
    for (const input of [undefined, "", "   "]) {
      const result = judgeCheck()(judgeCtx("request_changes", input));
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("追加入力");
    }
  });

  it("judge は他ゲートの request_changes を拾わない（幽霊差し戻し防止）", () => {
    const result = judgeCheck()(
      makeCtx({
        gateAnswers: {
          ...answers("review-gate", "approve"),
          ...answers("review-exhausted", "request_changes", "別ゲートの入力"),
        },
        loop: { key: "review-cycle", iteration: 1, maxIterations: 3 },
      }),
    );
    expect(result.status).toBe("pass");
  });

  it("judge は自 loop 外の文脈では error する", () => {
    const outside = judgeCheck()(
      makeCtx({ gateAnswers: answers("review-gate", "approve"), loop: null }),
    );
    expect(outside.status).toBe("error");
    expect(outside.reasons.join("\n")).toContain("review-cycle");
  });

  it("review-exhausted の condition は枯渇マーカーがある反復でのみ true になる", () => {
    const step = gateStep("review-exhausted");
    if (!step.condition) throw new Error("review-exhausted has no condition");
    expect(step.condition(makeCtx())).toBe(false);
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 3 }),
    );
    expect(step.condition(makeCtx())).toBe(true);
  });

  it("review-exhausted の condition は別 loop・別 gate・マーカー破損では throw する（fail-closed）", () => {
    const step = gateStep("review-exhausted");
    const condition = step.condition;
    if (!condition) throw new Error("review-exhausted has no condition");
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "other_loop", gate: "review-gate", iteration: 3 }),
    );
    expect(() => condition(makeCtx())).toThrow();
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "other_gate", iteration: 3 }),
    );
    expect(() => condition(makeCtx())).toThrow();
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 2 }),
    );
    expect(() => condition(makeCtx())).toThrow();
    fs.writeFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), "not-json");
    expect(() => condition(makeCtx())).toThrow();
  });

  it("review-exhausted の condition は iteration overshoot（>max）でも true になる（fail-closed）", () => {
    const step = gateStep("review-exhausted");
    const condition = step.condition;
    if (!condition) throw new Error("review-exhausted has no condition");
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 4 }),
    );
    expect(condition(makeCtx())).toBe(true);
  });

  it("judge は approve で stale マーカーを削除する", () => {
    fs.writeFileSync(
      path.join(sessionDir, "review-cycle-exhausted.json"),
      JSON.stringify({ loop: "review-cycle", gate: "review-gate", iteration: 3 }),
    );
    const result = judgeCheck()(judgeCtx("approve", "補足"));
    expect(result.status).toBe("pass");
    expect(fs.existsSync(path.join(sessionDir, "review-cycle-exhausted.json"))).toBe(false);
  });

  it("judge は overshoot 反復（iteration > max）でも枯渇マーカーを残して pass する（fail-closed）", () => {
    const result = judgeCheck()(judgeCtx("request_changes", "修正理由", 4));
    expect(result.status).toBe("pass");
    expect(result.reasons.join("\n")).toContain("上限到達");
    const marker = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "review-cycle-exhausted.json"), "utf-8"),
    ) as { loop: string; gate: string; iteration: number };
    expect(marker.loop).toBe("review-cycle");
    expect(marker.gate).toBe("review-gate");
    expect(marker.iteration).toBe(4);
  });

  it("review-exhausted は approve/abort のみを持ち request_changes を持たない", () => {
    const gate = gateStep("review-exhausted");
    const questions = gate.humanGate.questions;
    expect(questions.map((q) => q.key)).toEqual(["decision"]);
    expect(gate.humanGate.outcomeQuestionKey).toBe("decision");
    const values = (questions.find((q) => q.key === "decision")?.choices ?? []).map((c) => c.value);
    expect(values).toEqual(["approve", "abort"]);
  });

  it("review-gate は request_changes（input 必須）を持ち続ける", () => {
    const gate = gateStep("review-gate");
    const decision = gate.humanGate.questions.find((q) => q.key === "decision");
    const values = (decision?.choices ?? []).map((c) => c.value);
    expect(values).toEqual(["approve", "request_changes", "abort"]);
    const requestChanges = (decision?.choices ?? []).find((c) => c.value === "request_changes");
    expect(requestChanges?.input?.required).toBe(true);
  });

  it("grill の prompt は request_changes の追加入力を注入し、初回は「なし」とする", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = taskStep("grill");
    const withFeedback = step.task.buildPrompt(
      makePromptCtx({
        artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
        gateAnswers: answers("review-gate", "request_changes", "スコープを見直すこと"),
      }),
    );
    expect(withFeedback).toContain("スコープを見直すこと");
    expect(withFeedback).toContain("review-gate");
    const initial = step.task.buildPrompt(
      makePromptCtx({ artifacts: [artifactRecord("repo-info.json", repoInfoPath)] }),
    );
    expect(initial).toContain("(なし。初回実行)");
  });

  it("loop 外ステップの check は continue を返さない", () => {
    for (const key of ["review-exhausted", "create-refined", "finalize"]) {
      const step = flattenSteps(def.steps).find((s) => s.key === key);
      if (!step || step.type === "loop") throw new Error(`${key} not found`);
      expect(String(step.check)).not.toContain('"continue"');
    }
    // judge が唯一の continue 発生源であることは request_changes→continue の振る舞いテストで固定する。
    const result = judgeCheck()(judgeCtx("request_changes", "修正理由", 1));
    expect(result.status).toBe("continue");
  });
});
