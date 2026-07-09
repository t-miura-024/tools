const def = {
  id: 'test-simple',
  steps: [
    {
      key: 'step1_task',
      phase: 'テストタスク',
      type: 'task',
      maxRetries: 2,
      onFail: { action: 'abort' },
      task: {
        action: 'run_subagent',
        subagentType: 'test-agent',
        buildPrompt: (ctx) => `Execute step1_task attempt ${ctx.attemptNumber}. Session: ${ctx.sessionDir}`,
      },
      check: (ctx) => {
        const output = ctx.attemptResult.subagentOutput ?? '';
        return output.includes('success')
          ? { status: 'pass', reasons: ['Output contains success'] }
          : { status: 'fail', reasons: ['Output does not contain success'] };
      },
    },
    {
      key: 'step2_human_gate',
      phase: '確認',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: [],
        choices: [
          { value: 'approve', label: '承認', desc: '次に進む' },
          { value: 'revise', label: '修正', desc: '前のステップをやり直す' },
          { value: 'abort', label: '中断' },
        ],
        reviseTargetStep: 'step1_task',
      },
      check: (_ctx) => ({ status: 'pass', reasons: [] }),
    },
    {
      key: 'step3_parallel',
      phase: '並列実行',
      type: 'parallel',
      maxRetries: 1,
      onFail: { action: 'abort' },
      parallel: {
        subtasks: [
          { key: 'sub_a', subagentType: 'test-agent-a', buildPrompt: (ctx) => `Subtask A: ${ctx.sessionDir}` },
          { key: 'sub_b', subagentType: 'test-agent-b', buildPrompt: (ctx) => `Subtask B: ${ctx.sessionDir}` },
        ],
      },
      task: {
        action: 'run_subagent',
        buildPrompt: (_ctx) => '',
      },
      check: (ctx) => {
        const output = ctx.attemptResult.subagentOutput ?? '';
        return output.includes('done')
          ? { status: 'pass', reasons: ['All subtasks done'] }
          : { status: 'fail', reasons: ['Not all subtasks done'] };
      },
    },
  ],
};

export default def;
