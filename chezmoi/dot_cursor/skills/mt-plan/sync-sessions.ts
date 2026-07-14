import { Database } from 'bun:sqlite';
import { readdirSync, existsSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

export interface PlanSessionInfo {
  sessionId: string;
  sessionStatus: string;
  workflowId: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_BASE_DIR = resolve('tmp', 'mt-workflow');

export function listPlanSessions(
  planNumber: number,
  baseDir: string = DEFAULT_BASE_DIR,
): PlanSessionInfo[] {
  if (!existsSync(baseDir)) return [];

  const results: PlanSessionInfo[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(baseDir, entry.name, 'workflow.db');
    if (!existsSync(dbPath)) continue;

    let db: Database | undefined;
    try {
      db = new Database(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');

      const artifactRow = db
        .query<
          { file_path: string },
          [string]
        >("SELECT file_path FROM artifacts WHERE artifact_key = 'plan_number' AND file_path = ? LIMIT 1")
        .get(String(planNumber));

      if (!artifactRow) continue;

      const sessionRow = db
        .query<
          { id: string; status: string; workflow_id: string; created_at: string; updated_at: string },
          []
        >('SELECT id, status, workflow_id, created_at, updated_at FROM sessions LIMIT 1')
        .get();

      if (sessionRow) {
        results.push({
          sessionId: sessionRow.id,
          sessionStatus: sessionRow.status,
          workflowId: sessionRow.workflow_id,
          createdAt: sessionRow.created_at,
          updatedAt: sessionRow.updated_at,
        });
      }
    } catch {
      // Skip corrupted DBs
    } finally {
      db?.close();
    }
  }

  return results;
}

export function listAllPlanSessions(
  baseDir: string = DEFAULT_BASE_DIR,
): Map<number, PlanSessionInfo[]> {
  const result = new Map<number, PlanSessionInfo[]>();

  if (!existsSync(baseDir)) return result;

  let entries: Dirent[];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dbPath = join(baseDir, entry.name, 'workflow.db');
    if (!existsSync(dbPath)) continue;

    let db: Database | undefined;
    try {
      db = new Database(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');

      const planRows = db
        .query<{ file_path: string }, []>(
          "SELECT file_path FROM artifacts WHERE artifact_key = 'plan_number'",
        )
        .all();

      for (const planRow of planRows) {
        const planNumber = Number.parseInt(planRow.file_path, 10);
        if (Number.isNaN(planNumber)) continue;

        const sessionRow = db
          .query<
            { id: string; status: string; workflow_id: string; created_at: string; updated_at: string },
            []
          >('SELECT id, status, workflow_id, created_at, updated_at FROM sessions LIMIT 1')
          .get();

        if (!sessionRow) continue;

        const sessions = result.get(planNumber) ?? [];
        sessions.push({
          sessionId: sessionRow.id,
          sessionStatus: sessionRow.status,
          workflowId: sessionRow.workflow_id,
          createdAt: sessionRow.created_at,
          updatedAt: sessionRow.updated_at,
        });
        result.set(planNumber, sessions);
      }
    } catch {
      // Skip corrupted DBs
    } finally {
      db?.close();
    }
  }

  return result;
}
