import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";

// -----------------------------------------------------------------------
// Phase 1: 事前ヒアリング
// -----------------------------------------------------------------------
export const phase1HearingStep: TaskStepDef = {
  key: "phase1-hearing",
  phase: "Phase 1: 事前ヒアリング",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const hearingPath = join(ctx.sessionDir, "hearing.md");
      return buildStepPrompt({
        purpose: [
          "事前ヒアリング。調査の背景・目的・前提知識をユーザーから引き出し hearing.md にまとめる。",
        ],
        criteria: [],
        approach: [
          {
            title: "1. ヒアリング本体",
            content: [
              "質問は一度に 1 つ。ユーザーが「十分」と宣言するまで継続する。",
              "質問の際は番号付きの 3 つの選択肢を提示し、各選択肢に 5 段階の推奨度（例: ★★★★☆）と理由を添える。",
              "",
              "- **ユーザー決定領域:** 背景、目的、前提知識、制約、スコープ — 推測で埋めず質問で確認",
              "- **AI 提案領域:** 調査方針、観点、制約の提案 — 選択肢・推奨度・理由を添えて提案",
              "",
            ],
          },
          {
            title: "2. 軽量な調査で済む場合の判断",
            content: [
              "軽量な一次資料調査だけで足りる場合は、フル Deep Research の前に次を試してよい:",
              "1. 公式 docs / 仕様 / ソースコードなど一次資料だけを当たる",
              "2. 主張ごとに出典を付ける",
              "3. リポジトリの既存メモ規約に合わせて 1 ファイルへ残す",
              "",
              "この場合、フル Deep Research を継続するかユーザーに確認する。",
              "",
            ],
          },
          {
            title: "3. hearing.md の書き出し",
            content: [
              `ヒアリング結果を ${hearingPath} に書き出す（背景・目的・前提知識・制約・スコープを構造化）。`,
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める:",
          "```json",
          `{"key": "hearing.md", "path": "${hearingPath}"}`,
          "```",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`, `hearing.md 出力先: ${hearingPath}`],
      });
    },
  },
  // 統一最低ライン: 申告義務・実在・非空を強制（DB 直書きステップは
  // 既存 SQLite 監査が最低ライン相当。ファイル成果物を持つのは phase1 のみ）
  check: (ctx: CheckCtx): CheckResult => {
    return requireStepArtifacts(ctx, [{ key: "hearing.md", form: "markdown" }]);
  },
};
