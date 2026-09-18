import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";

export const reviewScoreStep: TaskStepDef = {
  key: "review-score",
  phase: "レビュー・採点",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "重複チェック後の候補（最大 15 案）を 3 人のレビュアー SubAgent で並列採点し、上位 5 案を選出する。",
        ],
        criteria: [],
        approach: [
          {
            title: "1. dedup-results.json の読み込み",
            content: [`${ctx.sessionDir}/dedup-results.json から候補リストを読み込む。`],
          },
          {
            title: "2. 3 レビュアー SubAgent 並列起動",
            content: [
              "Task ツールで 3 人のレビュアーを同一メッセージで並列起動する。",
              "各レビュアーは自分の観点で全候補を 1〜5 点で採点する。",
              "",
              {
                title: "レビュアー 1: インパクト",
                content: [
                  "「その能力が日常のワークフローをどれだけ変えるか。頻度 × 効果の大きさ」で採点。",
                  "",
                ],
              },
              {
                title: "レビュアー 2: 実現可能性",
                content: [
                  "「既存の技術・依存・スキルで現実的に実装できるか。未知の技術リスクがないか」で採点。",
                  "",
                ],
              },
              {
                title: "レビュアー 3: 優位性",
                content: [
                  "「既存ツールや他のスキルに対する優位があるか。この repo に置く必然性があるか」で採点。",
                  "",
                ],
              },
              "各レビュアーの返却形式:",
              "",
              "```json",
              "{",
              '  "criterion": "インパクト",',
              '  "scores": [',
              '    { "id": 1, "score": 4, "comment": "..." },',
              '    { "id": 2, "score": 3, "comment": "..." }',
              "  ]",
              "}",
              "```",
            ],
          },
          {
            title: "3. 集計・選出",
            content: [
              "3 観点の合計点で降順ソートし、上位 5 案を選出する。",
              "同点の場合はレビュアーのコメントを添えてユーザーに最終判断を委ねる（present-gate で提示）。",
            ],
          },
          {
            title: "4. 結果の保存",
            content: [
              `採点結果を ${ctx.sessionDir}/review-results.json に保存する:`,
              "",
              "```json",
              "{",
              '  "ranked": [',
              "    {",
              '      "id": 3,',
              '      "title": "...",',
              '      "background": "...",',
              '      "evidence": "...",',
              '      "note": "...",',
              '      "scores": { "インパクト": 4, "実現可能性": 5, "優位性": 3 },',
              '      "total": 12,',
              '      "comments": { "インパクト": "...", "実現可能性": "...", "優位性": "..." }',
              "    }",
              "  ]",
              "}",
              "```",
            ],
          },
          {
            title: "5. present-gate での提示フォーマット",
            content: [
              "present-gate では上位 5 案を以下のフォーマットでユーザーに提示する。",
              "推奨度は合計点から算出: 3-5=★1, 6-7=★2, 8-9=★3, 10-11=★4, 12-15=★5",
              "",
              "```",
              "┌─────────────────────────────────────────────────",
              "│ [1] <タイトル>",
              "│     推奨度: ★★★★☆",
              "├─────────────────────────────────────────────────",
              "│ 💭 背景",
              "│   <2〜3文の背景説明>",
              "│",
              "│ 🔍 根拠",
              "│   <具体的なファイル・箇所>",
              "│",
              "│ ⭐ 推奨理由",
              "│   <なぜこの推奨度か>",
              "│",
              "│ 📊 評価",
              "│   インパクト: 4 / 実現可能性: 5 / 優位性: 3 → 合計: 12",
              "│",
              "│ 📎 注記",
              "│   既存 Issue #N に関連（該当時のみ。なければ省略）",
              "└─────────────────────────────────────────────────",
              "```",
              "",
              "提示後に以下を促す:",
              "",
              "「起票する候補の番号を教えてください（複数可、例: 1,3,5）。すべて見送る場合は「なし」と入力してください。」",
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
          "```json",
          `{"key": "review-results.json", "path": "${ctx.sessionDir}/review-results.json"}`,
          "```",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  // 統一最低ライン: 申告義務・実在・スキーマ（ranked + scores）を強制
  check: (ctx: CheckCtx): CheckResult => {
    return requireStepArtifacts(ctx, [
      {
        key: "review-results.json",
        form: "json",
        keys: ["ranked"],
        minItems: 1,
        itemKeys: ["id", "title", "scores", "total"],
      },
    ]);
  },
};
