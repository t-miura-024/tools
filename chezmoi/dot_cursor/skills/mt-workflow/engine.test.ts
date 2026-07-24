import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { init, next, report, status, EngineError } from './engine';
import type { WorkflowDef, CheckCtx, PromptCtx, CheckResult } from './types';

const TEST_BASE_DIR = path.join(path.dirname(__filename), '__test_sessions__');
const FIXTURE_WORKFLOW = path.join(__dirname, '__fixtures__', 'simple-workflow.ts');

let sessionId: string;

function cleanup(baseDir: string): void {
  if (fs.existsSync(baseDir)) {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  cleanup(TEST_BASE_DIR);
});

describe('engine', () => {
  describe('init', () => {
    it('should create session directory and workflow.db', async () => {
      const result = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      expect(result.sessionId).toBeTruthy();
      expect(result.workflowId).toBe('test-simple');
      expect(fs.existsSync(path.join(TEST_BASE_DIR, result.sessionId))).toBe(true);
      expect(fs.existsSync(path.join(TEST_BASE_DIR, result.sessionId, 'workflow.db'))).toBe(true);

      const db = new Database(path.join(TEST_BASE_DIR, result.sessionId, 'workflow.db'));
      const session = db.query('SELECT * FROM sessions WHERE id = ?').get(result.sessionId) as Record<string, unknown>;
      expect(session).toBeTruthy();
      expect(session.status).toBe('running');

      const steps = db.query('SELECT * FROM steps WHERE session_id = ? ORDER BY step_index').all(result.sessionId) as Record<string, unknown>[];
      expect(steps).toHaveLength(3);
      expect(steps[0].step_key).toBe('step1_task');
      expect(steps[1].step_key).toBe('step2_human_gate');
      expect(steps[2].step_key).toBe('step3_parallel');

      db.close();
      sessionId = result.sessionId;
    });

    it('should use provided sessionId', async () => {
      const result = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR, 'my-custom-id');
      expect(result.sessionId).toBe('my-custom-id');
    });

    it('should store workflow_path in session row', async () => {
      const result = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      const db = new Database(path.join(TEST_BASE_DIR, result.sessionId, 'workflow.db'));
      const session = db.query('SELECT workflow_path FROM sessions WHERE id = ?').get(result.sessionId) as Record<string, unknown>;
      expect(path.resolve((session.workflow_path as string))).toBe(path.resolve(FIXTURE_WORKFLOW));
      db.close();
    });

    it('should throw EngineError for missing workflow file', async () => {
      await expect(init('/nonexistent/workflow.ts', TEST_BASE_DIR)).rejects.toThrow(EngineError);
    });
  });

  describe('next', () => {
    it('should return task prompt for first step', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      const result = await next(sessionId, TEST_BASE_DIR);

      expect(result.stepKey).toBe('step1_task');
      expect(result.stepType).toBe('task');
      expect(result.action).toBe('run_subagent');
      expect(result.subagentType).toBe('test-agent');
      expect(result.prompt).toContain('Execute step1_task');
      expect(result.context.attemptNumber).toBe(1);
      expect(result.context.retryCount).toBe(0);
      expect(result.context.maxRetries).toBe(2);

      const db = new Database(path.join(result.context.sessionDir, 'workflow.db'));
      const step = db.query('SELECT status FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step1_task') as Record<string, unknown>;
      expect(step.status).toBe('running');
      db.close();
    });

    it('should return human_gate prompt', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);

      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      const result = await next(sessionId, TEST_BASE_DIR);

      expect(result.stepKey).toBe('step2_human_gate');
      expect(result.stepType).toBe('human_gate');
      expect(result.action).toBe('human_gate');
      expect(result.prompt).toContain('approve');
      expect(result.prompt).toContain('revise');
      expect(result.prompt).toContain('abort');
    });

    it('should return parallel subtask prompts', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step2_human_gate',
        status: 'completed',
        subagentOutput: 'approve',
      }, TEST_BASE_DIR);

      const result = await next(sessionId, TEST_BASE_DIR);

      expect(result.stepKey).toBe('step3_parallel');
      expect(result.stepType).toBe('parallel');
      expect(result.parallel).not.toBeNull();
      expect(result.parallel!.subtasks).toHaveLength(2);
      expect(result.parallel!.subtasks[0].key).toBe('sub_a');
      expect(result.parallel!.subtasks[0].prompt).toContain('Subtask A');
      expect(result.parallel!.subtasks[1].key).toBe('sub_b');
      expect(result.parallel!.subtasks[1].prompt).toContain('Subtask B');
    });

    it('should throw EngineError for non-existent session', async () => {
      await expect(next('nonexistent-session', TEST_BASE_DIR)).rejects.toThrow(EngineError);
    });

    it('should throw EngineError for done session', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      db.run('UPDATE sessions SET status = ? WHERE id = ?', ['done', sessionId]);
      db.close();
      await expect(next(sessionId, TEST_BASE_DIR)).rejects.toThrow(EngineError);
    });
  });

  describe('report', () => {
    it('should mark step as passed and advance', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      await next(sessionId, TEST_BASE_DIR);

      const result = await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      expect(result.checkResult.status).toBe('pass');
      expect(result.nextAction).toBe('continue');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const step = db.query('SELECT status FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step1_task') as Record<string, unknown>;
      expect(step.status).toBe('passed');
      db.close();
    });

    it('should retry on failure within maxRetries', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      await next(sessionId, TEST_BASE_DIR);

      const result = await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'failure output',
      }, TEST_BASE_DIR);

      expect(result.checkResult.status).toBe('fail');
      expect(result.nextAction).toBe('retry');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const step = db.query('SELECT status, retry_count FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step1_task') as Record<string, unknown>;
      expect(step.status).toBe('pending');
      expect(step.retry_count).toBe(1);
      db.close();
    });

    it('should trigger onFail abort after maxRetries', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      for (let i = 0; i < 2; i++) {
        await next(sessionId, TEST_BASE_DIR);
        await report(sessionId, {
          stepKey: 'step1_task',
          status: 'completed',
          subagentOutput: 'failure output',
        }, TEST_BASE_DIR);
      }

      await next(sessionId, TEST_BASE_DIR);
      const result = await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'failure output',
      }, TEST_BASE_DIR);

      expect(result.nextAction).toBe('abort');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const session = db.query('SELECT status FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
      expect(session.status).toBe('aborted');
      db.close();
    });

    it('should handle human_gate approve', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const result = await report(sessionId, {
        stepKey: 'step2_human_gate',
        status: 'completed',
        subagentOutput: 'approve',
      }, TEST_BASE_DIR);

      expect(result.nextAction).toBe('continue');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const step = db.query('SELECT status FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step2_human_gate') as Record<string, unknown>;
      expect(step.status).toBe('passed');
      db.close();
    });

    it('should handle human_gate revise', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const result = await report(sessionId, {
        stepKey: 'step2_human_gate',
        status: 'completed',
        subagentOutput: 'revise',
      }, TEST_BASE_DIR);

      expect(result.nextAction).toBe('goto');
      expect(result.targetStep).toBe('step1_task');
    });

    it('should handle human_gate abort', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const result = await report(sessionId, {
        stepKey: 'step2_human_gate',
        status: 'completed',
        subagentOutput: 'abort',
      }, TEST_BASE_DIR);

      expect(result.nextAction).toBe('abort');
    });

    it('should complete session when all steps done', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step2_human_gate',
        status: 'completed',
        subagentOutput: 'approve',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const result = await report(sessionId, {
        stepKey: 'step3_parallel',
        status: 'completed',
        subagentOutput: 'done all subtasks',
      }, TEST_BASE_DIR);

      expect(result.nextAction).toBe('done');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const session = db.query('SELECT status FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
      expect(session.status).toBe('done');
      db.close();
    });
  });

  describe('status', () => {
    it('should return session info', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      const result = status(sessionId, TEST_BASE_DIR);

      expect(result.sessionId).toBe(sessionId);
      expect(result.workflowId).toBe('test-simple');
      expect(result.sessionStatus).toBe('running');
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0].key).toBe('step1_task');
      expect(result.steps[0].status).toBe('pending');
    });

    it('should show step statuses after progression', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const s1 = status(sessionId, TEST_BASE_DIR);
      expect(s1.steps[0].status).toBe('running');

      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      const s2 = status(sessionId, TEST_BASE_DIR);
      expect(s2.steps[0].status).toBe('passed');
    });

    it('should throw EngineError for non-existent session', () => {
      expect(() => status('nonexistent-session', TEST_BASE_DIR)).toThrow(EngineError);
    });
  });

  describe('hooks', () => {
    it('should run beforeInit and afterInit hooks', async () => {
      const hookCalls: string[] = [];

      const tmpDir = path.join(TEST_BASE_DIR, 'hook-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'hook-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'hook-test',
          steps: [
            {
              key: 'step1',
              phase: 'test',
              type: 'task',
              maxRetries: 1,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'test prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
          beforeInit: async (ctx) => {
            const fs = require('node:fs');
            fs.writeFileSync(ctx.sessionDir + '/_hook_before', 'called');
          },
          afterInit: async (ctx) => {
            const fs = require('node:fs');
            fs.writeFileSync(ctx.sessionDir + '/_hook_after', 'called');
            return { artifactDbPath: '/tmp/test-artifact.db' };
          },
        };
        export default def;
      `);

      const result = await init(workflowPath, TEST_BASE_DIR);

      expect(fs.existsSync(path.join(TEST_BASE_DIR, result.sessionId, '_hook_before'))).toBe(true);
      expect(fs.existsSync(path.join(TEST_BASE_DIR, result.sessionId, '_hook_after'))).toBe(true);

      const db = new Database(path.join(TEST_BASE_DIR, result.sessionId, 'workflow.db'));
      const session = db.query('SELECT artifact_db_path FROM sessions WHERE id = ?').get(result.sessionId) as Record<string, unknown>;
      expect(session.artifact_db_path).toBe('/tmp/test-artifact.db');
      db.close();
    });

    it('should work without hooks', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'no-hook-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'no-hook-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'no-hook-test',
          steps: [
            {
              key: 'step1',
              phase: 'test',
              type: 'task',
              maxRetries: 1,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'test prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const result = await init(workflowPath, TEST_BASE_DIR);
      expect(result.sessionId).toBeTruthy();
    });
  });

  describe('retry with onFail strategies', () => {
    it('should support onFail goto after maxRetries', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'goto-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'goto-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'goto-test',
          steps: [
            {
              key: 'failing_step',
              phase: 'test',
              type: 'task',
              maxRetries: 1,
              onFail: { action: 'goto', target: 'fallback_step' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'test',
              },
              check: (ctx) => ({ status: 'fail', reasons: ['always fail'] }),
            },
            {
              key: 'fallback_step',
              phase: 'fallback',
              type: 'task',
              maxRetries: 1,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'fallback',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const r1 = await report(sessionId, {
        stepKey: 'failing_step',
        status: 'completed',
        subagentOutput: 'failed',
      }, TEST_BASE_DIR);

      expect(r1.nextAction).toBe('retry');

      await next(sessionId, TEST_BASE_DIR);
      const r2 = await report(sessionId, {
        stepKey: 'failing_step',
        status: 'completed',
        subagentOutput: 'failed again',
      }, TEST_BASE_DIR);

      expect(r2.nextAction).toBe('goto');
      expect(r2.targetStep).toBe('fallback_step');
    });

    it('should support onFail escalate', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'escalate-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'escalate-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'escalate-test',
          steps: [
            {
              key: 'failing_step',
              phase: 'test',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'escalate' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'test',
              },
              check: (ctx) => ({ status: 'fail', reasons: ['need human'] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const r1 = await report(sessionId, {
        stepKey: 'failing_step',
        status: 'completed',
        subagentOutput: 'help',
      }, TEST_BASE_DIR);

      expect(r1.nextAction).toBe('escalate');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const session = db.query('SELECT status FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
      expect(session.status).toBe('paused');
      db.close();
    });
  });

  describe('workflow without workflow_path in DB', () => {
    it('should accept --workflow flag on next and report', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      const result = await next(sessionId, TEST_BASE_DIR, FIXTURE_WORKFLOW);
      expect(result.stepKey).toBe('step1_task');

      const r = await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR, FIXTURE_WORKFLOW);

      expect(r.nextAction).toBe('continue');
    });
  });

  describe('artifacts', () => {
    it('should register artifacts from report input', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      await next(sessionId, TEST_BASE_DIR);

      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
        artifacts: [
          { key: 'output.md', path: '/tmp/output.md' },
          { key: 'log.txt', path: '/tmp/log.txt' },
        ],
      }, TEST_BASE_DIR);

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const rows = db.query('SELECT * FROM artifacts WHERE session_id = ? ORDER BY id').all(sessionId) as Record<string, unknown>[];
      expect(rows).toHaveLength(2);
      expect(rows[0].artifact_key).toBe('output.md');
      expect(rows[0].file_path).toBe('/tmp/output.md');
      expect(rows[1].artifact_key).toBe('log.txt');
      expect(rows[1].file_path).toBe('/tmp/log.txt');
      db.close();
    });

    it('should register artifacts from afterInit hook', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'artifact-hook-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'artifact-hook-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'artifact-hook-test',
          steps: [
            {
              key: 'step1',
              phase: 'test',
              type: 'task',
              maxRetries: 1,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'test prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
          afterInit: async (ctx) => {
            return { artifacts: [{ key: 'init-artifact.txt', path: '/tmp/init.txt' }] };
          },
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const rows = db.query('SELECT * FROM artifacts WHERE session_id = ?').all(sessionId) as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0].artifact_key).toBe('init-artifact.txt');
      expect(rows[0].step_key).toBe('step1');
      db.close();
    });
  });

  describe('parallel report with subtaskResults', () => {
    it('should store subtask results on report', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step2_human_gate',
        status: 'completed',
        subagentOutput: 'approve',
      }, TEST_BASE_DIR);

      const parResult = await next(sessionId, TEST_BASE_DIR);
      expect(parResult.stepType).toBe('parallel');

      await report(sessionId, {
        stepKey: 'step3_parallel',
        status: 'completed',
        subagentOutput: 'done all subtasks',
        subtaskResults: [
          { subtaskKey: 'sub_a', subagentOutput: 'sub A finished', status: 'completed' },
          { subtaskKey: 'sub_b', subagentOutput: 'sub B finished', status: 'completed' },
        ],
      }, TEST_BASE_DIR);

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const attempts = db.query(
        'SELECT subtask_results_json FROM step_attempts WHERE step_id = (SELECT id FROM steps WHERE session_id = ? AND step_key = ?) ORDER BY attempt_number DESC LIMIT 1',
      ).get(sessionId, 'step3_parallel') as Record<string, unknown>;
      expect(attempts).toBeTruthy();
      const subtaskResults = JSON.parse(attempts.subtask_results_json as string);
      expect(subtaskResults).toHaveLength(2);
      expect(subtaskResults[0].subtaskKey).toBe('sub_a');
      expect(subtaskResults[0].status).toBe('completed');
      expect(subtaskResults[1].subtaskKey).toBe('sub_b');
      db.close();
    });

    it('should handle partial subtask failures', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step1_task',
        status: 'completed',
        subagentOutput: 'success task done',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, {
        stepKey: 'step2_human_gate',
        status: 'completed',
        subagentOutput: 'approve',
      }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);

      const r = await report(sessionId, {
        stepKey: 'step3_parallel',
        status: 'completed',
        subagentOutput: 'partial',
        subtaskResults: [
          { subtaskKey: 'sub_a', subagentOutput: 'ok', status: 'completed' },
          { subtaskKey: 'sub_b', subagentOutput: 'error', status: 'failed', error: 'timeout' },
        ],
      }, TEST_BASE_DIR);

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const attempts = db.query(
        'SELECT subtask_results_json FROM step_attempts WHERE step_id = (SELECT id FROM steps WHERE session_id = ? AND step_key = ?) ORDER BY attempt_number DESC LIMIT 1',
      ).get(sessionId, 'step3_parallel') as Record<string, unknown>;
      const subtaskResults = JSON.parse(attempts.subtask_results_json as string);
      expect(subtaskResults).toHaveLength(2);
      expect(subtaskResults[1].status).toBe('failed');
      expect(subtaskResults[1].error).toBe('timeout');
      db.close();
    });
  });

  describe('check exception handling', () => {
    it('should catch check function exceptions and set status to error', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'check-exception-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'check-exception-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'check-exception-test',
          steps: [
            {
              key: 'broken_step',
              phase: 'test',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'do it',
              },
              check: (ctx) => { throw new Error('intentional check failure'); },
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);
      await next(sessionId, TEST_BASE_DIR);

      const r = await report(sessionId, {
        stepKey: 'broken_step',
        status: 'completed',
        subagentOutput: 'done',
      }, TEST_BASE_DIR);

      expect(r.checkResult.status).toBe('error');
      expect(r.checkResult.reasons).toContain('intentional check failure');
    });
  });

  describe('condition-based step skipping', () => {
    it('should skip step when condition returns false', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'condition-skip-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'condition-skip-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'condition-skip-test',
          steps: [
            {
              key: 'step1',
              phase: 'first',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step1 prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step2_conditional',
              phase: 'conditional',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => false,
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step2 prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step3',
              phase: 'third',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step3 prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      // step1 executes normally
      const r1 = await next(sessionId, TEST_BASE_DIR);
      expect(r1.stepKey).toBe('step1');
      await report(sessionId, { stepKey: 'step1', status: 'completed', subagentOutput: 'done' }, TEST_BASE_DIR);

      // next should skip step2 (condition=false) and return step3
      const r2 = await next(sessionId, TEST_BASE_DIR);
      expect(r2.stepKey).toBe('step3');

      // verify step2 is marked as skipped in DB
      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const step2 = db.query('SELECT status FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step2_conditional') as Record<string, unknown>;
      expect(step2.status).toBe('skipped');
      db.close();
    });

    it('should execute step when condition returns true', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'condition-pass-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'condition-pass-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'condition-pass-test',
          steps: [
            {
              key: 'step1',
              phase: 'first',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => true,
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step1 prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);
      const r1 = await next(sessionId, TEST_BASE_DIR);
      expect(r1.stepKey).toBe('step1');
      expect(r1.prompt).toBe('step1 prompt');
    });

    it('should execute step when condition is undefined (backward compat)', async () => {
      const { sessionId } = await init(FIXTURE_WORKFLOW, TEST_BASE_DIR);
      const r1 = await next(sessionId, TEST_BASE_DIR);
      expect(r1.stepKey).toBe('step1_task');
    });

    it('should skip multiple consecutive steps with false conditions', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'multi-skip-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'multi-skip-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'multi-skip-test',
          steps: [
            {
              key: 'step1',
              phase: 'first',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step1',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step2_skip',
              phase: 'skip1',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => false,
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step2',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step3_skip',
              phase: 'skip2',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => false,
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step3',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step4',
              phase: 'last',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step4',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'step1', status: 'completed', subagentOutput: 'done' }, TEST_BASE_DIR);

      // Should skip step2 and step3, land on step4
      const r = await next(sessionId, TEST_BASE_DIR);
      expect(r.stepKey).toBe('step4');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const s2 = db.query('SELECT status FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step2_skip') as Record<string, unknown>;
      const s3 = db.query('SELECT status FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step3_skip') as Record<string, unknown>;
      expect(s2.status).toBe('skipped');
      expect(s3.status).toBe('skipped');
      db.close();
    });

    it('should mark session done when all remaining steps are skipped', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'all-skip-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'all-skip-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'all-skip-test',
          steps: [
            {
              key: 'step1',
              phase: 'first',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step1',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step2_skip',
              phase: 'skip',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => false,
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step2',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'step1', status: 'completed', subagentOutput: 'done' }, TEST_BASE_DIR);

      // All remaining steps skipped → session done
      await expect(next(sessionId, TEST_BASE_DIR)).rejects.toThrow('All steps completed');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const session = db.query('SELECT status FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown>;
      expect(session.status).toBe('done');
      db.close();
    });

    it('should provide gateChoices in condition context', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'gate-choices-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'gate-choices-workflow.ts');
      fs.writeFileSync(workflowPath, `
        let capturedCtx = null;
        const def = {
          id: 'gate-choices-test',
          steps: [
            {
              key: 'gate_step',
              phase: 'gate',
              type: 'human_gate',
              maxRetries: 1,
              onFail: { action: 'escalate' },
              humanGate: {
                presentArtifacts: [],
                choices: [
                  { value: 'approve', label: 'OK' },
                  { value: 'abort', label: 'Abort' },
                ],
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'conditional_step',
              phase: 'conditional',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => {
                capturedCtx = ctx;
                return ctx.gateChoices['gate_step'] === 'approve';
              },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'conditional',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'final_step',
              phase: 'final',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'final',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
        export function getCapturedCtx() { return capturedCtx; }
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      // Pass the gate with 'approve'
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'gate_step', status: 'completed', subagentOutput: 'approve' }, TEST_BASE_DIR);

      // conditional_step should execute because gateChoices['gate_step'] === 'approve'
      const r = await next(sessionId, TEST_BASE_DIR);
      expect(r.stepKey).toBe('conditional_step');
    });

    it('should execute step when gateChoices condition is met', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'gate-execute-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'gate-execute-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'gate-execute-test',
          steps: [
            {
              key: 'gate_step',
              phase: 'gate',
              type: 'human_gate',
              maxRetries: 1,
              onFail: { action: 'escalate' },
              humanGate: {
                presentArtifacts: [],
                choices: [
                  { value: 'approve', label: 'OK' },
                  { value: 'abort', label: 'Abort' },
                ],
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'conditional_step',
              phase: 'conditional',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => ctx.gateChoices['gate_step'] === 'approve',
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'conditional',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'final_step',
              phase: 'final',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'final',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      // Gate approves → condition gateChoices['gate_step'] === 'approve' is true → step executes
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'gate_step', status: 'completed', subagentOutput: 'approve' }, TEST_BASE_DIR);

      const r = await next(sessionId, TEST_BASE_DIR);
      expect(r.stepKey).toBe('conditional_step');
    });

    it('should provide artifacts in condition context', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'condition-artifacts-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'condition-artifacts-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'condition-artifacts-test',
          steps: [
            {
              key: 'step1',
              phase: 'first',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step1',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step2_conditional',
              phase: 'conditional',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              condition: (ctx) => ctx.artifacts.some(a => a.artifactKey === 'needed.txt'),
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step2',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'step3',
              phase: 'last',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'step3',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      // step1 completes WITHOUT producing the needed artifact
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'step1', status: 'completed', subagentOutput: 'done' }, TEST_BASE_DIR);

      // step2 should be skipped because artifact 'needed.txt' doesn't exist
      const r = await next(sessionId, TEST_BASE_DIR);
      expect(r.stepKey).toBe('step3');

      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const s2 = db.query('SELECT status FROM steps WHERE session_id = ? AND step_key = ?').get(sessionId, 'step2_conditional') as Record<string, unknown>;
      expect(s2.status).toBe('skipped');
      db.close();
    });
  });

  describe('revise resets subsequent steps', () => {
    it('should reset target and all subsequent steps to pending on revise', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'revise-reset-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'revise-reset-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'revise-reset-test',
          steps: [
            {
              key: 'grill',
              phase: 'Grill',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'grill prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'prepare',
              phase: 'Prepare',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'prepare prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'refined_gate',
              phase: 'Gate',
              type: 'human_gate',
              maxRetries: 1,
              onFail: { action: 'escalate' },
              humanGate: {
                presentArtifacts: [],
                choices: [
                  { value: 'approve', label: 'OK' },
                  { value: 'revise', label: 'Revise' },
                  { value: 'abort', label: 'Abort' },
                ],
                reviseTargetStep: 'grill',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'finalize',
              phase: 'Finalize',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'finalize prompt',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      // Execute grill → prepare → gate
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'grill', status: 'completed', subagentOutput: 'done' }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'prepare', status: 'completed', subagentOutput: 'done' }, TEST_BASE_DIR);

      await next(sessionId, TEST_BASE_DIR);
      const gateResult = await report(sessionId, { stepKey: 'refined_gate', status: 'completed', subagentOutput: 'revise' }, TEST_BASE_DIR);

      expect(gateResult.nextAction).toBe('goto');
      expect(gateResult.targetStep).toBe('grill');

      // Verify all steps from grill onwards are reset to pending
      const db = new Database(path.join(TEST_BASE_DIR, sessionId, 'workflow.db'));
      const steps = db.query('SELECT step_key, status, retry_count FROM steps WHERE session_id = ? ORDER BY step_index').all(sessionId) as Record<string, unknown>[];

      expect(steps[0].step_key).toBe('grill');
      expect(steps[0].status).toBe('pending');
      expect(steps[0].retry_count).toBe(0);

      expect(steps[1].step_key).toBe('prepare');
      expect(steps[1].status).toBe('pending');
      expect(steps[1].retry_count).toBe(0);

      expect(steps[2].step_key).toBe('refined_gate');
      expect(steps[2].status).toBe('pending');
      expect(steps[2].retry_count).toBe(0);

      expect(steps[3].step_key).toBe('finalize');
      expect(steps[3].status).toBe('pending');
      expect(steps[3].retry_count).toBe(0);
      db.close();

      // Verify we can re-execute from grill
      const r = await next(sessionId, TEST_BASE_DIR);
      expect(r.stepKey).toBe('grill');
    });

    it('should allow full re-execution after revise', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'revise-full-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'revise-full-workflow.ts');
      fs.writeFileSync(workflowPath, `
        const def = {
          id: 'revise-full-test',
          steps: [
            {
              key: 'work',
              phase: 'Work',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'work',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'gate',
              phase: 'Gate',
              type: 'human_gate',
              maxRetries: 1,
              onFail: { action: 'escalate' },
              humanGate: {
                presentArtifacts: [],
                choices: [
                  { value: 'approve', label: 'OK' },
                  { value: 'revise', label: 'Revise' },
                ],
                reviseTargetStep: 'work',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'done_step',
              phase: 'Done',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'abort' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'done',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      // First pass: work → gate (revise)
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'work', status: 'completed', subagentOutput: 'done' }, TEST_BASE_DIR);
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'gate', status: 'completed', subagentOutput: 'revise' }, TEST_BASE_DIR);

      // Second pass: work → gate (approve) → done_step
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'work', status: 'completed', subagentOutput: 'done again' }, TEST_BASE_DIR);
      await next(sessionId, TEST_BASE_DIR);
      await report(sessionId, { stepKey: 'gate', status: 'completed', subagentOutput: 'approve' }, TEST_BASE_DIR);

      const r = await next(sessionId, TEST_BASE_DIR);
      expect(r.stepKey).toBe('done_step');

      await report(sessionId, { stepKey: 'done_step', status: 'completed', subagentOutput: 'finished' }, TEST_BASE_DIR);

      const s = status(sessionId, TEST_BASE_DIR);
      expect(s.sessionStatus).toBe('done');
    });
  });

  describe('review loop with requeueSource', () => {
    it('should requeue review step as pending after must>0 failure, and re-run it after fix', async () => {
      const tmpDir = path.join(TEST_BASE_DIR, 'requeue-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const workflowPath = path.join(tmpDir, 'requeue-workflow.ts');
      fs.writeFileSync(workflowPath, `
        let fixPass = false;
        const def = {
          id: 'requeue-test',
          steps: [
            {
              key: 'execute',
              phase: 'Execute',
              type: 'task',
              maxRetries: 1,
              onFail: { action: 'escalate' },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'fix the issues',
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
            {
              key: 'review',
              phase: 'Review',
              type: 'task',
              maxRetries: 0,
              onFail: { action: 'goto', target: 'execute', requeueSource: true },
              task: {
                action: 'run_subagent',
                subagentType: 'test',
                buildPrompt: (ctx) => 'review the work',
              },
              check: (ctx) => {
                if (!fixPass) {
                  fixPass = true;
                  return { status: 'fail', reasons: ['must: 3 issues found'] };
                }
                return { status: 'pass', reasons: ['must: 0'] };
              },
            },
            {
              key: 'followup',
              phase: 'Followup',
              type: 'human_gate',
              maxRetries: 1,
              onFail: { action: 'escalate' },
              humanGate: {
                presentArtifacts: [],
                choices: [
                  { value: 'approve', label: 'OK' },
                  { value: 'abort', label: 'Abort' },
                ],
              },
              check: (ctx) => ({ status: 'pass', reasons: [] }),
            },
          ],
        };
        export default def;
      `);

      const { sessionId } = await init(workflowPath, TEST_BASE_DIR);

      // execute → pass
      await next(sessionId, TEST_BASE_DIR);
      const r1 = await report(sessionId, {
        stepKey: 'execute',
        status: 'completed',
        subagentOutput: 'work done',
      }, TEST_BASE_DIR);
      expect(r1.nextAction).toBe('continue');

      // review → fail (must>0), goto execute with requeue
      await next(sessionId, TEST_BASE_DIR);
      const r2 = await report(sessionId, {
        stepKey: 'review',
        status: 'completed',
        subagentOutput: 'review result with must',
      }, TEST_BASE_DIR);
      expect(r2.nextAction).toBe('goto');
      expect(r2.targetStep).toBe('execute');
      expect(r2.message).toContain('review will re-run after fix');

      // verify review is pending (not failed)
      const s1 = status(sessionId, TEST_BASE_DIR);
      const reviewStep = s1.steps.find((s) => s.key === 'review');
      expect(reviewStep?.status).toBe('pending');

      // execute → pass again
      await next(sessionId, TEST_BASE_DIR);
      const r3 = await report(sessionId, {
        stepKey: 'execute',
        status: 'completed',
        subagentOutput: 'fixes applied',
      }, TEST_BASE_DIR);
      expect(r3.nextAction).toBe('continue');

      // review → pass (must=0, fixPass=true)
      await next(sessionId, TEST_BASE_DIR);
      const lookAhead = await next(sessionId, TEST_BASE_DIR);
      expect(lookAhead.stepKey).toBe('review');

      const r4 = await report(sessionId, {
        stepKey: 'review',
        status: 'completed',
        subagentOutput: 'must: 0',
      }, TEST_BASE_DIR);
      expect(r4.nextAction).toBe('continue');
      expect(r4.message).toContain('followup');
    });
  });
});
