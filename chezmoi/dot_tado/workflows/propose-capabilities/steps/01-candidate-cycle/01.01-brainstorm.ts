import type { CheckCtx, CheckResult, GateAnswers, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";
import { gateDecisionValue } from "../../helper/gate-decision-value.ts";
import { gateDecisionInput } from "../../helper/gate-decision-input.ts";

/// loop 先頭 worker への差し戻し注入文面。request_changes の追加入力を原文のまま載せる。
/// 回答なし・approve・abort・未知値は「なし」扱い（abort は judge が error で止める）。
/// gateAnswers のみで判定する純粋関数（ConditionCtx への暗黙変換はしない）。
function formatGateReworkFeedback(gateAnswers: GateAnswers, stepKey: string): string {
  const value = gateDecisionValue(gateAnswers, stepKey);
  if (value !== "request_changes") return "- (なし。初回実行または前回 approve)";
  const input = gateDecisionInput(gateAnswers, stepKey);
  if (input === undefined || input.trim() === "") {
    return `- ${stepKey}: (⚠️ request_changes の追加入力がありません。gateAnswers の記録不備の可能性があり、judge の check が fail で停止する)`;
  }
  return `- ${stepKey}: ${input}`;
}

export const brainstormStep: TaskStepDef = {
  key: "brainstorm",
  phase: "ブレスト（候補サイクル先頭）",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "対象 repo を軽量走査し、Capability 軸（新しい能力の獲得）の企画候補を 3 人の SubAgent で並列ブレストする。",
          "各 SubAgent は異なる視点で 5 案ずつ出し、合計 15 案を収集する。",
        ],
        criteria: [],
        approach: [
          {
            title: "1. 対象 repo の確認",
            content: ["```bash", "gh repo view --json nameWithOwner", "```"],
          },
          {
            title: "2. 3 SubAgent 並列起動",
            content: [
              "Task ツールで 3 人の SubAgent を同一メッセージで並列起動する。各 SubAgent に以下を指示する:",
              "",
              "- 対象 repo の軽量走査（README・ディレクトリ構造・マニフェスト・docs・既存スキル定義・git log -20）",
              "- 指定された視点で 5 案の企画候補を抽出",
              "- 各候補に「タイトル」「背景（根拠を織り込む）」「走査根拠」を付与",
              "- 既存の仕組みで既にカバーされている能力は候補にしない",
              "- 既存 open Issue を確認し、重複しそうな案は避ける（二重防御）",
              "",
              {
                title: "SubAgent 1: ユーザー体験向上",
                content: [
                  "「この repo のユーザー（= 自分）の日常的な体験を向上させる新しい能力は何か」の視点で 5 案。",
                  "",
                ],
              },
              {
                title: "SubAgent 2: 開発効率向上",
                content: [
                  "「この repo の開発・保守を効率化する新しい能力は何か」の視点で 5 案。",
                  "",
                ],
              },
              {
                title: "SubAgent 3: エコシステム拡張",
                content: [
                  "「この repo のエコシステム（連携ツール・プラグイン・外部サービス）を拡張する新しい能力は何か」の視点で 5 案。",
                ],
              },
            ],
          },
          {
            title: "3. 結果の集約",
            content: [
              "3 人の SubAgent から返却された合計 15 案を 1 つのリストにまとめる。",
              "各候補に以下の情報を含める:",
              "- タイトル",
              "- 背景（根拠を織り込んだ 2〜3 文）",
              "- 走査根拠（具体的なファイル・箇所）",
              "- 視点（どの SubAgent の案か）",
              "",
              "集約結果をセッションディレクトリに `brainstorm-results.json` として保存する:",
              "",
              "```json",
              "{",
              '  "candidates": [',
              "    {",
              '      "id": 1,',
              '      "title": "...",',
              '      "background": "...",',
              '      "evidence": "...",',
              '      "perspective": "ユーザー体験向上"',
              "    }",
              "  ]",
              "}",
              "```",
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
          "```json",
          `{"key": "brainstorm-results.json", "path": "${ctx.sessionDir}/brainstorm-results.json"}`,
          "```",
        ],
        policy: [
          "- repo のファイルを変更しない（読み取り専用）",
          "- Issue を起票しない",
          "- 候補の水増しをしない（各 SubAgent ちょうど 5 案）",
        ],
        input: [
          {
            title: "前回の差し戻し",
            content: [
              "gate:present-gate の request_changes 追加入力。原文のまま候補へ反映する:",
              formatGateReworkFeedback(ctx.gateAnswers, "present-gate"),
              "",
            ],
          },
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `反復: ${ctx.loop?.iteration ?? 1}/${ctx.loop?.maxIterations ?? 3}（上限到達時は loop 外の人間判断へ渡る）`,
        ],
      });
    },
  },
  // 統一最低ライン: 申告義務・実在・スキーマ（15 案 = 各 SubAgent 5 案 × 3）を強制
  check: (ctx: CheckCtx): CheckResult => {
    return requireStepArtifacts(ctx, [
      {
        key: "brainstorm-results.json",
        form: "json",
        minItems: 15,
        itemKeys: ["id", "title", "background", "evidence", "perspective"],
      },
    ]);
  },
};
