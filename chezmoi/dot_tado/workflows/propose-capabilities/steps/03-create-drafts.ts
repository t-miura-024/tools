import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";
import { join } from "node:path";
import fs from "node:fs";
import { verifyIssueOpenLabeled } from "../../shared/gh-issue-verify/verify-issue-open-labeled";

export const createDraftsStep: TaskStepDef = {
  key: "create-drafts",
  phase: "draft 起票",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: ["ユーザーが選択した候補を最小構成の draft Issue として起票する。"],
        criteria: [],
        approach: [
          {
            title: "1. label の確認・自動作成",
            content: [
              "```bash",
              'gh label create kind/plan --repo <owner>/<repo> --color "0E8A16" --description "計画 Issue" 2>/dev/null || true',
              "```",
            ],
          },
          {
            title: "2. Issue 作成",
            content: [
              "各選択候補について `gh issue create` で起票する。",
              "",
              "- **本文はタイトル + `## 💭 背景` のみの最小構成**とする。完了条件・方針・ミッションは書かない",
              "- 背景には走査根拠と企画の意図を自然に織り込む",
              "- 重複チェックで注記がある場合は背景末尾に `関連: #N` を追記する",
              "",
              // gh body 例示はフェンス文字列内に隔離する（先頭が ``` のため
              // PromptString の行頭#検査に触れない。連結ハックは使わない）。
              '```bash\ngh issue create --repo <owner>/<repo> \\\n  --title "<タイトル>" \\\n  --body "## 💭 背景\n\n<背景本文（根拠を織り込む）>\n\n## 🐢 履歴\n" \\\n  --label "kind/plan"\n```',
            ],
          },
          {
            title: "3. Project 追加・Status 設定",
            content: [
              "`~/.config/mt-plan/config.json` から `projectNumber`, `owner`, `statusFieldId`, `statusOptions.draft` を読み取り、Project に追加して Status を `draft` に設定する。",
              "",
              "```bash",
              "gh project item-add <projectNumber> --owner <owner> --url <issueUrl> --format json",
              "gh project item-edit --id <itemId> --field-id <statusFieldId> --single-select-option-id <draftOptionId>",
              "```",
            ],
          },
          {
            title: "4. 報告",
            content: [
              "起票結果を報告する:",
              "- 各 Issue の URL、タイトル、Status",
              "- 起票しなかった候補の一覧",
              "- 次ステップの案内: 「具体化は `plan-create` の from-Issue フローで取り込めます」",
            ],
          },
        ],
        output: [
          "起票した Issue の一覧をセッションディレクトリの `issue-numbers.json` に保存する:",
          "",
          "```json",
          '[{ "number": 123, "title": "<タイトル>" }]',
          "```",
          "",
          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
          "```json",
          `{"key": "issue-numbers.json", "path": "${ctx.sessionDir}/issue-numbers.json"}`,
          "```",
        ],
        policy: [
          "- ユーザーが選択しなかった候補を起票しない",
          "- 本文に完了条件・方針・ミッションを含めない",
        ],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  // 統一最低ライン+ 副作用実照合: 起票一覧の申告と GitHub 実態を突き合わせる
  check: (ctx: CheckCtx): CheckResult => {
    const result = requireStepArtifacts(ctx, [
      { key: "issue-numbers.json", form: "json", minItems: 1, itemKeys: ["number", "title"] },
    ]);
    if (result.status !== "pass") return result;
    const raw = fs.readFileSync(join(ctx.sessionDir, "issue-numbers.json"), "utf-8");
    const created = JSON.parse(raw) as { number: unknown }[];
    const reasons: string[] = [];
    for (const entry of created) {
      reasons.push(...verifyIssueOpenLabeled(String(entry.number), "kind/plan"));
    }
    return reasons.length > 0
      ? { status: "fail", reasons }
      : { status: "pass", reasons: [`${created.length} issue(s) verified on GitHub`] };
  },
};
