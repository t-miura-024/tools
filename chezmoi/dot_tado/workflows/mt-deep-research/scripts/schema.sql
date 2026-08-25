-- mt-deep-research SQLite schema
-- Tables are normalized; intermediate artifacts (evidence, reviews, iterations, logs)
-- are stored here, while only plan.md and report.md are emitted as standalone files.

PRAGMA foreign_keys = ON;

-- Main research questions proposed by the Planner.
CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content       TEXT    NOT NULL,
  rationale     TEXT,
  display_order INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'approved', 'done', 'dropped')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Per-question evidence rounds. Each round is one Researcher pass.
CREATE TABLE IF NOT EXISTS evidence_rounds (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id     INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  round_number    INTEGER NOT NULL,
  summary         TEXT,
  self_evaluation TEXT,            -- JSON: { coverage, gaps, confidence, ... }
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (question_id, round_number)
);

-- Information sources collected during an evidence round.
CREATE TABLE IF NOT EXISTS sources (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_round_id INTEGER NOT NULL REFERENCES evidence_rounds(id) ON DELETE CASCADE,
  source_number     INTEGER NOT NULL,            -- 1-based number shown in evidence files
  title             TEXT    NOT NULL,
  url               TEXT    NOT NULL,
  kind              TEXT,
  accessed_at       TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (evidence_round_id, source_number)
);

-- Extracted facts tied to a source.
CREATE TABLE IF NOT EXISTS facts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_round_id INTEGER NOT NULL REFERENCES evidence_rounds(id) ON DELETE CASCADE,
  source_number     INTEGER NOT NULL,
  fact_number       INTEGER NOT NULL,            -- 1-based per-source fact ordering
  content           TEXT    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (evidence_round_id, source_number, fact_number)
);

-- Off-topic / deferred questions that surfaced during research.
CREATE TABLE IF NOT EXISTS off_topic_questions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_round_id INTEGER NOT NULL REFERENCES evidence_rounds(id) ON DELETE CASCADE,
  content           TEXT    NOT NULL,
  reason            TEXT,
  decision          TEXT,                        -- 'pending' | 'include' | 'exclude'
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Reviews produced by Reviewer SubAgents (one row per aspect-round).
CREATE TABLE IF NOT EXISTS reviews (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  aspect       TEXT    NOT NULL,                 -- coverage | sources | accuracy | structure | citations
  round_number INTEGER NOT NULL DEFAULT 1,
  summary      TEXT,
  verdict      TEXT,                             -- 'pass' | 'needs_work' | 'fail'
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (aspect, round_number)
);

-- Review findings (must_fix / research_needed / suggestions).
CREATE TABLE IF NOT EXISTS review_findings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id          INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  category           TEXT    NOT NULL
                     CHECK (category IN ('must_fix', 'research_needed', 'suggestions')),
  target_question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
  target_section     TEXT,                       -- e.g. "## 要約"
  content            TEXT    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Improvement-loop iteration history.
CREATE TABLE IF NOT EXISTS iterations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  loop_number         INTEGER NOT NULL,
  iteration_type      TEXT    NOT NULL
                      CHECK (iteration_type IN ('writer_fix', 'researcher_revisit', 'audit_retry')),
  triggered_by_audit  INTEGER,
  summary             TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Script execution logs (for debugging and auditability).
CREATE TABLE IF NOT EXISTS execution_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  command     TEXT    NOT NULL,
  args        TEXT,                              -- JSON-encoded args
  status      TEXT    NOT NULL CHECK (status IN ('ok', 'error')),
  message     TEXT,
  duration_ms INTEGER,
  timestamp   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_questions_status        ON questions(status);
CREATE INDEX IF NOT EXISTS idx_evidence_rounds_q       ON evidence_rounds(question_id);
CREATE INDEX IF NOT EXISTS idx_sources_round           ON sources(evidence_round_id);
CREATE INDEX IF NOT EXISTS idx_facts_round             ON facts(evidence_round_id);
CREATE INDEX IF NOT EXISTS idx_reviews_aspect          ON reviews(aspect);
CREATE INDEX IF NOT EXISTS idx_review_findings_review  ON review_findings(review_id);
CREATE INDEX IF NOT EXISTS idx_iterations_type         ON iterations(iteration_type);
CREATE INDEX IF NOT EXISTS idx_execution_logs_ts       ON execution_logs(timestamp);
