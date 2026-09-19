import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";
import { join } from "node:path";

export const dedupCheckStep: TaskStepDef = {
  key: "dedup-check",
  phase: "重複チェック",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "ブレストで収集した 15 案と既存の open Issue/計画を照合し、重複を除外または注記する。",
        ],
        criteria: [],
        approach: [
          {
            title: "1. brainstorm-results.json の読み込み",
            content: [`${ctx.sessionDir}/brainstorm-results.json から 15 案を読み込む。`],
          },
          {
            title: "2. 既存 Issue/計画の取得",
            content: [
              "```bash",
              "gh issue list --state open --limit 50 --json number,title",
              `bun ${join(import.meta.dir, "../../../plan-run/list-plans.ts")} draft refined in-progress`,
              "```",
            ],
          },
          {
            title: "3. 照合・判定",
            content: [
              "各候補を既存 Issue/計画のタイトルと照合する:",
              "",
              "- **同一テーマ**: 候補から除外し、除外理由を記録する",
              "- **関連テーマ**: 候補に残し「既存 Issue #N に関連」と注記する",
              "- **無関係**: そのまま候補に残す",
            ],
          },
          {
            title: "4. 結果の保存",
            content: [
              `重複チェック後の候補リストを ${ctx.sessionDir}/dedup-results.json に保存する:`,
              "",
              "```json",
              "{",
              '  "candidates": [',
              "    {",
              '      "id": 1,',
              '      "title": "...",',
              '      "background": "...",',
              '      "evidence": "...",',
              '      "perspective": "...",',
              '      "note": "既存 Issue #N に関連"',
              "    }",
              "  ],",
              '  "excluded": [',
              '    { "id": 5, "title": "...", "reason": "Issue #N と同一テーマ" }',
              "  ]",
              "}",
              "```",
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
          "```json",
          `{"key": "dedup-results.json", "path": "${ctx.sessionDir}/dedup-results.json"}`,
          "```",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  // 統一最低ライン: 申告義務・実在・スキーマ（candidates/excluded）を強制
  check: (ctx: CheckCtx): CheckResult => {
    return requireStepArtifacts(ctx, [
      {
        key: "dedup-results.json",
        form: "json",
        keys: ["candidates", "excluded"],
        itemKeys: ["id", "title"],
      },
    ]);
  },
};
