import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import def, { requireChildReviewIfChildrenExist } from "./index.ts";
import type { CheckCtx, ArtifactRecord } from "tado";

const stepCheck = (key: string) => def.steps.find((s) => s.key === key)!.check;

describe("mt-plan-create workflow structure", () => {
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
      attemptResult: { status: "completed" },
      artifacts: [],
      ...overrides,
    };
  }

  function artifactRecord(key: string, filePath: string): ArtifactRecord {
    return {
      id: 0,
      sessionId: path.basename(sessionDir),
      stepKey: "review_body",
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
    const grillMap = writeSessionFile("grill-map.md", "# ライブ地図\n\n- [確定] 項目\n");
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
        artifactRecord("grill-map.md", grillMap),
        artifactRecord("issue-body.md", issueBody),
        artifactRecord("review-body.md", reviewBody),
      ],
    });
  }

  it("draft_body → review_body → prepare → review_gate → create_refined → finalize の順序で動作する", () => {
    const keys = def.steps.map((s) => s.key);
    expect(keys).toEqual([
      "grill",
      "draft_body",
      "review_body",
      "prepare",
      "review_gate",
      "create_refined",
      "finalize",
    ]);
  });

  it("create_draft は残さない（冪等ガード付き create_refined に改名）", () => {
    const keys = def.steps.map((s) => s.key);
    expect(keys).not.toContain("create_draft");
    expect(keys).toContain("create_refined");
  });

  it("review_gate は Issue 実物ではなく session ファイルを対象にする", () => {
    const gate = def.steps.find((s) => s.key === "review_gate")!;
    expect(gate.humanGate?.presentArtifacts).toEqual([
      "issue-body.md",
      "review-body.md",
      "prepare-decision.json",
    ]);
    expect(gate.humanGate?.presentArtifacts).not.toContain("issue-number.txt");
  });

  it("review_gate の approve は refined 直接作成・abort は Issue を作らず終了する文言である", () => {
    const gate = def.steps.find((s) => s.key === "review_gate")!;
    const questions = gate.humanGate?.questions ?? [];
    const decision = questions.find((q) => q.key === "decision");
    const approve = decision?.choices.find((c) => c.value === "approve");
    const abort = decision?.choices.find((c) => c.value === "abort");
    expect(approve?.label ?? "").toContain("refined");
    expect(abort?.desc ?? "").toContain("Issue を作成せず");
  });

  it("review_body の buildPrompt は 6 観点と must/should/want 重み付けを指示する", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = def.steps.find((s) => s.key === "review_body")!;
    const prompt = step.task!.buildPrompt({
      sessionDir,
      artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
    });
    for (const perspective of ["A:", "B:", "C:", "D:", "E:", "F:"]) {
      expect(prompt).toContain(perspective);
    }
    expect(prompt).toContain("🚨 must");
    expect(prompt).toContain("⚠️ should");
    expect(prompt).toContain("💡 want");
    expect(prompt).toContain("review-body.md");
  });

  it("review_body の check はレビュー結果と指摘一覧の記載を求める", () => {
    const result = stepCheck("review_body")(reviewBodyCtx());
    expect(result.status).toBe("pass");
  });

  it("review_body の check は指摘一覧が無ければ fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "review-body.md"), "## レビュー結果\n\n概要\n");
    const result = stepCheck("review_body")(ctx);
    expect(result.status).toBe("fail");
  });

  it("review_body の check は前提ファイル（grill-map.md / issue-body.md）欠落で fail", () => {
    const reviewBody = writeSessionFile(
      "review-body.md",
      "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n指摘なし\n",
    );
    const result = stepCheck("review_body")(
      makeCtx({ artifacts: [artifactRecord("review-body.md", reviewBody)] }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("grill-map.md");
  });

  it("review_body の buildPrompt は自己レビューの限界と must 残存時の revise 経路を明示する", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = def.steps.find((s) => s.key === "review_body")!;
    const prompt = step.task!.buildPrompt({
      sessionDir,
      artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
    });
    expect(prompt).toContain("盲点");
    expect(prompt).toContain("revise");
    expect(prompt).toContain("approve は must/should がゼロの場合のみ");
  });

  it("review_gate の approve は must 残存時の選択不可を明示する", () => {
    const gate = def.steps.find((s) => s.key === "review_gate")!;
    const questions = gate.humanGate?.questions ?? [];
    const decision = questions.find((q) => q.key === "decision");
    const approve = decision?.choices.find((c) => c.value === "approve");
    const revise = decision?.choices.find((c) => c.value === "revise");
    expect(approve?.desc ?? "").toContain("must");
    expect(revise?.desc ?? "").toContain("must/should");
  });

  it("create_refined の buildPrompt は must 残存到達時の escalate と自動集約の否定を含む", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain("escalate");
    expect(prompt).not.toContain("abort");
    expect(prompt).not.toContain("自動集約");
    expect(prompt).toContain("親子すべてを refined にする");
  });

  it("create_refined の buildPrompt は effort 検証の失敗分岐と冪等ガードを含む", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("冪等ガード");
    expect(prompt).toContain("issue-number-<n>.txt");
  });

  it("create_refined の check は issue-number.txt の申告を要求する", () => {
    expect(stepCheck("create_refined")(makeCtx()).status).toBe("fail");
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

  it("create_refined の check は review-body.md 未申告で fail", () => {
    const issueNumberPath = writeSessionFile("issue-number.txt", "123");
    const result = stepCheck("create_refined")(
      makeCtx({ artifacts: [artifactRecord("issue-number.txt", issueNumberPath)] }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("review-body.md");
  });

  it("create_refined の check は must 残存（🚨 must）で fail（GitHub 照合の前に）", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({ reviewBody: REVIEW_BODY_WITH_MUST }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create_refined の check は must 数値申告（must 2）でも fail", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 2 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\nmust 2 件の詳細\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create_refined の check は must ゼロ（指摘なし）で must 理由では fail しない", () => {
    // NOTE: verifyIssueOpen は gh 不在・未認証・オフライン時も例外でなく fail 理由を返すため、
    // このテストは GitHub 非依存で決定的に fail（理由は must 以外）する。skip 条件は不要。
    const result = stepCheck("create_refined")(
      createRefinedCtx({ reviewBody: REVIEW_BODY_CLEAN, issueNumber: "999999999" }),
    );
    // GitHub 照合（存在しない番号）に進むため fail するが、理由は must ではない
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).not.toContain("must");
  });

  it("create_refined の buildPrompt は must 残存時の escalate→revise 誘導に一本化する", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain("escalate");
    expect(prompt).toContain("review_gate の revise");
    expect(prompt).not.toContain("新規セッション");
  });

  it("create_refined の buildPrompt は effort コメント初期値の一本化を明示し Q1/Q2 を持たない", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).not.toContain("Q1");
    expect(prompt).not.toContain("Q2");
    expect(prompt).toContain("初期値を決定値とする");
    expect(prompt).toContain("escalate");
  });

  it("review_gate は decision のみを持ち width/depth 質問を持たない", () => {
    const gate = def.steps.find((s) => s.key === "review_gate")!;
    const questions = gate.humanGate?.questions ?? [];
    expect(questions.map((q) => q.key)).toEqual(["decision"]);
    expect(gate.humanGate?.outcomeQuestionKey).toBe("decision");
  });

  it("create_refined の buildPrompt は番号検証手順（形式検証・escalate 分岐）を含む", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain("grep -Eq '^[0-9]+$'");
    expect(prompt).toContain("未検証の番号を渡さない");
  });

  it("review_body の buildPrompt は子 body 全件を必須レビュー対象とする", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = def.steps.find((s) => s.key === "review_body")!;
    const prompt = step.task!.buildPrompt({
      sessionDir,
      artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
    });
    expect(prompt).toContain("全件を必須レビュー対象");
    expect(prompt).not.toContain("保証対象外");
  });

  it("review_body の check は子 body 実在時に子言及なしで fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    const result = stepCheck("review_body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("子レビュー");
  });

  it("review_body の check は子 body 実在時に子言及があれば pass", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n| 対象 | issue-body-1.md |\n",
    );
    const result = stepCheck("review_body")(ctx);
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

  it("review_body の check は「対象外」一文のみでは子レビューとみなさず fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 0 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n\nissue-body-1.md は対象外とした。\n",
    );
    const result = stepCheck("review_body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("issue-body-1.md");
  });

  it("review_body の check は子ごとの対象見出しがあれば pass", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 対象: issue-body-1.md\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n",
    );
    const result = stepCheck("review_body")(ctx);
    expect(result.status).toBe("pass");
  });

  it("review_body の check は単漢字「子」のみでは子レビューとみなさず fail", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n指摘なし\n\n子供向けの表現に配慮した。\n",
    );
    const result = stepCheck("review_body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("子レビュー");
  });

  it("review_body の buildPrompt は review_gate での全文・差分の直接確認を指示する", () => {
    const repoInfoPath = path.join(sessionDir, "repo-info.json");
    fs.writeFileSync(
      repoInfoPath,
      JSON.stringify({ owner: "someone", repo: "x", nameWithOwner: "someone/x" }),
    );
    const step = def.steps.find((s) => s.key === "review_body")!;
    const prompt = step.task!.buildPrompt({
      sessionDir,
      artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
    });
    expect(prompt).toContain("review-body.md 全文");
    expect(prompt).toContain("grill-map");
  });

  it("create_refined の buildPrompt は effort 検証の grep に対象ファイルを指定する", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain('grep -E "<!-- effort: width=');
    expect(prompt).toContain("issue-body.md");
  });

  it("create_refined の buildPrompt は番号検証ループで存在しないパスの誤検出を避ける", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain('[ -f "$f" ] || continue');
  });

  it("create_refined の buildPrompt は Issue 作成ごとに直ちに番号を記録する", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain("1件作成するごとに直ちに");
    expect(prompt).toContain("issue-number-<n>.txt");
  });

  it("create_refined の buildPrompt は子未レビュー時の escalate ガードを含む", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain("子未レビュー");
    expect(prompt).toContain("escalate");
    expect(prompt).not.toContain("abort");
  });

  it("create_refined の check は子 body 実在時に子言及なしで fail（GitHub 照合の前に）", () => {
    const issueNumberPath = writeSessionFile("issue-number.txt", "123");
    const reviewBodyPath = writeSessionFile("review-body.md", REVIEW_BODY_CLEAN);
    writeSessionFile("issue-body-1.md", "## ✅ 完了条件\n\n- 子条件\n");
    const result = stepCheck("create_refined")(
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

  it("create_refined の check は must 表記ゆれ（must: 1 / must=1 / 全角数字）でも fail", () => {
    for (const variant of [
      "概要（指摘件数: must: 1 / should 0 / want 0）",
      "概要（指摘件数: must=1 / should 0 / want 0）",
      "概要（指摘件数: must １ / should 0 / want 0）",
      "概要（指摘件数: mustが2件 / should 0 / want 0）",
    ]) {
      const result = stepCheck("create_refined")(
        createRefinedCtx({
          reviewBody: `## レビュー結果\n\n${variant}\n\n## 指摘一覧\n\n指摘なし\n`,
        }),
      );
      expect(result.status).toBe("fail");
      expect(result.reasons.join("\n")).toContain("must");
    }
  });

  it("create_refined の check は絵文字のみの must 残存（🚨）でも fail", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n🚨 対応が必要\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create_refined の check はセクションのみで重み付け記載なしの review-body で fail", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody: "## レビュー結果\n\n概要\n\n## 指摘一覧\n\n何らかの記載\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("review-body.md");
  });

  it("create_refined の buildPrompt は親子番号の全件検証を要求する", () => {
    const step = def.steps.find((s) => s.key === "create_refined")!;
    const prompt = step.task!.buildPrompt({ sessionDir, artifacts: [] });
    expect(prompt).toContain("issue-number-*.txt");
    expect(prompt).toContain("全件");
    expect(prompt).toContain("escalate");
  });

  it("create_refined の check は漢数字の must 残存（must一件）で fail", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must一件 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create_refined の check は全角英字の must 残存（ＭＵＳＴ １）で fail", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: ＭＵＳＴ １ / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("create_refined の check は否定文（🚨なし）で must 理由では fail しない", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 0 / should 0 / want 0）🚨なし\n\n## 指摘一覧\n\n指摘なし\n",
        issueNumber: "999999999",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).not.toContain("must");
  });

  it("review_body の check は子2件で1件言及のみなら fail（全件要求）", () => {
    const ctx = reviewBodyCtx();
    fs.writeFileSync(path.join(sessionDir, "issue-body-1.md"), "## ✅ 完了条件\n\n- 子条件1\n");
    fs.writeFileSync(path.join(sessionDir, "issue-body-2.md"), "## ✅ 完了条件\n\n- 子条件2\n");
    fs.writeFileSync(
      path.join(sessionDir, "review-body.md"),
      "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n### 1. 指摘タイトル\n\n| 項目 | 内容 |\n| 優先度 | 🚨 must |\n| 対象 | issue-body-1.md |\n",
    );
    const result = stepCheck("review_body")(ctx);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("issue-body-2.md");
  });

  it("create_refined の check は概要 must 0 で本文の良性 must 1 英文があっても must 理由では fail しない", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 0 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n\nNote: the system must 1 time be restarted for verification.\n",
        issueNumber: "999999999",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).not.toContain("must");
  });

  it("create_refined の check は概要の must 1 申告で fail", () => {
    const result = stepCheck("create_refined")(
      createRefinedCtx({
        reviewBody:
          "## レビュー結果\n\n概要（指摘件数: must 1 / should 0 / want 0）\n\n## 指摘一覧\n\n指摘なし\n",
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("must");
  });

  it("owner分岐（withDocs）の3箇所は同期する", () => {
    const buildPrompt = (key: string, owner: string): string => {
      const repoInfoPath = path.join(sessionDir, "repo-info.json");
      fs.writeFileSync(
        repoInfoPath,
        JSON.stringify({ owner, repo: "x", nameWithOwner: `${owner}/x` }),
      );
      return def.steps
        .find((s) => s.key === key)!
        .task!.buildPrompt({
          sessionDir,
          artifacts: [artifactRecord("repo-info.json", repoInfoPath)],
        });
    };
    for (const key of ["grill", "draft_body", "review_body"]) {
      expect(buildPrompt(key, "t-miura-024")).toContain("mt-domain-modeling");
      expect(buildPrompt(key, "someone")).not.toContain("mt-domain-modeling");
    }
  });
});
