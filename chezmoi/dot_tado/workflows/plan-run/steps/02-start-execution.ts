import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import type { PromptItem } from "../../shared/prompt/types";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";

// -------------------------------------------------------------------
// Step 2: 実行開始（refined → in-progress）
// -------------------------------------------------------------------
export const startExecutionStep: TaskStepDef = {
  key: "start-execution",
  phase: "実行開始",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      // NOTE(prompt-type): 要素は行頭#なしの通常文のみ。見出し追加時はSection化すること
      // 巨大な単一リテラルは ValidateSpec の再帰展開で TS2589 を起こすため、
      // PromptItem 配列に3分割して組み立てる（string[] widen はしない）。
      // 関心事ごと（妥当性検証／遷移と読み込み／報告と保存）にSection化し、
      // 各番号手順もサブSectionにして並列フラット化を避ける。
      const verifyPlan: PromptItem<4>[] = [
        {
          title: "1. 計画 Issue 番号の確認",
          content: [
            "ユーザーが指定した計画 Issue 番号 `<number>` を確認する（初回ヒアリングで取得済み）",
            "",
          ],
        },
        {
          title: "2. Issue の存在・状態の検証",
          content: [
            "Issue の存在・状態を検証する:",
            "",
            "```bash",
            "gh issue view <number> --json state,labels,number,title,url",
            "```",
            "",
            "- `kind/plan` label が付与されていることを確認",
            "- `state` が `OPEN` であることを確認",
            "",
          ],
        },
        {
          title: "3. 計画 status の検証",
          content: [
            "`list-plans.ts` で status を確認し、`refined` または `in-progress` であることを検証する:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "../list-plans.ts")}`,
            "```",
            "",
            "- `draft` なら `plan-create` へ案内して中断",
            "- `done` なら「完了済み。再開しますか？」と確認",
            "",
          ],
        },
        {
          title: "4. GitHub Sub Issue の確認",
          content: [
            "GitHub Sub Issue を確認する。Sub Issue を持つ親計画は実行できないため、子計画を選び直して中断する:",
            "",
            "```bash",
            "gh api repos/<owner>/<repo>/issues/<number>/sub_issues",
            "```",
            "",
          ],
        },
      ];
      const transitionAndRead: PromptItem<4>[] = [
        {
          title: "5. in-progress への遷移",
          content: [
            "`transition-plan.ts` を使って `refined` → `in-progress` に遷移する:",
            "",
            "```bash",
            `bun run ${join(import.meta.dir, "../../shared/plan-transition-plan/main.ts")} <number> in-progress`,
            "```",
            "",
            "既に `in-progress` の場合はスキップする。",
            "",
          ],
        },
        {
          title: "6. Issue body の読み込み",
          content: [
            "Issue body を読み込み、`## ✅ 完了条件`、`## 📦 アウトプット`、`## 🧭 方針`、`## 🐿️ メモ`、`## 🐢 履歴` を把握する:",
            "",
            "```bash",
            "gh issue view <number> --json body",
            "```",
            "",
            `読み込んだ body を ${ctx.sessionDir}/issue-body.md にも保存する。`,
            "",
          ],
        },
      ];
      const reportAndSave: PromptItem<4>[] = [
        {
          title: "7. 読み込み内容の要点報告",
          content: [
            "読み込んだ内容の要点を報告する:",
            "   - 完了条件の数と概要",
            "   - 主要な方針",
            "   - 未解決の `🤔 論点`（あれば着手前に方針へ取り込む）",
            "",
          ],
        },
        {
          title: "8. 計画番号と Issue body の保存",
          content: [
            "計画番号と Issue body を保存する。計画番号はセッションディレクトリの `plan-number.txt` に書き出し、report 時の `artifacts` に以下を含めること（申告漏れは check で fail になる）:",
            "```json",
            `[{"key": "plan-number.txt", "path": "${ctx.sessionDir}/plan-number.txt"}, {"key": "issue-body.md", "path": "${ctx.sessionDir}/issue-body.md"}]`,
            "```",
          ],
        },
      ];
      return buildStepPrompt({
        purpose: [
          "計画 Issue の妥当性を検証し、状態を in-progress に遷移して Issue body を読み込む。",
        ],
        criteria: [],
        approach: [
          { title: "計画 Issue の妥当性検証", content: verifyPlan },
          { title: "状態遷移と Issue body の読み込み", content: transitionAndRead },
          { title: "内容報告と番号保存", content: reportAndSave },
        ],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  // 統一最低ライン: 計画番号・Issue body の申告・実在・形式を強制
  check: (ctx: CheckCtx): CheckResult => {
    return requireStepArtifacts(ctx, [
      { key: "plan-number.txt", form: "text", pattern: /^[0-9]+$/ },
      {
        key: "issue-body.md",
        form: "markdown",
        sections: ["## ✅ 完了条件", "## 🧭 方針", "## 🐢 履歴"],
      },
    ]);
  },
};
