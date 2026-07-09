#!/usr/bin/env bun
/**
 * audit.ts — runs machine-check audits against the mt-deep-research DB.
 *
 * Subcommands:
 *   phase --phase <name> [--question-id N] [--db-path ...] [--plan-path ...] [--report-path ...]
 *   cycle --cycle <name> [--db-path ...] [--plan-path ...] [--report-path ...]
 *
 * Phases:  planner | researcher | writer | reviewer
 * Cycles:  research | writer-reviewer
 *
 * The script outputs audit results as JSON to stdout. Exit code reflects
 * the overall status: 0 = pass, 1 = fail, 2 = error.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { checkMermaid } from "./lint";

// -----------------------------------------------------------------------------
// CLI plumbing (mirrors db.ts)
// -----------------------------------------------------------------------------

type FlagMap = Record<string, string | boolean>;
export type AuditCheck = { check_name: string; status: "pass" | "fail" | "error" | "skip"; detail: string };
type CheckResult = AuditCheck & { check_name: string };

function parseArgs(argv: string[]): { positional: string[]; flags: FlagMap } {
  const positional: string[] = [];
  const flags: FlagMap = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

function out(value: unknown, exitCode: number): never {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}

function fail(message: string, code: 1 | 2 = 1): never {
  out({ success: false, error: message }, code);
}

function requireFlag(flags: FlagMap, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) fail(`Missing required flag --${name}`);
  return v;
}

function optionalFlag(flags: FlagMap, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function resolveDbPath(flags: FlagMap): string {
  const p = optionalFlag(flags, "db-path") ?? process.env.RESEARCH_DB;
  if (!p) fail("Missing --db-path (or RESEARCH_DB env)");
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

// -----------------------------------------------------------------------------
// Required markdown sections (file-based checks)
// -----------------------------------------------------------------------------

const PLAN_REQUIRED_SECTIONS = [
  "## 背景・目的",
  "## 前提知識",
  "## 制約・スコープ",
  "## 主要な問い",
  "## 検索戦略",
  "## 期待されるレポート構成",
  "## 調査終了の判定基準",
  "## 調査の流れ（視覚化）",
];

const REPORT_REQUIRED_SECTIONS = [
  "## 前提とスコープ",
  "## 作成日",
  "## 要約",
  "## 詳細な調査結果",
  "## 情報源の一覧",
  "## 調査対象の関係性（視覚化）",
];

const REVIEW_ASPECTS = ["coverage", "sources", "accuracy", "structure", "citations"];

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function openDb(dbPath: string): Database {
  if (!existsSync(dbPath)) fail(`Database file not found: ${dbPath}. Did you run 'init' first?`);
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function readFileOrNull(path: string | null): string | null {
  if (!path) return null;
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

function checkMissingSections(content: string, required: string[]): string[] {
  return required.filter((s) => !content.includes(s));
}

function countCitationNumbers(content: string): number {
  const matches = content.match(/\[\d+\]/g) ?? [];
  return matches.length;
}

function deriveDefaultPath(dbPath: string, filename: string): string {
  return resolve(dirname(dbPath), filename);
}

// -----------------------------------------------------------------------------
// Phase audits
// -----------------------------------------------------------------------------

export function auditPlanner(db: Database, planPath: string): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const questionCount = db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM questions")
    .get()?.c ?? 0;
  checks.push({
    check_name: "questions_table_has_rows",
    status: questionCount > 0 ? "pass" : "fail",
    detail: `questions count: ${questionCount}`,
  });
  const planContent = readFileOrNull(planPath);
  checks.push({
    check_name: "plan_md_exists",
    status: planContent ? "pass" : "fail",
    detail: planPath,
  });
  if (planContent) {
    const missing = checkMissingSections(planContent, PLAN_REQUIRED_SECTIONS);
    checks.push({
      check_name: "plan_md_required_sections",
      status: missing.length === 0 ? "pass" : "fail",
      detail: missing.length === 0 ? "all required sections present" : `missing: ${missing.join(", ")}`,
    });
    const mermaidErrors = checkMermaid(planContent);
    checks.push({
      check_name: "plan_md_has_mermaid",
      status: mermaidErrors.length === 0 ? "pass" : "fail",
      detail: mermaidErrors.length === 0 ? "mermaid block found" : `mermaid errors: ${mermaidErrors.map((e) => e.message).join("; ")}`,
    });
  } else {
    checks.push({
      check_name: "plan_md_required_sections",
      status: "skip",
      detail: "plan.md missing",
    });
    checks.push({
      check_name: "plan_md_has_mermaid",
      status: "skip",
      detail: "plan.md missing",
    });
  }
  const statusRows = db
    .query<{ status: string; c: number }, []>(
      "SELECT status, COUNT(*) AS c FROM questions GROUP BY status",
    )
    .all();
  const approved = statusRows.find((r) => r.status === "approved")?.c ?? 0;
  checks.push({
    check_name: "questions_status_distribution",
    status: "pass",
    detail: `approved=${approved} total=${questionCount}`,
  });
  return checks;
}

export function auditResearcher(
  db: Database,
  questionId?: number,
): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const targetQuestion = questionId
    ? db
        .query<{ id: number; status: string }, [number]>(
          "SELECT id, status FROM questions WHERE id = ?",
        )
        .get(questionId)
    : null;
  if (questionId && !targetQuestion) {
    checks.push({
      check_name: "question_exists",
      status: "fail",
      detail: `question ${questionId} not found`,
    });
    return checks;
  }
  const rounds = targetQuestion
    ? db
        .query<{ id: number; question_id: number; round_number: number }, [number]>(
          "SELECT * FROM evidence_rounds WHERE question_id = ?",
        )
        .all(questionId)
    : db
        .query<
          { id: number; question_id: number; round_number: number },
          []
        >("SELECT * FROM evidence_rounds")
        .all();
  checks.push({
    check_name: "evidence_rounds_exist",
    status: rounds.length > 0 ? "pass" : "fail",
    detail: `rounds count: ${rounds.length}`,
  });
  if (rounds.length === 0) return checks;
  const noSource: string[] = [];
  for (const r of rounds) {
    const srcCount = db
      .query<{ c: number }, [number]>(
        "SELECT COUNT(*) AS c FROM sources WHERE evidence_round_id = ?",
      )
      .get(r.id)?.c ?? 0;
    if (srcCount === 0) noSource.push(`round ${r.id} (q=${r.question_id} #${r.round_number})`);
  }
  checks.push({
    check_name: "sources_present",
    status: noSource.length === 0 ? "pass" : "fail",
    detail:
      noSource.length === 0 ? "every round has at least one source" : `rounds without sources: ${noSource.join(", ")}`,
  });
  return checks;
}

export function auditWriter(db: Database, reportPath: string): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const content = readFileOrNull(reportPath);
  checks.push({
    check_name: "report_md_exists",
    status: content ? "pass" : "fail",
    detail: reportPath,
  });
  if (!content) {
    checks.push({
      check_name: "report_md_required_sections",
      status: "skip",
      detail: "report.md missing",
    });
    checks.push({
      check_name: "report_md_has_citations",
      status: "skip",
      detail: "report.md missing",
    });
    checks.push({
      check_name: "report_md_has_mermaid",
      status: "skip",
      detail: "report.md missing",
    });
    return checks;
  }
  const missing = checkMissingSections(content, REPORT_REQUIRED_SECTIONS);
  checks.push({
    check_name: "report_md_required_sections",
    status: missing.length === 0 ? "pass" : "fail",
    detail: missing.length === 0 ? "all required sections present" : `missing: ${missing.join(", ")}`,
  });
  const citationCount = countCitationNumbers(content);
  checks.push({
    check_name: "report_md_has_citations",
    status: citationCount > 0 ? "pass" : "fail",
    detail: `citation occurrences: ${citationCount}`,
  });
  const mermaidErrors = checkMermaid(content);
  checks.push({
    check_name: "report_md_has_mermaid",
    status: mermaidErrors.length === 0 ? "pass" : "fail",
    detail: mermaidErrors.length === 0 ? "mermaid block found" : `mermaid errors: ${mermaidErrors.map((e) => e.message).join("; ")}`,
  });
  return checks;
}

export function auditReviewer(db: Database): AuditCheck[] {
  const checks: AuditCheck[] = [];
  const rows = db
    .query<{ aspect: string; c: number }, [string]>(
      `SELECT aspect, MAX(round_number) AS c
         FROM reviews GROUP BY aspect`,
    )
    .all();
  const covered = new Set(rows.map((r) => r.aspect));
  const missingAspects = REVIEW_ASPECTS.filter((a) => !covered.has(a));
  checks.push({
    check_name: "all_aspects_reviewed",
    status: missingAspects.length === 0 ? "pass" : "fail",
    detail:
      missingAspects.length === 0
        ? `all 5 aspects covered`
        : `missing aspects: ${missingAspects.join(", ")}`,
  });
  const reviewsWithoutFindings: string[] = [];
  for (const r of db
    .query<{ id: number; aspect: string; round_number: number }, []>(
      "SELECT * FROM reviews",
    )
    .all()) {
    const c = db
      .query<{ c: number }, [number]>(
        "SELECT COUNT(*) AS c FROM review_findings WHERE review_id = ?",
      )
      .get(r.id)?.c ?? 0;
    if (c === 0) reviewsWithoutFindings.push(`${r.aspect}#${r.round_number}`);
  }
  checks.push({
    check_name: "all_reviews_have_findings",
    status: reviewsWithoutFindings.length === 0 ? "pass" : "fail",
    detail:
      reviewsWithoutFindings.length === 0
        ? "all reviews have findings"
        : `reviews without findings: ${reviewsWithoutFindings.join(", ")}`,
  });
  return checks;
}

// -----------------------------------------------------------------------------
// Cycle audits
// -----------------------------------------------------------------------------

export function auditResearchCycle(db: Database): AuditCheck[] {
  const checks: AuditCheck[] = auditResearcher(db);
  const approved = db
    .query<{ id: number; content: string }, []>(
      "SELECT id, content FROM questions WHERE status = 'approved'",
    )
    .all();
  if (approved.length === 0) {
    checks.push({
      check_name: "approved_questions_exist",
      status: "fail",
      detail: "no approved questions",
    });
    return checks;
  }
  const uncovered: number[] = [];
  for (const q of approved) {
    const c = db
      .query<{ c: number }, [number]>(
        "SELECT COUNT(*) AS c FROM evidence_rounds WHERE question_id = ?",
      )
      .get(q.id)?.c ?? 0;
    if (c === 0) uncovered.push(q.id);
  }
  checks.push({
    check_name: "all_approved_questions_have_rounds",
    status: uncovered.length === 0 ? "pass" : "fail",
    detail:
      uncovered.length === 0
        ? `all ${approved.length} approved questions have rounds`
        : `questions without rounds: ${uncovered.join(", ")}`,
  });
  const unresolved = db
    .query<{ id: number; content: string }, []>(
      "SELECT id, content FROM off_topic_questions WHERE decision IS NULL OR decision = 'pending'",
    )
    .all();
  checks.push({
    check_name: "off_topic_resolved",
    status: unresolved.length === 0 ? "pass" : "fail",
    detail:
      unresolved.length === 0
        ? "all off_topic_questions resolved"
        : `unresolved: ${unresolved.length}`,
  });
  return checks;
}

export function auditWriterReviewerCycle(db: Database, reportPath: string): AuditCheck[] {
  const checks: AuditCheck[] = [...auditWriter(db, reportPath), ...auditReviewer(db)];
  const mustFix = db
    .query<{ c: number }, []>(
      `SELECT COUNT(*) AS c FROM review_findings WHERE category = 'must_fix'`,
    )
    .get()?.c ?? 0;
  checks.push({
    check_name: "no_unresolved_must_fix",
    status: mustFix === 0 ? "pass" : "fail",
    detail: mustFix === 0 ? "no must_fix findings" : `must_fix count: ${mustFix}`,
  });
  const researchNeeded = db
    .query<{ target_question_id: number | null; c: number }, []>(
      `SELECT target_question_id, COUNT(*) AS c
         FROM review_findings
        WHERE category = 'research_needed'
        GROUP BY target_question_id`,
    )
    .all();
  if (researchNeeded.length === 0) {
    checks.push({
      check_name: "research_needed_addressed",
      status: "pass",
      detail: "no research_needed findings",
    });
    return checks;
  }
  const unaddressed: number[] = [];
  for (const rn of researchNeeded) {
    if (rn.target_question_id == null) {
      unaddressed.push(-1);
      continue;
    }
    const extra = db
      .query<{ c: number }, [number]>(
        "SELECT COUNT(*) AS c FROM evidence_rounds WHERE question_id = ? AND round_number > 1",
      )
      .get(rn.target_question_id)?.c ?? 0;
    if (extra === 0) unaddressed.push(rn.target_question_id);
  }
  checks.push({
    check_name: "research_needed_addressed",
    status: unaddressed.length === 0 ? "pass" : "fail",
    detail:
      unaddressed.length === 0
        ? "all research_needed items have follow-up rounds"
        : `questions needing follow-up: ${unaddressed.join(", ")}`,
  });
  return checks;
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

function overallStatus(checks: AuditCheck[]): "pass" | "fail" | "error" {
  if (checks.some((c) => c.status === "error")) return "error";
  if (checks.some((c) => c.status === "fail")) return "fail";
  return "pass";
}

function runPhase(flags: FlagMap): never {
  const phase = requireFlag(flags, "phase");
  const dbPath = resolveDbPath(flags);
  const questionId = optionalFlag(flags, "question-id");
  const planPath = optionalFlag(flags, "plan-path") ?? deriveDefaultPath(dbPath, "plan.md");
  const reportPath = optionalFlag(flags, "report-path") ?? deriveDefaultPath(dbPath, "report.md");
  const db = openDb(dbPath);
  let checks: AuditCheck[];
  try {
    switch (phase) {
      case "planner":
        checks = auditPlanner(db, planPath);
        break;
      case "researcher":
        checks = auditResearcher(db, questionId ? Number(questionId) : undefined);
        break;
      case "writer":
        checks = auditWriter(db, reportPath);
        break;
      case "reviewer":
        checks = auditReviewer(db);
        break;
      default:
        fail(`Unknown phase: ${phase}`);
    }
  } catch (e) {
    fail(`audit phase error: ${String(e)}`, 2);
  }
  const status = overallStatus(checks);
  const summary = `${checks.filter((c) => c.status === "pass").length} pass / ${checks.filter((c) => c.status === "fail").length} fail / ${checks.filter((c) => c.status === "skip").length} skip`;
  out(
    {
      success: status !== "error",
      target_type: "phase",
      target_phase: phase,
      status,
      summary,
      checks,
    },
    status === "pass" ? 0 : 1,
  );
}

function runCycle(flags: FlagMap): never {
  const cycle = requireFlag(flags, "cycle");
  const dbPath = resolveDbPath(flags);
  const planPath = optionalFlag(flags, "plan-path") ?? deriveDefaultPath(dbPath, "plan.md");
  const reportPath = optionalFlag(flags, "report-path") ?? deriveDefaultPath(dbPath, "report.md");
  const db = openDb(dbPath);
  let checks: AuditCheck[];
  try {
    switch (cycle) {
      case "research":
        checks = auditResearchCycle(db);
        break;
      case "writer-reviewer":
        checks = auditWriterReviewerCycle(db, reportPath);
        break;
      default:
        fail(`Unknown cycle: ${cycle}`);
    }
  } catch (e) {
    fail(`audit cycle error: ${String(e)}`, 2);
  }
  const status = overallStatus(checks);
  const summary = `${checks.filter((c) => c.status === "pass").length} pass / ${checks.filter((c) => c.status === "fail").length} fail / ${checks.filter((c) => c.status === "skip").length} skip`;
  out(
    {
      success: status !== "error",
      target_type: "cycle",
      target_cycle: cycle,
      status,
      summary,
      checks,
    },
    status === "pass" ? 0 : 1,
  );
}

function main(): void {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const [resource] = positional;
  switch (resource) {
    case "phase":
      return runPhase(flags);
    case "cycle":
      return runCycle(flags);
    case undefined:
    case "":
      fail("Usage: audit.ts <phase|cycle> ...");
    default:
      fail(`Unknown subcommand: ${resource}`);
  }
}

if (import.meta.main) main();
