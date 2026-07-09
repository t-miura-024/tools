export interface WorkflowDef {
  id: string;
  steps: StepDef[];
  beforeInit?: (ctx: InitCtx) => Promise<void>;
  afterInit?: (ctx: InitCtx) => Promise<AfterInitResult>;
}

export interface AfterInitResult {
  artifactDbPath?: string;
  artifacts?: ArtifactInput[];
}

export interface StepDef {
  key: string;
  phase: string;
  type: 'task' | 'human_gate' | 'parallel';
  maxRetries: number;
  onFail: OnFailStrategy;
  check: (ctx: CheckCtx) => CheckResult;
  task?: TaskStepDef;
  humanGate?: HumanGateStepDef;
  parallel?: ParallelStepDef;
}

export interface TaskStepDef {
  action: 'run_subagent' | 'run_command' | 'orchestrate';
  subagentType?: string;
  readonly?: boolean;
  buildPrompt: (ctx: PromptCtx) => string;
}

export interface HumanGateStepDef {
  presentArtifacts: string[];
  choices: GateChoice[];
  reviseTargetStep?: string;
}

export interface ParallelStepDef {
  subtasks: SubtaskDef[];
}

export interface SubtaskDef {
  key: string;
  subagentType: string;
  readonly?: boolean;
  buildPrompt: (ctx: PromptCtx) => string;
}

export interface OnFailStrategy {
  action: 'retry' | 'goto' | 'abort' | 'escalate';
  target?: string;
}

export interface GateChoice {
  value: string;
  label: string;
  desc?: string;
}

export interface InitCtx {
  sessionDir: string;
  sessionId: string;
}

export interface CheckCtx {
  sessionDir: string;
  artifactDbPath?: string;
  attemptResult: AttemptResult;
  artifacts: ArtifactRecord[];
}

export interface PromptCtx {
  sessionDir: string;
  artifactDbPath?: string;
  attemptNumber: number;
  retryCount: number;
  maxRetries: number;
  previousAttempts: AttemptSummary[];
  artifacts: ArtifactRecord[];
}

export interface CheckResult {
  status: 'pass' | 'fail' | 'error';
  reasons: string[];
}

export interface ArtifactInput {
  key: string;
  path: string;
}

export interface ArtifactRecord {
  id: number;
  sessionId: string;
  stepKey: string;
  artifactKey: string;
  filePath: string;
  createdAt: string;
}

export interface AttemptResult {
  status: 'completed' | 'failed';
  subagentOutput?: string;
  errors?: string;
}

export interface AttemptSummary {
  attemptNumber: number;
  startedAt: string;
  endedAt?: string;
  checkStatus?: string;
  checkResults: string | null;
}

export interface SubtaskResult {
  subtaskKey: string;
  subagentOutput: string;
  status: 'completed' | 'failed';
  error?: string;
}

export interface ReportInput {
  stepKey: string;
  status: 'completed' | 'failed';
  subagentOutput?: string;
  subtaskResults?: SubtaskResult[];
  artifacts?: { key: string; path: string }[];
  errors?: string;
}

export interface SessionRow {
  id: string;
  workflowId: string;
  sessionDir: string;
  artifactDbPath: string | null;
  currentStep: string | null;
  status: 'running' | 'paused' | 'done' | 'aborted';
  createdAt: string;
  updatedAt: string;
}

export interface StepRow {
  id: number;
  sessionId: string;
  stepKey: string;
  stepIndex: number;
  phase: string | null;
  type: 'task' | 'human_gate' | 'parallel';
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  retryCount: number;
  maxRetries: number;
  createdAt: string;
}

export interface StepAttemptRow {
  id: number;
  stepId: number;
  attemptNumber: number;
  startedAt: string;
  endedAt: string | null;
  resultJson: string | null;
  subtaskResultsJson: string | null;
  checkResultsJson: string | null;
  checkStatus: 'pass' | 'fail' | 'error' | null;
}

export interface ArtifactRow {
  id: number;
  sessionId: string;
  stepKey: string;
  artifactKey: string;
  filePath: string;
  createdAt: string;
}

export interface InitResult {
  sessionId: string;
  sessionDir: string;
  workflowId: string;
}

export interface NextResult {
  sessionId: string;
  stepKey: string;
  stepType: 'task' | 'human_gate' | 'parallel';
  phase: string;
  action: string;
  subagentType?: string;
  prompt: string;
  parallel?: ParallelNextResult | null;
  constraints: {
    mustCallTaskTool: boolean;
    readonly: boolean;
    reportAfterCompletion: boolean;
  };
  context: {
    sessionDir: string;
    artifactDbPath: string | null;
    attemptNumber: number;
    retryCount: number;
    maxRetries: number;
  };
}

export interface ParallelNextResult {
  subtasks: {
    key: string;
    subagentType: string;
    prompt: string;
    constraints: {
      mustCallTaskTool: boolean;
      readonly: boolean;
      reportAfterCompletion: boolean;
    };
  }[];
}

export interface ReportResult {
  sessionId: string;
  stepKey: string;
  checkResult: CheckResult;
  nextAction: 'continue' | 'retry' | 'goto' | 'abort' | 'escalate' | 'done' | 'human_gate';
  targetStep?: string;
  message: string;
}

export interface StatusResult {
  sessionId: string;
  workflowId: string;
  sessionStatus: string;
  currentStep: string | null;
  createdAt: string;
  updatedAt: string;
  steps: {
    key: string;
    phase: string;
    type: string;
    status: string;
    retryCount: number;
    maxRetries: number;
    attempts: {
      attemptNumber: number;
      startedAt: string;
      endedAt: string | null;
      checkStatus: string | null;
    }[];
  }[];
}
