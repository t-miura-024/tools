import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import type {
  WorkflowDef,
  StepDef,
  InitResult,
  NextResult,
  ReportResult,
  ReportInput,
  StatusResult,
  SessionRow,
  StepRow,
  StepAttemptRow,
  ArtifactRow,
  CheckCtx,
  PromptCtx,
  AttemptResult,
  AttemptSummary,
  ArtifactInput,
  ArtifactRecord,
  ParallelNextResult,
  SubtaskResult,
} from './types';

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

function generateSessionId(): string {
  const now = new Date();
  const YYYY = now.getFullYear().toString();
  const MM = (now.getMonth() + 1).toString().padStart(2, '0');
  const DD = now.getDate().toString().padStart(2, '0');
  const HH = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  const ss = now.getSeconds().toString().padStart(2, '0');
  const rand = Math.random().toString(36).substring(2, 6);
  return `${YYYY}${MM}${DD}-${HH}${mm}${ss}-${rand}`;
}

async function importWorkflowDef(workflowPath: string): Promise<WorkflowDef> {
  const resolved = path.resolve(workflowPath);
  if (!fs.existsSync(resolved)) {
    throw new EngineError(`Workflow file not found: ${resolved}`);
  }
  const mod = await import(resolved);
  const def: WorkflowDef = mod.default ?? mod;
  if (!def || !def.id || !def.steps) {
    throw new EngineError(`Invalid workflow definition in: ${resolved}`);
  }
  return def;
}

function openDb(sessionDir: string): Database {
  const dbPath = path.join(sessionDir, 'workflow.db');
  try {
    return new Database(dbPath);
  } catch (e) {
    throw new EngineError(`Session database not found: ${sessionDir}`);
  }
}

function initDb(db: Database): void {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
}

function dbRowToSessionRow(row: Record<string, unknown>): SessionRow {
  return {
    id: row.id as string,
    workflowId: row.workflow_id as string,
    sessionDir: row.session_dir as string,
    artifactDbPath: row.artifact_db_path as string | null,
    currentStep: row.current_step as string | null,
    status: row.status as SessionRow['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function dbRowToStepRow(row: Record<string, unknown>): StepRow {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    stepKey: row.step_key as string,
    stepIndex: row.step_index as number,
    phase: row.phase as string | null,
    type: row.type as StepRow['type'],
    status: row.status as StepRow['status'],
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    createdAt: row.created_at as string,
  };
}

function dbRowToStepAttemptRow(row: Record<string, unknown>): StepAttemptRow {
  return {
    id: row.id as number,
    stepId: row.step_id as number,
    attemptNumber: row.attempt_number as number,
    startedAt: row.started_at as string,
    endedAt: row.ended_at as string | null,
    resultJson: row.result_json as string | null,
    subtaskResultsJson: row.subtask_results_json as string | null,
    checkResultsJson: row.check_results_json as string | null,
    checkStatus: row.check_status as StepAttemptRow['checkStatus'],
  };
}

function dbRowToArtifactRow(row: Record<string, unknown>): ArtifactRow {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    stepKey: row.step_key as string,
    artifactKey: row.artifact_key as string,
    filePath: row.file_path as string,
    createdAt: row.created_at as string,
  };
}

export async function init(
  workflowPath: string,
  baseDir: string,
  sessionId?: string,
): Promise<InitResult> {
  const def = await importWorkflowDef(workflowPath);
  const resolvedPath = path.resolve(workflowPath);

  const sid = sessionId ?? generateSessionId();
  const sessionDir = path.resolve(baseDir, sid);
  fs.mkdirSync(sessionDir, { recursive: true });

  const db = openDb(sessionDir);
  initDb(db);

  db.run(
    `INSERT INTO sessions (id, workflow_id, workflow_path, session_dir, status)
     VALUES (?, ?, ?, ?, 'running')`,
    [sid, def.id, resolvedPath, sessionDir],
  );

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    db.run(
      `INSERT INTO steps (session_id, step_key, step_index, phase, type, max_retries, on_fail_action, on_fail_target)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sid, step.key, i, step.phase, step.type, step.maxRetries, step.onFail.action, step.onFail.target ?? null],
    );
  }

  let artifactDbPath: string | null = null;

  if (def.beforeInit) {
    await def.beforeInit({ sessionDir, sessionId: sid });
  }

  if (def.afterInit) {
    const afterResult = await def.afterInit({ sessionDir, sessionId: sid });
    artifactDbPath = afterResult.artifactDbPath ?? null;

    if (artifactDbPath) {
      db.run('UPDATE sessions SET artifact_db_path = ? WHERE id = ?', [artifactDbPath, sid]);
    }

    if (afterResult.artifacts && afterResult.artifacts.length > 0 && def.steps.length > 0) {
      const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
      const firstStep = def.steps[0];
      const insertArtifact = db.prepare(
        'INSERT INTO artifacts (session_id, step_key, artifact_key, file_path, created_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const a of afterResult.artifacts) {
        insertArtifact.run(sid, firstStep.key, a.key, a.path, now);
      }
    }
  }

  db.close();

  return { sessionId: sid, sessionDir, workflowId: def.id };
}

export async function next(
  sessionId: string,
  baseDir: string,
  workflowPath?: string,
): Promise<NextResult> {
  const sessionDir = path.resolve(baseDir, sessionId);
  const db = openDb(sessionDir);

  const sessionRowRaw = db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!sessionRowRaw) {
    db.close();
    throw new EngineError(`Session not found: ${sessionId}`);
  }
  const session = dbRowToSessionRow(sessionRowRaw);

  if (session.status === 'done') {
    db.close();
    throw new EngineError(`Session already done: ${sessionId}`);
  }

  if (session.status === 'aborted') {
    db.close();
    throw new EngineError(`Session is aborted: ${sessionId}`);
  }

  const resolvedWorkflowPath = workflowPath ?? sessionRowRaw.workflow_path as string;
  if (!resolvedWorkflowPath) {
    db.close();
    throw new EngineError('No workflow path available; provide --workflow flag or ensure session has workflow_path stored');
  }

  const def = await importWorkflowDef(resolvedWorkflowPath);
  const stepDefsByKey = new Map<string, StepDef>();
  for (const s of def.steps) {
    stepDefsByKey.set(s.key, s);
  }

  let currentStepRaw: Record<string, unknown> | undefined;

  if (session.currentStep) {
    currentStepRaw = db.query(
      'SELECT * FROM steps WHERE session_id = ? AND step_key = ?',
    ).get(sessionId, session.currentStep) as Record<string, unknown> | undefined;
  }

  if (!currentStepRaw) {
    const rows = db.query(
      'SELECT * FROM steps WHERE session_id = ? AND status IN (\'pending\', \'running\') ORDER BY step_index LIMIT 1',
    ).all(sessionId) as Record<string, unknown>[];
    if (rows.length > 0) {
      currentStepRaw = rows[0];
    } else {
      const allDone = db.query(
        'SELECT COUNT(*) as cnt FROM steps WHERE session_id = ? AND status != \'passed\' AND status != \'skipped\'',
      ).get(sessionId) as Record<string, unknown>;
      if ((allDone.cnt as number) === 0) {
        db.run('UPDATE sessions SET status = \'done\', updated_at = datetime(\'now\') WHERE id = ?', [sessionId]);
        db.close();
        throw new EngineError(`All steps completed for session: ${sessionId}`);
      }
      db.close();
      throw new EngineError(`No pending steps found for session: ${sessionId}`);
    }
  }

  const currentStep = dbRowToStepRow(currentStepRaw);
  const stepDef = stepDefsByKey.get(currentStep.stepKey);

  if (!stepDef) {
    db.close();
    throw new EngineError(`Step definition not found in workflow: ${currentStep.stepKey}`);
  }

  const previousAttempts = getPreviousAttempts(db, currentStep.id);
  const artifacts = getArtifacts(db, sessionId);
  const attemptNumber = previousAttempts.length + 1;

  const promptCtx: PromptCtx = {
    sessionDir,
    artifactDbPath: session.artifactDbPath,
    attemptNumber,
    retryCount: currentStep.retryCount,
    maxRetries: currentStepRaw.max_retries as number,
    previousAttempts,
    artifacts,
  };

  let nextResult: NextResult;

  if (stepDef.type === 'human_gate') {
    const hg = stepDef.humanGate!;
    const artifactList = hg.presentArtifacts
      .map((k) => artifacts.find((a) => a.artifactKey === k))
      .filter(Boolean) as ArtifactRecord[];

    const choicesText = hg.choices.map((c) => `- **${c.value}**: ${c.label}${c.desc ? ` (${c.desc})` : ''}`).join('\n');
    const prompt = `## Human Gate: ${stepDef.phase}\n\n### 確認する成果物\n${
      artifactList.length > 0
        ? artifactList.map((a) => `- ${a.artifactKey}: ${a.filePath}`).join('\n')
        : '(成果物なし)'
    }\n\n### 選択肢\n${choicesText}\n\n回答は選択肢の value を入力してください。`;

    nextResult = {
      sessionId,
      stepKey: currentStep.stepKey,
      stepType: 'human_gate',
      phase: stepDef.phase,
      action: 'human_gate',
      prompt,
      parallel: null,
      constraints: {
        mustCallTaskTool: false,
        readonly: true,
        reportAfterCompletion: true,
      },
      context: {
        sessionDir,
        artifactDbPath: session.artifactDbPath,
        attemptNumber,
        retryCount: currentStep.retryCount,
        maxRetries: stepDef.maxRetries,
      },
    };
  } else if (stepDef.type === 'parallel') {
    const pd = stepDef.parallel!;
    const subtasks = pd.subtasks.map((st) => {
      const stPrompt = st.buildPrompt(promptCtx);
      return {
        key: st.key,
        subagentType: st.subagentType,
        prompt: stPrompt,
        constraints: {
          mustCallTaskTool: true,
          readonly: st.readonly ?? false,
          reportAfterCompletion: true,
        },
      };
    });

    const taskStep = stepDef.task;
    nextResult = {
      sessionId,
      stepKey: currentStep.stepKey,
      stepType: 'parallel',
      phase: stepDef.phase,
      action: taskStep?.action ?? 'run_subagent',
      prompt: '',
      parallel: { subtasks } as ParallelNextResult,
      constraints: {
        mustCallTaskTool: true,
        readonly: false,
        reportAfterCompletion: true,
      },
      context: {
        sessionDir,
        artifactDbPath: session.artifactDbPath,
        attemptNumber,
        retryCount: currentStep.retryCount,
        maxRetries: stepDef.maxRetries,
      },
    };
  } else {
    const taskStep = stepDef.task!;
    const prompt = taskStep.buildPrompt(promptCtx);

    nextResult = {
      sessionId,
      stepKey: currentStep.stepKey,
      stepType: 'task',
      phase: stepDef.phase,
      action: taskStep.action,
      subagentType: taskStep.subagentType,
      prompt,
      parallel: null,
      constraints: {
        mustCallTaskTool: taskStep.action === 'run_subagent',
        readonly: taskStep.readonly ?? false,
        reportAfterCompletion: true,
      },
      context: {
        sessionDir,
        artifactDbPath: session.artifactDbPath,
        attemptNumber,
        retryCount: currentStep.retryCount,
        maxRetries: stepDef.maxRetries,
      },
    };
  }

  db.run(
    `INSERT INTO step_attempts (step_id, attempt_number)
     VALUES (?, ?)`,
    [currentStep.id, attemptNumber],
  );

  db.run(
    `UPDATE steps SET status = 'running' WHERE id = ?`,
    [currentStep.id],
  );

  db.run(
    `UPDATE sessions SET current_step = ?, updated_at = datetime('now') WHERE id = ?`,
    [currentStep.stepKey, sessionId],
  );

  db.close();

  return nextResult;
}

function handleHumanGateTransition(
  db: Database,
  sessionId: string,
  step: StepRow,
  input: ReportInput,
  stepDef: StepDef,
  checkStatus: 'pass' | 'fail' | 'error',
  checkReasons: string[],
): ReportResult | null {
  const answer = (input.subagentOutput ?? '').trim();

  if (answer === 'revise') {
    const targetStep = stepDef.humanGate?.reviseTargetStep ?? stepDef.onFail.target ?? step.stepKey;
    db.run('UPDATE steps SET status = \'passed\' WHERE id = ?', [step.id]);
    db.run('UPDATE sessions SET current_step = ?, updated_at = datetime(\'now\') WHERE id = ?', [targetStep, sessionId]);
    return {
      sessionId,
      stepKey: input.stepKey,
      checkResult: { status: checkStatus, reasons: checkReasons },
      nextAction: 'goto',
      targetStep,
      message: `User requested revision. Going to: ${targetStep}`,
    };
  }

  if (answer === 'abort') {
    db.run('UPDATE sessions SET status = \'aborted\', updated_at = datetime(\'now\') WHERE id = ?', [sessionId]);
    return {
      sessionId,
      stepKey: input.stepKey,
      checkResult: { status: checkStatus, reasons: checkReasons },
      nextAction: 'abort',
      message: 'Session aborted by user.',
    };
  }

  return null;
}

function handleStepFailure(
  db: Database,
  sessionId: string,
  step: StepRow,
  stepRaw: Record<string, unknown>,
  input: ReportInput,
  checkStatus: 'pass' | 'fail' | 'error',
  checkReasons: string[],
  stepDef?: StepDef,
): ReportResult {
  const newRetryCount = step.retryCount + 1;
  const maxRetries = stepRaw.max_retries as number;

  if (newRetryCount <= maxRetries) {
    db.run('UPDATE steps SET retry_count = ?, status = \'pending\' WHERE id = ?', [newRetryCount, step.id]);
    db.run('UPDATE sessions SET current_step = ?, updated_at = datetime(\'now\') WHERE id = ?', [step.stepKey, sessionId]);
    return {
      sessionId,
      stepKey: input.stepKey,
      checkResult: { status: checkStatus, reasons: checkReasons },
      nextAction: 'retry',
      message: `Check failed. Retry ${newRetryCount}/${maxRetries}`,
    };
  }

  const onFailAction = stepRaw.on_fail_action as string;
  const onFailTarget = stepRaw.on_fail_target as string | null;

  if (onFailAction === 'goto' && onFailTarget) {
    const requeueSource = stepDef?.onFail?.requeueSource === true;
    db.run(
      `UPDATE steps SET status = ? WHERE id = ?`,
      [requeueSource ? 'pending' : 'failed', step.id],
    );
    db.run('UPDATE sessions SET current_step = ?, updated_at = datetime(\'now\') WHERE id = ?', [onFailTarget, sessionId]);
    return {
      sessionId,
      stepKey: input.stepKey,
      checkResult: { status: checkStatus, reasons: checkReasons },
      nextAction: 'goto',
      targetStep: onFailTarget,
      message: requeueSource
        ? `Step requires revision. Going to: ${onFailTarget} (review will re-run after fix)`
        : `Step failed after ${maxRetries} retries. Going to: ${onFailTarget}`,
    };
  }

  if (onFailAction === 'abort') {
    db.run('UPDATE steps SET status = \'failed\' WHERE id = ?', [step.id]);
    db.run('UPDATE sessions SET status = \'aborted\', updated_at = datetime(\'now\') WHERE id = ?', [sessionId]);
    return {
      sessionId,
      stepKey: input.stepKey,
      checkResult: { status: checkStatus, reasons: checkReasons },
      nextAction: 'abort',
      message: 'Step failed and onFail=abort. Session aborted.',
    };
  }

  if (onFailAction === 'escalate') {
    db.run('UPDATE steps SET status = \'failed\' WHERE id = ?', [step.id]);
    db.run('UPDATE sessions SET status = \'paused\', updated_at = datetime(\'now\') WHERE id = ?', [sessionId]);
    return {
      sessionId,
      stepKey: input.stepKey,
      checkResult: { status: checkStatus, reasons: checkReasons },
      nextAction: 'escalate',
      message: 'Step failed and onFail=escalate. Human intervention required.',
    };
  }

  db.run('UPDATE steps SET status = \'failed\' WHERE id = ?', [step.id]);
  return {
    sessionId,
    stepKey: input.stepKey,
    checkResult: { status: checkStatus, reasons: checkReasons },
    nextAction: 'abort',
    message: `Step failed after ${maxRetries} retries. Session stopped.`,
  };
}

export async function report(
  sessionId: string,
  input: ReportInput,
  baseDir: string,
  workflowPath?: string,
): Promise<ReportResult> {
  const sessionDir = path.resolve(baseDir, sessionId);
  const db = openDb(sessionDir);

  const sessionRowRaw = db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!sessionRowRaw) {
    db.close();
    throw new EngineError(`Session not found: ${sessionId}`);
  }
  const session = dbRowToSessionRow(sessionRowRaw);

  const resolvedWorkflowPath = workflowPath ?? sessionRowRaw.workflow_path as string;
  if (!resolvedWorkflowPath) {
    db.close();
    throw new EngineError('No workflow path available');
  }

  const stepRaw = db.query(
    'SELECT * FROM steps WHERE session_id = ? AND step_key = ?',
  ).get(sessionId, input.stepKey) as Record<string, unknown> | undefined;
  if (!stepRaw) {
    db.close();
    throw new EngineError(`Step not found: ${input.stepKey}`);
  }
  const step = dbRowToStepRow(stepRaw);

  const attemptRaw = db.query(
    'SELECT * FROM step_attempts WHERE step_id = ? ORDER BY attempt_number DESC LIMIT 1',
  ).get(step.id) as Record<string, unknown> | undefined;
  if (!attemptRaw) {
    db.close();
    throw new EngineError(`No attempt found for step: ${input.stepKey}`);
  }
  const attempt = dbRowToStepAttemptRow(attemptRaw);

  db.run(
    `UPDATE step_attempts SET ended_at = datetime('now'), result_json = ?, subtask_results_json = ?
     WHERE id = ?`,
    [input.subagentOutput ?? null, input.subtaskResults ? JSON.stringify(input.subtaskResults) : null, attempt.id],
  );

  if (input.artifacts && input.artifacts.length > 0) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const insertArtifact = db.prepare(
      'INSERT INTO artifacts (session_id, step_key, artifact_key, file_path, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    for (const a of input.artifacts) {
      insertArtifact.run(sessionId, input.stepKey, a.key, a.path, now);
    }
  }

  const def = await importWorkflowDef(resolvedWorkflowPath);
  const stepDef = def.steps.find((s) => s.key === input.stepKey);

  let checkStatus: 'pass' | 'fail' | 'error' = 'pass';
  let checkReasons: string[] = [];

  if (stepDef) {
    const artifacts = getArtifacts(db, sessionId);
    const attemptResult: AttemptResult = {
      status: input.status,
      subagentOutput: input.subagentOutput,
      errors: input.errors,
    };

    const checkCtx: CheckCtx = {
      sessionDir,
      artifactDbPath: session.artifactDbPath ?? undefined,
      attemptResult,
      artifacts,
    };

    try {
      const result = await stepDef.check(checkCtx);
      checkStatus = result.status;
      checkReasons = result.reasons;
    } catch (e) {
      checkStatus = 'error';
      checkReasons = [e instanceof Error ? e.message : String(e)];
    }

    if (stepDef.type === 'human_gate') {
      const answer = (input.subagentOutput ?? '').trim();
      const hg = stepDef.humanGate!;

      if (checkStatus === 'pass') {
        if (answer === 'approve') {
          checkReasons = ['User approved'];
        } else if (answer === 'revise') {
          checkStatus = 'fail';
          checkReasons = ['User requested revision'];
        } else if (answer === 'abort') {
          checkStatus = 'fail';
          checkReasons = ['User requested abort'];
        } else {
          checkStatus = 'fail';
          checkReasons = [`Unknown gate response: ${answer}`];
        }
      }
    }
  } else {
    checkStatus = input.status === 'completed' ? 'pass' : 'fail';
    checkReasons = input.errors ? [input.errors] : [];
  }

  db.run(
    `UPDATE step_attempts SET check_results_json = ?, check_status = ? WHERE id = ?`,
    [JSON.stringify(checkReasons), checkStatus, attempt.id],
  );

  if (checkStatus === 'pass') {
    db.run(
      `UPDATE steps SET status = 'passed' WHERE id = ?`,
      [step.id],
    );

    const nextStepRaw = db.query(
      'SELECT * FROM steps WHERE session_id = ? AND step_index > ? AND status = \'pending\' ORDER BY step_index LIMIT 1',
    ).get(sessionId, step.stepIndex) as Record<string, unknown> | undefined;

    if (nextStepRaw) {
      const nextStep = dbRowToStepRow(nextStepRaw);
      db.run('UPDATE sessions SET current_step = ?, updated_at = datetime(\'now\') WHERE id = ?', [nextStep.stepKey, sessionId]);
      db.close();
      return {
        sessionId,
        stepKey: input.stepKey,
        checkResult: { status: checkStatus, reasons: checkReasons },
        nextAction: 'continue',
        message: `Step passed. Next step: ${nextStep.stepKey}`,
      };
    } else {
      db.run('UPDATE sessions SET status = \'done\', updated_at = datetime(\'now\') WHERE id = ?', [sessionId]);
      db.close();
      return {
        sessionId,
        stepKey: input.stepKey,
        checkResult: { status: checkStatus, reasons: checkReasons },
        nextAction: 'done',
        message: 'All steps completed. Session done.',
      };
    }
  } else {
    if (stepDef && stepDef.type === 'human_gate') {
      const hgResult = handleHumanGateTransition(db, sessionId, step, input, stepDef, checkStatus, checkReasons);
      if (hgResult) {
        db.close();
        return hgResult;
      }
    }

    const result = handleStepFailure(db, sessionId, step, stepRaw, input, checkStatus, checkReasons, stepDef);
    db.close();
    return result;
  }
}

export function status(
  sessionId: string,
  baseDir: string,
): StatusResult {
  const sessionDir = path.resolve(baseDir, sessionId);
  const db = openDb(sessionDir);

  const sessionRowRaw = db.query('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!sessionRowRaw) {
    db.close();
    throw new EngineError(`Session not found: ${sessionId}`);
  }
  const session = dbRowToSessionRow(sessionRowRaw);

  const stepRows = db.query(
    'SELECT * FROM steps WHERE session_id = ? ORDER BY step_index',
  ).all(sessionId) as Record<string, unknown>[];

  const steps = stepRows.map((sRaw) => {
    const s = dbRowToStepRow(sRaw);
    const attemptRows = db.query(
      'SELECT * FROM step_attempts WHERE step_id = ? ORDER BY attempt_number',
    ).all(s.id) as Record<string, unknown>[];

    const maxRetries = sRaw.max_retries as number;
    const attempts = attemptRows.map((aRaw) => {
      const a = dbRowToStepAttemptRow(aRaw);
      return {
        attemptNumber: a.attemptNumber,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        checkStatus: a.checkStatus,
      };
    });

    return {
      key: s.stepKey,
      phase: s.phase ?? '',
      type: s.type,
      status: s.status,
      retryCount: s.retryCount,
      maxRetries,
      attempts,
    };
  });

  db.close();

  return {
    sessionId,
    workflowId: session.workflowId,
    sessionStatus: session.status,
    currentStep: session.currentStep,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    steps,
  };
}

function getPreviousAttempts(db: Database, stepId: number): AttemptSummary[] {
  const rows = db.query(
    'SELECT * FROM step_attempts WHERE step_id = ? ORDER BY attempt_number',
  ).all(stepId) as Record<string, unknown>[];
  return rows.map((r) => ({
    attemptNumber: r.attempt_number as number,
    startedAt: r.started_at as string,
    endedAt: r.ended_at as string | null,
    checkStatus: r.check_status as string | null,
    checkResults: r.check_results_json as string | null,
  }));
}

function getArtifacts(db: Database, sessionId: string): ArtifactRecord[] {
  const rows = db.query(
    'SELECT * FROM artifacts WHERE session_id = ?',
  ).all(sessionId) as Record<string, unknown>[];
  return rows.map((r) => dbRowToArtifactRow(r));
}
