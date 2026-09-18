import { Database } from "bun:sqlite";

export function openResearchDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}
