/**
 * db.ts unit tests
 * Each test creates a fresh temp DB, invokes the CLI via Bun.spawn,
 * and asserts on the JSON output and final DB state.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "db.ts");

let workDir: string;
let dbPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mt-deep-research-dbtest-"));
  dbPath = join(workDir, "research.db");
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

type CliResult = { stdout: string; stderr: string; exitCode: number };

async function run(args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

function dbArgs(extra: string[] = []): string[] {
  return ["--db-path", dbPath, ...extra];
}

describe("init", () => {
  it("creates the DB and loads all expected tables", async () => {
    const r = await run(["init", ...dbArgs()]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.success).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
    for (const t of [
      "questions",
      "evidence_rounds",
      "sources",
      "facts",
      "off_topic_questions",
      "reviews",
      "review_findings",
      "audits",
      "audit_checks",
      "iterations",
      "execution_logs",
    ]) {
      expect(out.tables).toContain(t);
    }
  });

  it("fails with a clear error when --db-path is missing", async () => {
    const r = await run(["init"]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/--db-path/);
  });
});

describe("question", () => {
  beforeEach(async () => {
    const r = await run(["init", ...dbArgs()]);
    if (r.exitCode !== 0) throw new Error("init failed: " + r.stderr);
  });

  it("creates, lists, gets, and updates a question", async () => {
    const c1 = await run([
      "question",
      "create",
      ...dbArgs(["--content", "Q1?", "--rationale", "Because", "--order", "1"]),
    ]);
    expect(c1.exitCode).toBe(0);
    const created = JSON.parse(c1.stdout).question;
    expect(created.id).toBeGreaterThan(0);
    expect(created.status).toBe("draft");
    expect(created.display_order).toBe(1);

    const c2 = await run([
      "question",
      "create",
      ...dbArgs(["--content", "Q2?"]),
    ]);
    expect(c2.exitCode).toBe(0);
    expect(JSON.parse(c2.stdout).question.display_order).toBe(2);

    const list = await run(["question", "list", ...dbArgs()]);
    const listOut = JSON.parse(list.stdout);
    expect(listOut.questions).toHaveLength(2);
    expect(listOut.questions[0].display_order).toBe(1);

    const upd = await run([
      "question",
      "update",
      ...dbArgs(["--id", String(created.id), "--status", "approved"]),
    ]);
    expect(JSON.parse(upd.stdout).question.status).toBe("approved");

    const filt = await run([
      "question",
      "list",
      ...dbArgs(["--status", "approved"]),
    ]);
    const filtOut = JSON.parse(filt.stdout);
    expect(filtOut.questions).toHaveLength(1);
  });

  it("rejects unknown question actions", async () => {
    const r = await run(["question", "bogus", ...dbArgs()]);
    expect(r.exitCode).toBe(1);
  });
});

describe("evidence save", () => {
  beforeEach(async () => {
    const r = await run(["init", ...dbArgs()]);
    if (r.exitCode !== 0) throw new Error("init failed");
  });

  it("saves a round with sources, facts, and off_topic questions atomically", async () => {
    const c = await run([
      "question",
      "create",
      ...dbArgs(["--content", "Q?", "--order", "1"]),
    ]);
    const qid = JSON.parse(c.stdout).question.id;

    const payload = {
      question_id: qid,
      round_number: 1,
      summary: "first round",
      self_evaluation: { coverage: 0.6, gaps: ["x"] },
      sources: [
        { number: 1, title: "Doc", url: "https://example.com", kind: "blog", accessed_at: "2026-06-19" },
        { number: 2, title: "Other", url: "https://example.org", kind: "official" },
      ],
      facts: [
        { source_number: 1, fact_number: 1, content: "Fact 1" },
        { source_number: 2, fact_number: 1, content: "Fact 2" },
      ],
      off_topic_questions: [
        { content: "Off Q?", reason: "tangential" },
      ],
    };
    const r = await run([
      "evidence",
      "save",
      ...dbArgs(["--data", JSON.stringify(payload)]),
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.success).toBe(true);
    expect(out.evidence_round_id).toBeGreaterThan(0);
    expect(out.source_count).toBe(2);
  });

  it("fails when data is not valid JSON", async () => {
    const r = await run([
      "evidence",
      "save",
      ...dbArgs(["--data", "not json"]),
    ]);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toMatch(/Invalid JSON/);
  });
});

describe("review / audit / iteration / log save", () => {
  beforeEach(async () => {
    const r = await run(["init", ...dbArgs()]);
    if (r.exitCode !== 0) throw new Error("init failed");
  });

  it("saves a review with findings", async () => {
    const r = await run([
      "review",
      "save",
      ...dbArgs([
        "--data",
        JSON.stringify({
          aspect: "coverage",
          summary: "OK",
          verdict: "needs_work",
          findings: [
            { category: "must_fix", content: "Fix citation" },
            { category: "suggestions", content: "Add summary table" },
          ],
        }),
      ]),
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.finding_count).toBe(2);
  });

  it("saves an audit with checks", async () => {
    const r = await run([
      "audit",
      "save",
      ...dbArgs([
        "--data",
        JSON.stringify({
          target_type: "phase",
          target_phase: "planner",
          status: "pass",
          summary: "all good",
          checks: [
            { check_name: "schema_check", status: "pass" },
            { check_name: "required_records_check", status: "pass" },
          ],
        }),
      ]),
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).check_count).toBe(2);
  });

  it("saves an iteration", async () => {
    const r = await run([
      "iteration",
      "save",
      ...dbArgs([
        "--data",
        JSON.stringify({ loop_number: 1, iteration_type: "writer_fix", summary: "fix citations" }),
      ]),
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).iteration_id).toBeGreaterThan(0);
  });

  it("saves an execution log", async () => {
    const r = await run([
      "log",
      "save",
      ...dbArgs([
        "--data",
        JSON.stringify({ command: "test", args: { foo: 1 }, status: "ok", duration_ms: 12 }),
      ]),
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).log_id).toBeGreaterThan(0);
  });
});

describe("snapshot", () => {
  beforeEach(async () => {
    const r = await run(["init", ...dbArgs()]);
    if (r.exitCode !== 0) throw new Error("init failed");
  });

  it("emits a research-cycle snapshot", async () => {
    const c = await run([
      "question",
      "create",
      ...dbArgs(["--content", "Q?", "--order", "1"]),
    ]);
    const qid = JSON.parse(c.stdout).question.id;
    await run([
      "evidence",
      "save",
      ...dbArgs([
        "--data",
        JSON.stringify({
          question_id: qid,
          round_number: 1,
          summary: "ok",
          sources: [{ number: 1, title: "T", url: "https://e.x" }],
        }),
      ]),
    ]);

    const r = await run(["snapshot", "--cycle", "research", ...dbArgs()]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.cycle).toBe("research");
    expect(out.questions).toHaveLength(1);
    expect(out.evidence_rounds).toHaveLength(1);
    expect(out.sources).toHaveLength(1);
  });

  it("emits a writer-reviewer snapshot that includes the report when --report-path is given", async () => {
    const reportPath = join(workDir, "report.md");
    await Bun.write(reportPath, "# Report\n\nHello.");
    const r = await run([
      "snapshot",
      "--cycle",
      "writer-reviewer",
      ...dbArgs(["--report-path", reportPath]),
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.cycle).toBe("writer-reviewer");
    expect(out.report).toContain("Hello.");
  });

  it("rejects an unknown cycle", async () => {
    const r = await run(["snapshot", "--cycle", "bogus", ...dbArgs()]);
    expect(r.exitCode).toBe(1);
  });
});
