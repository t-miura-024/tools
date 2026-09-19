import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../../shared/artifact-check/require-step-artifacts";
import { readRepoInfo } from "../../helper/read-repo-info.ts";

const GRILL_MAP_KEY = "grill-map.md";
const PREPARE_DECISION_KEY = "prepare-decision.json";

// -----------------------------------------------------------------
// Step 4: 起票準備
// -----------------------------------------------------------------
export const prepareStep: TaskStepDef = {
  key: "prepare",
  phase: "起票準備",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const repoInfo = readRepoInfo(ctx.artifacts, ctx.sessionDir);

      return buildStepPrompt({
        purpose: [
          "起票に必要な環境整備（label 確認）を行い、分解要否の判定材料を artifact に書き出す。",
        ],
        criteria: [
          "`prepare-decision.json` に mode / fromIssue / issueNumber / repo が書き出されている",
        ],
        approach: [
          {
            title: "1. 対象 repo の確認",
            content: [
              `対象 repo: \`${repoInfo.nameWithOwner}\`（afterInit で取得済み）`,
              "",
              "- owner が `t-miura-024` → そのまま",
              "- それ以外 → `t-miura-024/note` + `external/<repo>` label",
            ],
          },
          {
            title: "2. label の確認・自動作成",
            content: [
              "`kind/plan` label がなければ自動作成。`external/<repo>` label も同様（冪等に）。",
              "",
              "```bash",
              'gh label list --search "kind/plan" --json name',
              'gh label create "kind/plan" --description "計画 Issue" --color "0075ca" 2>/dev/null || true',
              "```",
            ],
          },
          {
            title: "3. 分解要否の判定",
            content: [
              `Grill Phase で確定した内容（ライブ地図 \`${GRILL_MAP_KEY}\`）を確認し、以下を判定する:`,
              "",
              '- 計画が複数の機能・領域を含み、単一 Issue では独立した完了条件と進捗を管理できない場合 → `mode: "decompose"`',
              '- それ以外 → `mode: "update"`',
              "",
              "from-Issue フローの場合は既存 Issue 番号も記録する。",
            ],
          },
          {
            title: "4. 判定結果の書き出し",
            content: [
              `判定結果を ${ctx.sessionDir}/prepare-decision.json に書き出す:`,
              "",
              "```json",
              "{",
              '  "mode": "update" | "decompose",',
              '  "fromIssue": true | false,',
              '  "issueNumber": <number | null>,',
              '  "repo": "<owner>/<repo>"',
              "}",
              "```",
            ],
          },
          {
            title: "5. 起票案の提示",
            content: [
              "分解する場合は、親・子の計画案（各子の目的・対応スコープ）を提示する準備をする。",
              "- 子計画は 1 階層までとし、再分解しない",
              "- 子の目的・対応スコープの和集合が親計画を過不足なく満たすことを確認する",
            ],
          },
        ],
        output: [
          "report 時の `artifacts` に以下を含める:",
          "```json",
          `{"key": "prepare-decision.json", "path": "${ctx.sessionDir}/prepare-decision.json"}`,
          "```",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    return requireStepArtifacts(ctx, [
      {
        key: PREPARE_DECISION_KEY,
        form: "json",
        keys: ["mode", "fromIssue", "issueNumber", "repo"],
      },
    ]);
  },
};
