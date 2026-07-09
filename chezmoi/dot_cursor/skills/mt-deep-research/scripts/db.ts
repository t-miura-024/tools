#!/usr/bin/env bun
/**
 * db.ts — CLI wrapper around the mt-deep-research SQLite database.
 *
 * Subcommands:
 *   init --db-path <path>            Create the DB and load schema.sql.
 *   question <action> [args...]      create | list | get | update
 *   evidence save --data <json>      Atomic bulk save for a research round.
 *   review save --data <json>        Atomic bulk save for a review.
 *   iteration save --data <json>     Save an iteration record.
 *   log save --data <json>           Save a script execution log.
 *   snapshot --cycle <name>          Emit a JSON snapshot for the auditor.
 *
 * All output is JSON. Errors are emitted as `{ success: false, error: "..." }`
 * and the process exits with code 1.
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";

// -----------------------------------------------------------------------------
// CLI plumbing
// -----------------------------------------------------------------------------

type FlagMap = Record<string, string | boolean>;

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

function output(value: unknown): never {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(0);
}

function fail(message: string, extra: Record<string, unknown> = {}): never {
  process.stdout.write(
    JSON.stringify({ success: false, error: message, ...extra }, null, 2) + "\n",
  );
  process.exit(1);
}

function requireFlag(flags: FlagMap, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) {
    fail(`Missing required flag --${name}`);
  }
  return v;
}

function optionalFlag(flags: FlagMap, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function parseJsonFlag(flags: FlagMap, name: string): unknown {
  const raw = requireFlag(flags, name);
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`Invalid JSON in --${name}`, { detail: String(e) });
  }
}

function resolveDbPath(flags: FlagMap): string {
  const p = optionalFlag(flags, "db-path") ?? process.env.RESEARCH_DB;
  if (!p) fail("Missing --db-path (or RESEARCH_DB env)");
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function openDb(dbPath: string, { readOnly = false }: { readOnly?: boolean } = {}): Database {
  if (!existsSync(dbPath) && !readOnly) {
    fail(`Database file not found: ${dbPath}. Did you run 'init' first?`);
  }
  const db = new Database(dbPath, readOnly ? { readonly: true } : undefined);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function schemaPath(): string {
  return resolve(import.meta.dir, "schema.sql");
}

// -----------------------------------------------------------------------------
// init
// -----------------------------------------------------------------------------

function cmdInit(flags: FlagMap): never {
  const dbPath = resolveDbPath(flags);
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const sql = readFileSync(schemaPath(), "utf-8");
  const db = new Database(dbPath);
  try {
    db.exec(sql);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    output({ success: true, dbPath, tables });
  } finally {
    db.close();
  }
}

// -----------------------------------------------------------------------------
// question
// -----------------------------------------------------------------------------

type QuestionRow = {
  id: number;
  content: string;
  rationale: string | null;
  display_order: number;
  status: string;
  created_at: string;
  updated_at: string;
};

function cmdQuestion(action: string, flags: FlagMap): never {
  const db = openDb(resolveDbPath(flags));
  try {
    switch (action) {
      case "create": {
        const content = requireFlag(flags, "content");
        const rationale = optionalFlag(flags, "rationale") ?? null;
        const orderRaw = optionalFlag(flags, "order");
        const display_order = orderRaw ? Number(orderRaw) : nextOrder(db);
        if (!Number.isInteger(display_order)) fail("--order must be an integer");
        const stmt = db.prepare(
          `INSERT INTO questions (content, rationale, display_order)
           VALUES (?, ?, ?)
           RETURNING *`,
        );
        const row = stmt.get(content, rationale, display_order) as QuestionRow;
        output({ success: true, question: row });
      }
      case "list": {
        const status = optionalFlag(flags, "status");
        const rows = status
          ? (db
              .query<QuestionRow, [string]>(
                "SELECT * FROM questions WHERE status = ? ORDER BY display_order",
              )
              .all(status) as QuestionRow[])
          : (db
              .query<QuestionRow, []>("SELECT * FROM questions ORDER BY display_order")
              .all() as QuestionRow[]);
        output({ success: true, questions: rows });
      }
      case "get": {
        const id = Number(requireFlag(flags, "id"));
        const row = db
          .query<QuestionRow, [number]>("SELECT * FROM questions WHERE id = ?")
          .get(id) as QuestionRow | null;
        if (!row) fail(`Question ${id} not found`);
        output({ success: true, question: row });
      }
      case "update": {
        const id = Number(requireFlag(flags, "id"));
        const status = optionalFlag(flags, "status");
        const content = optionalFlag(flags, "content");
        const rationale = optionalFlag(flags, "rationale");
        if (!status && !content && !rationale) fail("No updatable field provided");
        const sets: string[] = ["updated_at = datetime('now')"];
        const params: (string | number)[] = [];
        if (status) {
          sets.push("status = ?");
          params.push(status);
        }
        if (content) {
          sets.push("content = ?");
          params.push(content);
        }
        if (rationale) {
          sets.push("rationale = ?");
          params.push(rationale);
        }
        params.push(id);
        const row = db
          .query<QuestionRow, (string | number)[]>(
            `UPDATE questions SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
          )
          .get(...params) as QuestionRow | null;
        if (!row) fail(`Question ${id} not found`);
        output({ success: true, question: row });
      }
      default:
        fail(`Unknown question action: ${action}`);
    }
  } finally {
    db.close();
  }
}

function nextOrder(db: Database): number {
  const row = db
    .query<{ next: number | null }, []>("SELECT COALESCE(MAX(display_order), 0) + 1 AS next FROM questions")
    .get();
  return row?.next ?? 1;
}

// -----------------------------------------------------------------------------
// evidence save (atomic bulk insert)
// -----------------------------------------------------------------------------

type SourceInput = {
  number: number;
  title: string;
  url: string;
  kind?: string;
  accessed_at?: string;
};
type FactInput = { source_number: number; fact_number: number; content: string };
type OffTopicInput = { content: string; reason?: string; decision?: string };

function cmdEvidenceSave(flags: FlagMap): never {
  const db = openDb(resolveDbPath(flags));
  const data = parseJsonFlag(flags, "data") as {
    question_id: number;
    round_number: number;
    summary?: string;
    self_evaluation?: unknown;
    sources?: SourceInput[];
    facts?: FactInput[];
    off_topic_questions?: OffTopicInput[];
  };
  if (typeof data.question_id !== "number") fail("data.question_id must be a number");
  if (typeof data.round_number !== "number") fail("data.round_number must be a number");

  const tx = db.transaction(() => {
    const roundRow = db
      .query<
        { id: number; question_id: number; round_number: number },
        [number, number]
      >(
        `INSERT INTO evidence_rounds (question_id, round_number, summary, self_evaluation)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (question_id, round_number) DO UPDATE SET
           summary = excluded.summary,
           self_evaluation = excluded.self_evaluation
         RETURNING id, question_id, round_number`,
      )
      .get(
        data.question_id,
        data.round_number,
        data.summary ?? null,
        data.self_evaluation !== undefined ? JSON.stringify(data.self_evaluation) : null,
      );
    if (!roundRow) fail("Failed to insert evidence_round");

    const evidenceRoundId = roundRow.id;

    const sourceIds: number[] = [];
    if (Array.isArray(data.sources)) {
      for (const s of data.sources) {
        const row = db
          .query<
            { id: number },
            [number, number, string, string, string | null, string | null]
          >(
            `INSERT INTO sources (evidence_round_id, source_number, title, url, kind, accessed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (evidence_round_id, source_number) DO UPDATE SET
               title = excluded.title,
               url = excluded.url,
               kind = excluded.kind,
               accessed_at = excluded.accessed_at
             RETURNING id`,
          )
          .get(evidenceRoundId, s.number, s.title, s.url, s.kind ?? null, s.accessed_at ?? null);
        if (row) sourceIds.push(row.id);
      }
    }
    if (Array.isArray(data.facts)) {
      for (const f of data.facts) {
        db.query(
          `INSERT INTO facts (evidence_round_id, source_number, fact_number, content)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (evidence_round_id, source_number, fact_number) DO UPDATE SET
             content = excluded.content`,
        ).run(evidenceRoundId, f.source_number, f.fact_number, f.content);
      }
    }
    if (Array.isArray(data.off_topic_questions)) {
      for (const o of data.off_topic_questions) {
        db.query(
          `INSERT INTO off_topic_questions (evidence_round_id, content, reason, decision)
           VALUES (?, ?, ?, ?)`,
        ).run(evidenceRoundId, o.content, o.reason ?? null, o.decision ?? "pending");
      }
    }
    return { evidence_round_id: evidenceRoundId, source_count: sourceIds.length };
  });

  try {
    const result = tx();
    output({ success: true, ...result });
  } catch (e) {
    fail("evidence save failed", { detail: String(e) });
  } finally {
    db.close();
  }
}

// -----------------------------------------------------------------------------
// review save
// -----------------------------------------------------------------------------

type ReviewFindingInput = {
  category: "must_fix" | "research_needed" | "suggestions";
  target_question_id?: number;
  target_section?: string;
  content: string;
};

function cmdReviewSave(flags: FlagMap): never {
  const db = openDb(resolveDbPath(flags));
  const data = parseJsonFlag(flags, "data") as {
    aspect: string;
    round_number?: number;
    summary?: string;
    verdict?: string;
    findings?: ReviewFindingInput[];
  };
  if (!data.aspect) fail("data.aspect is required");

  const tx = db.transaction(() => {
    const round = data.round_number ?? nextReviewRound(db, data.aspect);
    const reviewRow = db
      .query<{ id: number; round_number: number }, [string, number, string | null, string | null]>(
        `INSERT INTO reviews (aspect, round_number, summary, verdict)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (aspect, round_number) DO UPDATE SET
           summary = excluded.summary,
           verdict = excluded.verdict
         RETURNING id, round_number`,
      )
      .get(data.aspect, round, data.summary ?? null, data.verdict ?? null);
    if (!reviewRow) fail("Failed to insert review");

    let findings = 0;
    if (Array.isArray(data.findings)) {
      for (const f of data.findings) {
        db.query(
          `INSERT INTO review_findings (review_id, category, target_question_id, target_section, content)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          reviewRow.id,
          f.category,
          f.target_question_id ?? null,
          f.target_section ?? null,
          f.content,
        );
        findings++;
      }
    }
    return { review_id: reviewRow.id, round_number: reviewRow.round_number, finding_count: findings };
  });

  try {
    const result = tx();
    output({ success: true, ...result });
  } catch (e) {
    fail("review save failed", { detail: String(e) });
  } finally {
    db.close();
  }
}

function nextReviewRound(db: Database, aspect: string): number {
  const row = db
    .query<{ next: number | null }, [string]>(
      "SELECT COALESCE(MAX(round_number), 0) + 1 AS next FROM reviews WHERE aspect = ?",
    )
    .get(aspect);
  return row?.next ?? 1;
}

// -----------------------------------------------------------------------------
// iteration save
// -----------------------------------------------------------------------------

function cmdIterationSave(flags: FlagMap): never {
  const db = openDb(resolveDbPath(flags));
  const data = parseJsonFlag(flags, "data") as {
    loop_number: number;
    iteration_type: "writer_fix" | "researcher_revisit" | "audit_retry";
    triggered_by_audit?: number;
    summary?: string;
  };
  const result = db
    .query<
      { id: number },
      [number, string, number | null, string | null]
    >(
      `INSERT INTO iterations (loop_number, iteration_type, triggered_by_audit, summary)
       VALUES (?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      data.loop_number,
      data.iteration_type,
      data.triggered_by_audit ?? null,
      data.summary ?? null,
    );
  if (!result) fail("Failed to insert iteration");
  output({ success: true, iteration_id: result.id });
  db.close();
}

// -----------------------------------------------------------------------------
// execution_log save
// -----------------------------------------------------------------------------

function cmdLogSave(flags: FlagMap): never {
  const db = openDb(resolveDbPath(flags));
  const data = parseJsonFlag(flags, "data") as {
    command: string;
    args?: unknown;
    status: "ok" | "error";
    message?: string;
    duration_ms?: number;
  };
  const result = db
    .query<{ id: number }, [string, string | null, string, string | null, number | null]>(
      `INSERT INTO execution_logs (command, args, status, message, duration_ms)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      data.command,
      data.args !== undefined ? JSON.stringify(data.args) : null,
      data.status,
      data.message ?? null,
      data.duration_ms ?? null,
    );
  if (!result) fail("Failed to insert execution_log");
  output({ success: true, log_id: result.id });
  db.close();
}

// -----------------------------------------------------------------------------
// snapshot
// -----------------------------------------------------------------------------

function cmdSnapshot(flags: FlagMap): never {
  const dbPath = resolveDbPath(flags);
  const cycle = requireFlag(flags, "cycle");
  const reportPath = optionalFlag(flags, "report-path");

  const db = openDb(dbPath, { readOnly: true });
  try {
    if (cycle === "research") {
      const questions = db
        .query<QuestionRow, []>("SELECT * FROM questions ORDER BY display_order")
        .all();
      const rounds = db
        .query<
          {
            id: number;
            question_id: number;
            round_number: number;
            summary: string | null;
            self_evaluation: string | null;
          },
          []
        >("SELECT * FROM evidence_rounds ORDER BY question_id, round_number")
        .all();
      const sources = db
        .query<
          {
            id: number;
            evidence_round_id: number;
            source_number: number;
            title: string;
            url: string;
            kind: string | null;
            accessed_at: string | null;
          },
          []
        >("SELECT * FROM sources ORDER BY evidence_round_id, source_number")
        .all();
      const facts = db
        .query<
          {
            id: number;
            evidence_round_id: number;
            source_number: number;
            fact_number: number;
            content: string;
          },
          []
        >("SELECT * FROM facts ORDER BY evidence_round_id, source_number, fact_number")
        .all();
      const offTopic = db
        .query<
          {
            id: number;
            evidence_round_id: number;
            content: string;
            reason: string | null;
            decision: string | null;
          },
          []
        >("SELECT * FROM off_topic_questions ORDER BY evidence_round_id")
        .all();
      output({
        success: true,
        cycle,
        dbPath,
        capturedAt: new Date().toISOString(),
        counts: {
          questions: questions.length,
          rounds: rounds.length,
          sources: sources.length,
          facts: facts.length,
          offTopic: offTopic.length,
        },
        questions,
        evidence_rounds: rounds,
        sources,
        facts,
        off_topic_questions: offTopic,
      });
    } else if (cycle === "writer-reviewer") {
      const questions = db
        .query<QuestionRow, []>("SELECT * FROM questions ORDER BY display_order")
        .all();
      const rounds = db
        .query<
          {
            id: number;
            question_id: number;
            round_number: number;
            summary: string | null;
            self_evaluation: string | null;
          },
          []
        >("SELECT * FROM evidence_rounds ORDER BY question_id, round_number")
        .all();
      const sources = db
        .query<
          {
            id: number;
            evidence_round_id: number;
            source_number: number;
            title: string;
            url: string;
            kind: string | null;
            accessed_at: string | null;
          },
          []
        >("SELECT * FROM sources ORDER BY evidence_round_id, source_number")
        .all();
      const facts = db
        .query<
          {
            id: number;
            evidence_round_id: number;
            source_number: number;
            fact_number: number;
            content: string;
          },
          []
        >("SELECT * FROM facts ORDER BY evidence_round_id, source_number, fact_number")
        .all();
      const reviews = db
        .query<
          {
            id: number;
            aspect: string;
            round_number: number;
            summary: string | null;
            verdict: string | null;
          },
          [],
          true
        >("SELECT * FROM reviews ORDER BY aspect, round_number")
        .all();
      const findings = db
        .query<
          {
            id: number;
            review_id: number;
            category: string;
            target_question_id: number | null;
            target_section: string | null;
            content: string;
          },
          []
        >(
          `SELECT rf.* FROM review_findings rf
           JOIN reviews r ON r.id = rf.review_id
           ORDER BY r.aspect, r.round_number, rf.id`,
        )
        .all();
      const report = reportPath
        ? (existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null)
        : null;
      output({
        success: true,
        cycle,
        dbPath,
        reportPath,
        capturedAt: new Date().toISOString(),
        counts: {
          questions: questions.length,
          rounds: rounds.length,
          sources: sources.length,
          facts: facts.length,
          reviews: reviews.length,
          findings: findings.length,
        },
        questions,
        evidence_rounds: rounds,
        sources,
        facts,
        reviews,
        review_findings: findings,
        report,
      });
    } else {
      fail(`Unknown cycle: ${cycle}. Expected 'research' or 'writer-reviewer'.`);
    }
  } finally {
    db.close();
  }
}

// -----------------------------------------------------------------------------
// dispatch
// -----------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const { positional, flags } = parseArgs(argv);
  const [resource, action] = positional;

  switch (resource) {
    case "init":
      return cmdInit(flags);
    case "question":
      return cmdQuestion(action ?? "", flags);
    case "evidence":
      if (action === "save") return cmdEvidenceSave(flags);
      fail("evidence: only 'save' is supported");
    case "review":
      if (action === "save") return cmdReviewSave(flags);
      fail("review: only 'save' is supported");
    case "iteration":
      if (action === "save") return cmdIterationSave(flags);
      fail("iteration: only 'save' is supported");
    case "log":
      if (action === "save") return cmdLogSave(flags);
      fail("log: only 'save' is supported");
    case "snapshot":
      return cmdSnapshot(flags);
    case undefined:
    case "":
      fail("Usage: db.ts <init|question|evidence|review|iteration|log|snapshot> ...");
    default:
      fail(`Unknown subcommand: ${resource}`);
  }
}

main();
