---
name: mt-workflow
description: LLM のワークフロー順守を強制する決定論的ワークフローエンジン。init/next/report/status の4コマンドでセッション管理・ステップ進行・リトライ判定を行う。
---

# mt-workflow

決定論的ワークフローエンジンです。
LLM がオーケストレーションする多段ワークフローで、手順抜かし・簡略化を防ぎます。
状態は SQLite（`workflow.db`）で機械的に管理し、LLM は `next` で返される完全プロンプトに従うだけです。

## アーキテクチャ

```
Skill (mt-deep-research, etc.)
  └── workflow.ts  ── ワークフロー定義（WorkflowDef）
                          │
mt-workflow (共有エンジン)  │
  ├── cli.ts  ── CLI エントリポイント（init/next/report/status）
  └── engine.ts ── 状態機械核心（SQLite 管理）
```

## コマンド

### init

```bash
bun run /path/to/mt-workflow/cli.ts init --workflow <path-to-workflow.ts> [--base-dir <dir>] [--session <id>]
```

ワークフロー定義を読み込み、セッションを初期化する。
- `workflow.db` を `{baseDir}/{sessionId}/` に作成
- sessions/steps テーブルを初期化
- フック（beforeInit/afterInit）を実行
- セッションIDを stdout に JSON で出力

### next

```bash
bun run /path/to/mt-workflow/cli.ts next --session <id> [--base-dir <dir>]
```

現在のステップのプロンプトを生成し、stdout に構造化 JSON で出力する。
返却形式は Step タイプにより異なる：

**task:**
```json
{
  "sessionId": "...",
  "stepKey": "spec_writer",
  "stepType": "task",
  "action": "run_subagent",
  "subagentType": "mt-sdd-spec-writer",
  "prompt": "## 目的\n...",
  "constraints": { "mustCallTaskTool": true, "readonly": false, "reportAfterCompletion": true },
  "context": { "sessionDir": "...", "attemptNumber": 1, "retryCount": 0, "maxRetries": 3 }
}
```

**human_gate:**
```json
{
  "stepKey": "approve",
  "stepType": "human_gate",
  "action": "human_gate",
  "prompt": "## Human Gate: 仕様確認\n\n### 選択肢\n- approve: 承認\n- revise: 修正\n- abort: 中断",
  "constraints": { "mustCallTaskTool": false, "readonly": true, "reportAfterCompletion": true }
}
```

**parallel:**
```json
{
  "stepType": "parallel",
  "parallel": {
    "subtasks": [
      { "key": "researcher_q1", "subagentType": "...", "prompt": "...", "constraints": {...} },
      { "key": "researcher_q2", "subagentType": "...", "prompt": "...", "constraints": {...} }
    ]
  }
}
```

### report

```bash
echo '{...}' | bun run /path/to/mt-workflow/cli.ts report --session <id>
```

stdin から JSON でステップ実行結果を受け取り、完了検証を走らせて状態遷移・リトライ判定を行う。

**入力形式:**
```json
{
  "stepKey": "spec_writer",
  "status": "completed",
  "subagentOutput": "仕様書を作成しました...",
  "artifacts": [{"key": "spec.md", "path": "tmp/sdd/spec.md"}]
}
```

**並列実行時の入力形式:**
```json
{
  "stepKey": "researcher",
  "status": "completed",
  "subtaskResults": [
    {"subtaskKey": "researcher_q1", "subagentOutput": "...", "status": "completed"},
    {"subtaskKey": "researcher_q2", "subagentOutput": "...", "status": "failed", "error": "timeout"}
  ]
}
```

**Human Gate の回答:**
```json
{
  "stepKey": "approve",
  "status": "completed",
  "subagentOutput": "approve"
}
```

### status

```bash
bun run /path/to/mt-workflow/cli.ts status --session <id>
```

セッションの現在状態を stdout に JSON で出力する。

## ワークフロー定義の作成

各スキルディレクトリに `workflow.ts` を配置する。
`WorkflowDef` を default export する。

```typescript
import type { WorkflowDef, CheckCtx, PromptCtx, CheckResult } from '../mt-workflow/types';

const def: WorkflowDef = {
  id: 'mt-deep-research',
  steps: [
    {
      key: 'phase1_planner',
      phase: '調査計画',
      type: 'task',
      maxRetries: 3,
      onFail: { action: 'escalate' },
      task: {
        action: 'run_subagent',
        subagentType: 'mt-deep-research-planner',
        buildPrompt: (ctx: PromptCtx) => {
          return `## 目的\nplan.mdを作成し...\n\n### コンテキスト\n- セッション: ${ctx.sessionDir}`;
        },
      },
      check: (ctx: CheckCtx): CheckResult => {
        const { existsSync } = await import('node:fs');
        const planExists = existsSync(`${ctx.sessionDir}/plan.md`);
        return {
          status: planExists ? 'pass' : 'fail',
          reasons: planExists ? ['plan.md exists'] : ['plan.md not found'],
        };
      },
    },
    {
      key: 'phase2_approve',
      phase: '仕様承認',
      type: 'human_gate',
      maxRetries: 1,
      onFail: { action: 'escalate' },
      humanGate: {
        presentArtifacts: ['plan.md'],
        choices: [
          { value: 'approve', label: '承認' },
          { value: 'revise', label: '修正が必要' },
          { value: 'abort', label: '中断' },
        ],
        reviseTargetStep: 'phase1_planner',
      },
      check: (_ctx: CheckCtx): CheckResult => ({ status: 'pass', reasons: [] }),
    },
  ],
};

export default def;
```

## セッション再開

```bash
bun run cli.ts next --session <id>
```

中断したセッションIDを指定すれば、`workflow.db` から状態を復元して再開できる。

## 注意事項

- 各スキルは `workflow.ts` でワークフロー定義を提供する
- 既存の SubAgent やスクリプトは、workflow.ts の buildPrompt/check から参照する
- `workflow.db`（状態DB）と成果物DB（research.db等）は完全分離
- `next` が返すプロンプトは完全で、LLM が再構築の余地を持たない
