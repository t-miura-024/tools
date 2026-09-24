import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect } from "bun:test";
import type { PromptCtx } from "tado";

export function makeSnapshotCtx(sessionDir: string, overrides: Partial<PromptCtx> = {}): PromptCtx {
  return {
    sessionDir,
    sessionId: path.basename(sessionDir),
    gateAnswers: {},
    loop: null,
    artifacts: [],
    ...overrides,
  };
}

export function createSnapshotSessionDir(prefix = "prompt-snap-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function normalizePrompt(prompt: string, sessionDir: string): string {
  const repoRoot = path.resolve(import.meta.dir, "../../../../..");
  let out = prompt.replaceAll(sessionDir, "<SESSION>");
  out = out.replaceAll(repoRoot, "<REPO>");
  const home = os.homedir();
  if (home) out = out.replaceAll(home, "<HOME>");
  out = out.replaceAll("/test/research.db", "<RESEARCH_DB>");
  return out;
}

export function snapMdPath(testFilePath: string, name?: string): string {
  const dir = path.join(path.dirname(testFilePath), "__snapshots__");
  const base = path.basename(testFilePath, ".test.ts");
  return name ? path.join(dir, `${base}-${name}.snap.md`) : path.join(dir, `${base}.snap.md`);
}

export function expectPromptMd(normalizedPrompt: string, snapFile: string): void {
  fs.mkdirSync(path.dirname(snapFile), { recursive: true });
  const content = normalizedPrompt.endsWith("\n") ? normalizedPrompt : `${normalizedPrompt}\n`;
  if (process.env.UPDATE_SNAPSHOTS === "1" || !fs.existsSync(snapFile)) {
    fs.writeFileSync(snapFile, content);
    return;
  }
  const expected = fs.readFileSync(snapFile, "utf-8");
  expect(content).toBe(expected);
}
