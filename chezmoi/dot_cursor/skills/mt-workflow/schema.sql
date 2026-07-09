CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT NOT NULL,
  workflow_path   TEXT NOT NULL,
  session_dir     TEXT NOT NULL,
  artifact_db_path TEXT,
  current_step    TEXT,
  status          TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','paused','done','aborted')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS steps (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  phase           TEXT,
  type            TEXT NOT NULL
                  CHECK (type IN ('task','human_gate','parallel')),
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','passed','failed','skipped')),
  retry_count     INTEGER NOT NULL DEFAULT 0,
  max_retries     INTEGER NOT NULL DEFAULT 3,
  on_fail_action  TEXT,
  on_fail_target  TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (session_id, step_key)
);

CREATE TABLE IF NOT EXISTS step_attempts (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  step_id             INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  attempt_number      INTEGER NOT NULL,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at            TEXT,
  result_json         TEXT,
  subtask_results_json TEXT,
  check_results_json  TEXT,
  check_status        TEXT CHECK (check_status IN ('pass','fail','error')),
  UNIQUE (step_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_key        TEXT NOT NULL,
  artifact_key    TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
