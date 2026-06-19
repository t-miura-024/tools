/**
 * audit.ts unit tests
 * Each test creates a fresh temp DB and writes a fixture plan.md / report.md
 * to drive the file-based checks.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DB = join(import.meta.dir, "db.ts");
const AUDIT = join(import.meta.dir, "audit.ts");

let workDir: string;
let dbPath: string;
let planPath: string;
let reportPath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "mt-deep-research-audittest-"));
  dbPath = join(workDir, "research.db");
  planPath = join(workDir, "plan.md");
  reportPath = join(workDir, "report.md");
  const proc = Bun.spawn(["bun", "run", DB, "init", "--db-path", dbPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error("init failed");
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", AUDIT, ...args], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

const VALID_PLAN = `# 計画書

## 背景・目的

背景

## 前提知識

前提

## 制約・スコープ

スコープ

## 主要な問い

1. 問い1
2. 問い2

## 検索戦略

検索戦略

## 期待されるレポート構成

構成

## 調査終了の判定基準

基準

## 調査の流れ（視覚化）

\`\`\`mermaid
graph LR
  A --> B
\`\`\`
`;

const VALID_REPORT = `# レポート

## 前提とスコープ

スコープ

## 作成日

2026-06-19

## 要約

要約

## 詳細な調査結果

事実 [1] 事実 [2]

## 情報源の一覧

| 番号 | タイトル | URL | 種類 | アクセス日 |
| --- | --- | --- | --- | --- |
| 1 | T | https://e.x | blog | 2026-06-19 |

## 調査対象の関係性（視覚化）

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`;

async function addQuestion(content: string, order: number, status: "draft" | "approved" = "approved"): Promise<number> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      DB,
      "question",
      "create",
      "--db-path",
      dbPath,
      "--content",
      content,
      "--order",
      String(order),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const id = JSON.parse(out).question.id as number;
  if (status === "approved") {
    await Bun.spawn(
      [
        "bun",
        "run",
        DB,
        "question",
        "update",
        "--db-path",
        dbPath,
        "--id",
        String(id),
        "--status",
        "approved",
      ],
      { stdout: "pipe", stderr: "pipe" },
    ).exited;
  }
  return id;
}

async function addEvidence(qid: number, withSources = true, withFacts = true): Promise<void> {
  const data = {
    question_id: qid,
    round_number: 1,
    summary: "ok",
    self_evaluation: { coverage: 0.8 },
    ...(withSources && { sources: [{ number: 1, title: "T", url: "https://e.x" }] }),
    ...(withFacts && { facts: [{ source_number: 1, fact_number: 1, content: "F" }] }),
  };
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      DB,
      "evidence",
      "save",
      "--db-path",
      dbPath,
      "--data",
      JSON.stringify(data),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

async function addReview(aspect: string, category: "must_fix" | "research_needed" | "suggestions" = "suggestions", qid?: number): Promise<void> {
  const data = {
    aspect,
    summary: "ok",
    verdict: "pass",
    findings: [
      {
        category,
        target_question_id: qid ?? null,
        content: "test finding",
      },
    ],
  };
  const proc = Bun.spawn(
    ["bun", "run", DB, "review", "save", "--db-path", dbPath, "--data", JSON.stringify(data)],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

describe("phase audit: planner", () => {
  it("fails when there are no questions", async () => {
    const r = await cli(["phase", "--phase", "planner", "--db-path", dbPath, "--plan-path", planPath]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("fail");
    expect(out.checks.find((c: { check_name: string }) => c.check_name === "questions_table_has_rows").status).toBe("fail");
  });

  it("passes when plan.md is valid and has questions", async () => {
    await addQuestion("Q?", 1);
    writeFileSync(planPath, VALID_PLAN, "utf-8");
    const r = await cli(["phase", "--phase", "planner", "--db-path", dbPath, "--plan-path", planPath]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.status).toBe("pass");
    for (const c of out.checks) expect(c.status).not.toBe("fail");
  });

  it("fails when plan.md is missing required sections", async () => {
    await addQuestion("Q?", 1);
    writeFileSync(planPath, "# 計画書\n\n## 背景・目的\n", "utf-8");
    const r = await cli(["phase", "--phase", "planner", "--db-path", dbPath, "--plan-path", planPath]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    const check = out.checks.find((c: { check_name: string }) => c.check_name === "plan_md_required_sections");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/missing/);
  });
});

describe("phase audit: researcher", () => {
  it("fails when no evidence rounds exist", async () => {
    const r = await cli(["phase", "--phase", "researcher", "--db-path", dbPath]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe("fail");
  });

  it("passes for a question with evidence and sources", async () => {
    const qid = await addQuestion("Q?", 1);
    await addEvidence(qid);
    const r = await cli([
      "phase",
      "--phase",
      "researcher",
      "--db-path",
      dbPath,
      "--question-id",
      String(qid),
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("pass");
  });

  it("fails for a question with no source", async () => {
    const qid = await addQuestion("Q?", 1);
    await addEvidence(qid, false, true);
    const r = await cli([
      "phase",
      "--phase",
      "researcher",
      "--db-path",
      dbPath,
      "--question-id",
      String(qid),
    ]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.checks.find((c: { check_name: string }) => c.check_name === "sources_present").status).toBe("fail");
  });
});

describe("phase audit: writer", () => {
  it("fails when report.md is missing", async () => {
    const r = await cli(["phase", "--phase", "writer", "--db-path", dbPath, "--report-path", reportPath]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe("fail");
  });

  it("passes when report.md is valid", async () => {
    writeFileSync(reportPath, VALID_REPORT, "utf-8");
    const r = await cli(["phase", "--phase", "writer", "--db-path", dbPath, "--report-path", reportPath]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("pass");
  });
});

describe("phase audit: reviewer", () => {
  it("fails when not all 5 aspects are covered", async () => {
    await addReview("coverage");
    const r = await cli(["phase", "--phase", "reviewer", "--db-path", dbPath]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    const check = out.checks.find((c: { check_name: string }) => c.check_name === "all_aspects_reviewed");
    expect(check.status).toBe("fail");
    expect(check.detail).toMatch(/sources/);
  });

  it("passes when all 5 aspects are covered", async () => {
    for (const a of ["coverage", "sources", "accuracy", "structure", "citations"]) {
      await addReview(a);
    }
    const r = await cli(["phase", "--phase", "reviewer", "--db-path", dbPath]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("pass");
  });
});

describe("cycle audit: research", () => {
  it("fails when no approved questions exist", async () => {
    await addQuestion("Q?", 1, "draft");
    const r = await cli(["cycle", "--cycle", "research", "--db-path", dbPath]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).status).toBe("fail");
  });

  it("fails when an approved question has no evidence", async () => {
    await addQuestion("Q?", 1);
    const r = await cli(["cycle", "--cycle", "research", "--db-path", dbPath]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.checks.find((c: { check_name: string }) => c.check_name === "all_approved_questions_have_rounds").status).toBe("fail");
  });

  it("passes when every approved question has rounds and sources", async () => {
    const qid = await addQuestion("Q?", 1);
    await addEvidence(qid);
    const r = await cli(["cycle", "--cycle", "research", "--db-path", dbPath]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("pass");
  });
});

describe("cycle audit: writer-reviewer", () => {
  it("fails on must_fix findings", async () => {
    writeFileSync(reportPath, VALID_REPORT, "utf-8");
    for (const a of ["coverage", "sources", "accuracy", "structure", "citations"]) {
      await addReview(a, a === "coverage" ? "must_fix" : "suggestions");
    }
    const r = await cli([
      "cycle",
      "--cycle",
      "writer-reviewer",
      "--db-path",
      dbPath,
      "--report-path",
      reportPath,
    ]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.checks.find((c: { check_name: string }) => c.check_name === "no_unresolved_must_fix").status).toBe("fail");
  });

  it("fails when research_needed has no follow-up round", async () => {
    writeFileSync(reportPath, VALID_REPORT, "utf-8");
    const qid = await addQuestion("Q?", 1);
    for (const a of ["coverage", "sources", "accuracy", "structure", "citations"]) {
      await addReview(a, "research_needed", qid);
    }
    const r = await cli([
      "cycle",
      "--cycle",
      "writer-reviewer",
      "--db-path",
      dbPath,
      "--report-path",
      reportPath,
    ]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.checks.find((c: { check_name: string }) => c.check_name === "research_needed_addressed").status).toBe("fail");
  });

  it("passes when all checks succeed", async () => {
    writeFileSync(reportPath, VALID_REPORT, "utf-8");
    const qid = await addQuestion("Q?", 1);
    await addEvidence(qid);
    // follow-up round (round_number > 1) so research_needed is "addressed"
    const data = {
      question_id: qid,
      round_number: 2,
      summary: "follow-up",
      sources: [{ number: 1, title: "T2", url: "https://e.y" }],
    };
    await Bun.spawn(
      ["bun", "run", DB, "evidence", "save", "--db-path", dbPath, "--data", JSON.stringify(data)],
      { stdout: "pipe" },
    ).exited;
    for (const a of ["coverage", "sources", "accuracy", "structure", "citations"]) {
      await addReview(a, "research_needed", qid);
    }
    const r = await cli([
      "cycle",
      "--cycle",
      "writer-reviewer",
      "--db-path",
      dbPath,
      "--report-path",
      reportPath,
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).status).toBe("pass");
  });
});

describe("audit persistence", () => {
  it("writes audit + checks to the DB so the orchestrator can read them back", async () => {
    await addQuestion("Q?", 1);
    writeFileSync(planPath, VALID_PLAN, "utf-8");
    await cli(["phase", "--phase", "planner", "--db-path", dbPath, "--plan-path", planPath]);

    const proc = Bun.spawn(
      ["bun", "run", DB, "snapshot", "--cycle", "research", "--db-path", dbPath],
      { stdout: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const snap = JSON.parse(out);
    // snapshot only returns research-shaped data, so we query the DB directly via bun:sqlite
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const audits = db.query("SELECT * FROM audits").all();
    const checks = db.query("SELECT * FROM audit_checks").all();
    expect(audits.length).toBeGreaterThan(0);
    expect(checks.length).toBeGreaterThan(0);
    db.close();
  });
});
