import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { init } from './engine';
import type { InitResult } from './types';

const TEST_BASE_DIR = path.join(path.dirname(__filename), '__test_cli_sessions__');
const FIXTURE_WORKFLOW = path.join(__dirname, '__fixtures__', 'simple-workflow.ts');

function cleanup(baseDir: string): void {
  if (fs.existsSync(baseDir)) {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  cleanup(TEST_BASE_DIR);
});

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
    baseDir: path.resolve('tmp', 'mt-workflow'),
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

describe('cli parsing', () => {
  it('should parse init command', () => {
    const r = parseCli(['init', '--workflow', '/path/to/workflow.ts']);
    expect(r.command).toBe('init');
    expect(r.workflow).toBe('/path/to/workflow.ts');
  });

  it('should parse next command', () => {
    const r = parseCli(['next', '--session', 'abc123']);
    expect(r.command).toBe('next');
    expect(r.session).toBe('abc123');
  });

  it('should parse report command', () => {
    const r = parseCli(['report', '--session', 'abc123']);
    expect(r.command).toBe('report');
    expect(r.session).toBe('abc123');
  });

  it('should parse status command', () => {
    const r = parseCli(['status', '--session', 'abc123']);
    expect(r.command).toBe('status');
    expect(r.session).toBe('abc123');
  });

  it('should parse --base-dir option', () => {
    const r = parseCli(['init', '--workflow', 'wf.ts', '--base-dir', '/custom/dir']);
    expect(r.command).toBe('init');
    expect(r.baseDir).toBe('/custom/dir');
  });

  it('should parse --session for init', () => {
    const r = parseCli(['init', '--workflow', 'wf.ts', '--session', 'my-id']);
    expect(r.session).toBe('my-id');
  });

  it('should show help with --help', () => {
    const r = parseCli(['--help']);
    expect(r.help).toBe(true);
  });

  it('should show help with -h', () => {
    const r = parseCli(['-h']);
    expect(r.help).toBe(true);
  });

  it('should show help when no command', () => {
    const r = parseCli([]);
    expect(r.command).toBe('');
  });
});

describe('cli integration', () => {
  it('should output JSON on init', async () => {
    const proc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'init', '--workflow', FIXTURE_WORKFLOW,
      '--base-dir', TEST_BASE_DIR,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    const parsed = JSON.parse(out) as InitResult;
    expect(parsed.sessionId).toBeTruthy();
    expect(parsed.workflowId).toBe('test-simple');
    expect(err).toBe('');
  });

  it('should output JSON on next', async () => {
    const initProc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'init', '--workflow', FIXTURE_WORKFLOW,
      '--base-dir', TEST_BASE_DIR,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const initOut = await new Response(initProc.stdout).text();
    await initProc.exited;
    const { sessionId } = JSON.parse(initOut) as InitResult;

    const proc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'next', '--session', sessionId,
      '--base-dir', TEST_BASE_DIR,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.stepKey).toBe('step1_task');
    expect(parsed.action).toBe('run_subagent');
  });

  it('should output JSON on status', async () => {
    const initProc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'init', '--workflow', FIXTURE_WORKFLOW,
      '--base-dir', TEST_BASE_DIR,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const initOut = await new Response(initProc.stdout).text();
    await initProc.exited;
    const { sessionId } = JSON.parse(initOut) as InitResult;

    const proc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'status', '--session', sessionId,
      '--base-dir', TEST_BASE_DIR,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.sessionId).toBe(sessionId);
    expect(parsed.steps).toHaveLength(3);
  });

  it('should handle report via stdin', async () => {
    const initProc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'init', '--workflow', FIXTURE_WORKFLOW,
      '--base-dir', TEST_BASE_DIR,
    ], { stdout: 'pipe', stderr: 'pipe' });
    const initOut = await new Response(initProc.stdout).text();
    await initProc.exited;
    const { sessionId } = JSON.parse(initOut) as InitResult;

    await Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'next', '--session', sessionId,
      '--base-dir', TEST_BASE_DIR,
    ]).exited;

    const input = JSON.stringify({
      stepKey: 'step1_task',
      status: 'completed',
      subagentOutput: 'success task done',
    });

    const proc = Bun.spawn({
      cmd: ['bun', 'run', path.join(__dirname, 'cli.ts'),
        'report', '--session', sessionId,
        '--base-dir', TEST_BASE_DIR,
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    proc.stdin.write(new TextEncoder().encode(input));
    proc.stdin.close();

    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.nextAction).toBe('continue');
    expect(err).toBe('');
  });

  it('should error without required args', async () => {
    const proc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      'init',
    ], { stdout: 'pipe', stderr: 'pipe' });
    const err = await new Response(proc.stderr).text();
    await proc.exited;

    expect(proc.exitCode).toBe(1);
    expect(err).toContain('Error');
  });

  it('should show help', async () => {
    const proc = Bun.spawn([
      'bun', 'run', path.join(__dirname, 'cli.ts'),
      '--help',
    ], { stdout: 'pipe' });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    expect(proc.exitCode).toBe(0);
    expect(out).toContain('Usage:');
    expect(out).toContain('init');
    expect(out).toContain('next');
    expect(out).toContain('report');
    expect(out).toContain('status');
  });
});
