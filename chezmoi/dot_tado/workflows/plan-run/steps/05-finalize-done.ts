import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { findArtifactText } from "tado/artifacts";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";
import { verifyIssueClosed } from "../../shared/gh-issue-verify/verify-issue-closed";

// -------------------------------------------------------------------
// Step 8: 完了処理（in-progress → done）
// -------------------------------------------------------------------
export const finalizeDoneStep: TaskStepDef = {
  key: "finalize-done",
  phase: "完了処理",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: ["計画 Issue を `done` に遷移し、完了処理を行う。"],
        criteria: [],
        approach: [
          "1. Issue body を再読み込みし、完了条件がすべて満たされていることを最終確認する",
          "",
          "2. `transition-plan.ts` を使って `in-progress` → `done` に遷移する:",
          "",
          "```bash",
          `bun run ${join(import.meta.dir, "../../shared/plan-transition-plan/main.ts")} <number> done`,
          "```",
          "",
          "このコマンドは以下を自動実行する:",
          "- GitHub Project の Status を `done` に更新",
          "- Issue を close",
          "- `## 🐢 履歴` へ遷移エントリを追記",
          "- 親計画が存在する場合は自動的に親の状態集約を行う（出力の `parent:` 行を確認）",
          "",
          "3. 完了を報告する:",
          "   - Issue の URL・番号",
          "   - 完了した作業",
          "   - 残っている未決事項（あれば）",
          "",
        ],
        output: [
          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
          "```json",
          `{"key": "plan-number.txt", "path": "${ctx.sessionDir}/plan-number.txt"}`,
          "```",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  // 統一最低ライン+ 副作用実照合: done 遷移の実態（Issue が CLOSED）を gh で確認。
  check: (ctx: CheckCtx): CheckResult => {
    const result = requireStepArtifacts(ctx, [
      { key: "plan-number.txt", form: "text", pattern: /^[0-9]+$/ },
    ]);
    if (result.status !== "pass") return result;
    const raw = findArtifactText(ctx.artifacts, "plan-number.txt", ctx.sessionDir);
    const number = (raw ?? "").trim();
    const ghReasons = verifyIssueClosed(number);
    if (ghReasons.length > 0) return { status: "fail", reasons: ghReasons };
    const reasons = [`issue #${number} is closed on GitHub`];
    return { status: "pass", reasons };
  },
};
