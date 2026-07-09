#!/usr/bin/env bun
/**
 * lint.ts — format and lint markdown files for the mt-deep-research Skill.
 *
 * For each input file:
 *   1. Run prettier --write (markdown formatter)
 *   2. Run markdownlint
 *   3. Extract every ```mermaid``` block and run a lightweight syntax check
 *
 * Usage:
 *   lint.ts --file <path> [<path> ...]
 *   lint.ts --dir  <path>            (recursive, only *.md)
 *   lint.ts --stdin                  (read markdown from stdin)
 *
 * Output: JSON summary. Exit 0 on success, 1 on any error.
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import prettier from "prettier";
import { lint as markdownlint, readConfig } from "markdownlint/sync";

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

function out(value: unknown, exitCode: number): never {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}

function fail(message: string): never {
  out({ success: false, error: message }, 1);
}

function expandPaths(flags: FlagMap): string[] {
  if (flags.stdin === true) return ["<stdin>"];
  if (flags.file) {
    const files = Array.isArray(flags.file) ? flags.file : [flags.file];
    return (files as string[]).map((f) => (isAbsolute(f) ? f : resolve(process.cwd(), f)));
  }
  if (flags.dir) {
    const root = isAbsolute(flags.dir as string) ? (flags.dir as string) : resolve(process.cwd(), flags.dir as string);
    if (!existsSync(root)) fail(`Directory not found: ${root}`);
    const md: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else if (s.isFile() && entry.endsWith(".md")) md.push(p);
      }
    };
    walk(root);
    return md;
  }
  fail("Provide --file <path>, --dir <path>, or --stdin");
}

// -----------------------------------------------------------------------------
// Mermaid syntax check
// -----------------------------------------------------------------------------

const MERMAID_DIAGRAM_TYPES = new Set([
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "pie",
  "journey",
  "gitGraph",
  "requirementDiagram",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "mindmap",
  "timeline",
  "zenuml",
  "sankey-beta",
  "xychart-beta",
  "block-beta",
  "packet-beta",
  "architecture-beta",
  "radar-beta",
]);

type MermaidError = { block_index: number; line: number; message: string };

function extractMermaidBlocks(content: string): { body: string; startLine: number; blockIndex: number }[] {
  const blocks: { body: string; startLine: number; blockIndex: number }[] = [];
  const lines = content.split("\n");
  let i = 0;
  let blockIndex = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "```mermaid") {
      const startLine = i + 1;
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "```") {
        body.push(lines[i]);
        i++;
      }
      if (i >= lines.length) {
        // Unterminated fence
        return blocks;
      }
      blocks.push({ body: body.join("\n"), startLine, blockIndex });
      blockIndex++;
      i++;
    } else {
      i++;
    }
  }
  return blocks;
}

function checkBrackets(s: string): string | null {
  const stack: { ch: string; pos: number }[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const openers = new Set(["(", "[", "{"]);
  // Skip string-quoted content to avoid counting brackets inside them
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (inSingle || inDouble) continue;
    if (openers.has(c)) stack.push({ ch: c, pos: i });
    else if (c in pairs) {
      const top = stack.pop();
      if (!top || top.ch !== pairs[c]) return `unbalanced '${c}' at offset ${i}`;
    }
  }
  if (stack.length > 0) return `unclosed '${stack[stack.length - 1].ch}' from offset ${stack[stack.length - 1].pos}`;
  return null;
}

function checkMermaidBlock(body: string, blockIndex: number, startLine: number): MermaidError[] {
  const errors: MermaidError[] = [];
  const lines = body.split("\n");
  if (lines.length === 0 || lines[0].trim() === "") {
    errors.push({ block_index: blockIndex, line: startLine, message: "empty mermaid block" });
    return errors;
  }
  const header = lines[0].trim().split(/\s+/)[0];
  if (!MERMAID_DIAGRAM_TYPES.has(header)) {
    errors.push({
      block_index: blockIndex,
      line: startLine,
      message: `unknown diagram type '${header}' (first line: ${lines[0].trim()})`,
    });
  }
  const bracketErr = checkBrackets(body);
  if (bracketErr) {
    errors.push({ block_index: blockIndex, line: startLine, message: bracketErr });
  }
  // Check for HTML-like tags (e.g. <br/>) inside mermaid node labels
  // These can cause render failures depending on the Mermaid client
  const htmlTagRE = /<[a-zA-Z\/][^>]*>/g;
  let htmlMatch: RegExpExecArray | null;
  while ((htmlMatch = htmlTagRE.exec(body)) !== null) {
    const lineNo = startLine + body.slice(0, htmlMatch.index).split("\n").length - 1;
    errors.push({
      block_index: blockIndex,
      line: lineNo,
      message: `HTML tag '${htmlMatch[0]}' in mermaid body may cause render errors`,
    });
  }
  return errors;
}

export function checkMermaid(content: string): MermaidError[] {
  const blocks = extractMermaidBlocks(content);
  const errors: MermaidError[] = [];
  for (const b of blocks) {
    errors.push(...checkMermaidBlock(b.body, b.blockIndex, b.startLine));
  }
  return errors;
}

// -----------------------------------------------------------------------------
// Prettier + markdownlint per file
// -----------------------------------------------------------------------------

type FileReport = {
  path: string;
  formatted: boolean;
  prettier_error?: string;
  markdownlint_errors: { line: number; rule: string; detail: string }[];
  mermaid_errors: MermaidError[];
};

let cachedConfig: unknown | undefined;

function loadLintConfig(): unknown {
  if (cachedConfig !== undefined) return cachedConfig;
  const configPath = join(import.meta.dir, "markdownlint.json");
  if (existsSync(configPath)) {
    try {
      cachedConfig = readConfig(configPath);
    } catch {
      cachedConfig = null;
    }
  } else {
    cachedConfig = null;
  }
  return cachedConfig;
}

async function lintFile(path: string): Promise<FileReport> {
  const original = readFileSync(path, "utf-8");
  let formatted = original;
  let prettierError: string | undefined;
  try {
    formatted = await prettier.format(original, {
      filepath: path,
      parser: "markdown",
    });
    if (formatted !== original) {
      writeFileSync(path, formatted, "utf-8");
    }
  } catch (e) {
    prettierError = String(e);
  }

  const mlOptions: { strings: Record<string, string>; config?: unknown } = {
    strings: { [path]: formatted },
  };
  const cfg = loadLintConfig();
  if (cfg) mlOptions.config = cfg;
  const mlResult = markdownlint(mlOptions);
  const mlErrors: FileReport["markdownlint_errors"] = [];
  for (const errs of Object.values(mlResult)) {
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      mlErrors.push({ line: e.lineNumber, rule: e.ruleNames.join("/"), detail: e.ruleDescription });
    }
  }

  const mermaidErrors = checkMermaid(formatted);

  return {
    path,
    formatted: formatted === original,
    prettier_error: prettierError,
    markdownlint_errors: mlErrors,
    mermaid_errors: mermaidErrors,
  };
}

async function lintStdin(): Promise<FileReport> {
  const original = await new Response(process.stdin).text();
  let formatted = original;
  let prettierError: string | undefined;
  try {
    formatted = await prettier.format(original, { parser: "markdown" });
  } catch (e) {
    prettierError = String(e);
  }
  const mlOptions: { strings: Record<string, string>; config?: unknown } = {
    strings: { "<stdin>": formatted },
  };
  const cfg = loadLintConfig();
  if (cfg) mlOptions.config = cfg;
  const mlResult = markdownlint(mlOptions);
  const mlErrors: FileReport["markdownlint_errors"] = [];
  for (const errs of Object.values(mlResult)) {
    if (!Array.isArray(errs)) continue;
    for (const e of errs) {
      mlErrors.push({ line: e.lineNumber, rule: e.ruleNames.join("/"), detail: e.ruleDescription });
    }
  }
  const mermaidErrors = checkMermaid(formatted);
  return {
    path: "<stdin>",
    formatted: true,
    prettier_error: prettierError,
    markdownlint_errors: mlErrors,
    mermaid_errors: mermaidErrors,
  };
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);

  let reports: FileReport[];
  if (flags.stdin === true) {
    reports = [await lintStdin()];
  } else {
    const paths = expandPaths(flags);
    reports = await Promise.all(paths.map(lintFile));
  }

  const totalMl = reports.reduce((n, r) => n + r.markdownlint_errors.length, 0);
  const totalMm = reports.reduce((n, r) => n + r.mermaid_errors.length, 0);
  const totalPf = reports.reduce((n, r) => n + (r.prettier_error ? 1 : 0), 0);
  const success = totalMl === 0 && totalMm === 0 && totalPf === 0;

  out(
    {
      success,
      files: reports,
      summary: {
        files: reports.length,
        prettier_errors: totalPf,
        markdownlint_errors: totalMl,
        mermaid_errors: totalMm,
      },
    },
    success ? 0 : 1,
  );
}

if (import.meta.main) main();
