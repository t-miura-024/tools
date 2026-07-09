import * as fs from 'node:fs';
import * as path from 'node:path';
import { init, next, report, status, EngineError } from './engine';
import type { ReportInput } from './types';

const DEFAULT_BASE_DIR = path.resolve('tmp', 'mt-workflow');

function usage(): string {
  return `mt-workflow - Deterministic workflow engine for LLM orchestration

Usage:
  mt-workflow init    --workflow <path> [--base-dir <dir>] [--session <id>]
  mt-workflow next    --session <id>  [--base-dir <dir>] [--workflow <path>]
  mt-workflow report  --session <id>  [--base-dir <dir>] [--workflow <path>]
  mt-workflow status  --session <id>  [--base-dir <dir>]

Commands:
  init      Initialize a new workflow session from a workflow definition
  next      Get the next step's prompt (advance the session)
  report    Submit step results via stdin JSON and advance the session
  status    Show the current session state

Options:
  --workflow <path>   Path to workflow.ts definition file
  --base-dir <dir>    Base directory for session storage (default: tmp/mt-workflow)
  --session <id>      Session ID
  --help, -h          Show this help`;
}

function parseCli(argv: readonly string[]): {
  command: string;
  workflow?: string;
  session?: string;
  baseDir: string;
  help: boolean;
} {
  const args = [...argv];
  const result: ReturnType<typeof parseCli> = {
    command: '',
    baseDir: DEFAULT_BASE_DIR,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === '--help' || a === '-h') {
      result.help = true;
      i++;
    } else if (a === '--workflow') {
      result.workflow = args[++i];
      i++;
    } else if (a === '--base-dir') {
      result.baseDir = args[++i];
      i++;
    } else if (a === '--session') {
      result.session = args[++i];
      i++;
    } else if (!result.command && ['init', 'next', 'report', 'status'].includes(a)) {
      result.command = a;
      i++;
    } else {
      i++;
    }
  }

  return result;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf-8').trim();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`Warning: failed to read stdin: ${msg}\n`);
    return '';
  }
}

export async function run(args: readonly string[]): Promise<void> {
  const opts = parseCli(args);

  if (opts.help || !opts.command) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  try {
    switch (opts.command) {
      case 'init': {
        if (!opts.workflow) {
          process.stderr.write('Error: --workflow <path> is required for init\n');
          process.exitCode = 1;
          return;
        }
        const result = await init(opts.workflow, opts.baseDir, opts.session);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }

      case 'next': {
        if (!opts.session) {
          process.stderr.write('Error: --session <id> is required for next\n');
          process.exitCode = 1;
          return;
        }
        const result = await next(opts.session, opts.baseDir, opts.workflow);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }

      case 'report': {
        if (!opts.session) {
          process.stderr.write('Error: --session <id> is required for report\n');
          process.exitCode = 1;
          return;
        }
        const stdin = readStdin();
        if (!stdin) {
          process.stderr.write('Error: report requires JSON input on stdin\n');
          process.exitCode = 1;
          return;
        }
        let input: ReportInput;
        try {
          input = JSON.parse(stdin) as ReportInput;
        } catch {
          process.stderr.write('Error: invalid JSON on stdin\n');
          process.exitCode = 1;
          return;
        }
        if (!input.stepKey) {
          process.stderr.write('Error: report JSON must include "stepKey" field\n');
          process.exitCode = 1;
          return;
        }
        const result = await report(opts.session, input, opts.baseDir, opts.workflow);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }

      case 'status': {
        if (!opts.session) {
          process.stderr.write('Error: --session <id> is required for status\n');
          process.exitCode = 1;
          return;
        }
        const result = status(opts.session, opts.baseDir);
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        break;
      }

      default:
        process.stderr.write(`Error: unknown command: ${opts.command}\n`);
        process.stderr.write(`${usage()}\n`);
        process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof EngineError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.path === Bun.main) {
  void run(process.argv.slice(2));
}
