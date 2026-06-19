/**
 * lint.ts unit tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LINT = join(import.meta.dir, "lint.ts");

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "mt-deep-research-linttest-"));
});

afterEach(() => {
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", LINT, ...args], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

describe("prettier formatting", () => {
  it("rewrites a poorly-formatted markdown file in place", async () => {
    const file = join(workDir, "doc.md");
    writeFileSync(
      file,
      "# タイトル\n\n長い    テキスト    が    続く   場合。\n\n##  セクション\n\n本文\n",
      "utf-8",
    );
    const r = await cli(["--file", file]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.success).toBe(true);
    const after = readFileSync(file, "utf-8");
    expect(after).not.toMatch(/    /);
  });
});

describe("mermaid syntax check", () => {
  it("flags an unknown diagram type", async () => {
    const file = join(workDir, "doc.md");
    writeFileSync(file, "```mermaid\nnotARealDiagram\n```\n", "utf-8");
    const r = await cli(["--file", file]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.success).toBe(false);
    const mm = out.files[0].mermaid_errors;
    expect(mm.some((e: { message: string }) => e.message.includes("unknown diagram type"))).toBe(true);
  });

  it("accepts a valid flowchart", async () => {
    const file = join(workDir, "doc.md");
    writeFileSync(
      file,
      "# タイトル\n\n## フロー\n\n```mermaid\ngraph LR\n  A --> B\n  B --> C\n```\n",
      "utf-8",
    );
    const r = await cli(["--file", file]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.files[0].mermaid_errors).toHaveLength(0);
  });

  it("flags unbalanced brackets", async () => {
    const file = join(workDir, "doc.md");
    writeFileSync(file, "```mermaid\ngraph LR\n  A[unclosed --> B\n```\n", "utf-8");
    const r = await cli(["--file", file]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    const mm = out.files[0].mermaid_errors;
    expect(mm.length).toBeGreaterThan(0);
    expect(mm[0].message).toMatch(/unbalanced|unclosed/);
  });

  it("flags an empty mermaid block", async () => {
    const file = join(workDir, "doc.md");
    writeFileSync(file, "```mermaid\n```\n", "utf-8");
    const r = await cli(["--file", file]);
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    const mm = out.files[0].mermaid_errors;
    expect(mm.some((e: { message: string }) => e.message.includes("empty"))).toBe(true);
  });
});

describe("directory mode", () => {
  it("walks a directory and lints every .md file", async () => {
    writeFileSync(join(workDir, "a.md"), "# A\n", "utf-8");
    writeFileSync(join(workDir, "b.md"), "# B\n", "utf-8");
    writeFileSync(join(workDir, "c.txt"), "not markdown", "utf-8");
    const r = await cli(["--dir", workDir]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.summary.files).toBe(2);
  });
});

describe("stdin mode", () => {
  it("reads markdown from stdin and lints it", async () => {
    const proc = Bun.spawn(["bun", "run", LINT, "--stdin"], {
      cwd: workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("```mermaid\nnotARealDiagram\n```\n");
    proc.stdin.end();
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(1);
    const out = JSON.parse(stdout);
    expect(out.files[0].path).toBe("<stdin>");
  });
});
