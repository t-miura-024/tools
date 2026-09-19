import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { findArtifactText } from "tado/artifacts";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";
import { fetchIssueBody } from "../../shared/gh-issue-verify/fetch-issue-body";

const ISSUE_NUMBER_KEY = "issue-number.txt";
const EFFORT_PATTERN =
  /<!--\s*effort:\s*width=(low|medium|high|xhigh|max)\s+depth=(low|medium|high|xhigh|max)\s*-->/;

// -----------------------------------------------------------------
// Step 7: 完了処理（報告のみ）
// -----------------------------------------------------------------
export const finalizeStep: TaskStepDef = {
  key: "finalize",
  phase: "完了処理",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "作成した Refined Issue の内容を報告する。GitHub への変更は行わない（作成・refined 化は create-refined が完了済み）。",
          "create-refined が Project 追加・refined 遷移で部分失敗した場合は本ステップから再開せず、issue-number.txt を起点に create-refined を再実行してから報告する。",
        ],
        criteria: [
          "Issue URL・番号・対象 repo・Project・Status（refined）・label と `plan-run` 実行可能案内が報告されている",
        ],
        approach: [
          {
            title: "1. Issue 番号の確認",
            content: [
              `セッションディレクトリの issue-number.txt から Issue 番号を読み取る。読み取る前に \`grep -Eq '^[0-9]+$'\` で検証し、不正なら GitHub操作へ進まず escalate する（失敗報告のみ）。`,
            ],
          },
          {
            title: "2. 作成内容の報告",
            content: [
              "以下を報告する:",
              "- Issue URL・番号",
              "- 対象 repo",
              "- Project・Status（refined であること）",
              "- label",
              "- `plan-run` で実行可能であることを案内",
            ],
          },
        ],
        output: [],
        input: [`セッションディレクトリ: ${ctx.sessionDir}`],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    const result = requireStepArtifacts(ctx, [
      { key: ISSUE_NUMBER_KEY, form: "text", pattern: /^[0-9]+$/ },
    ]);
    if (result.status !== "pass") return result;
    // 副作用実照合: refined 昇格の痕跡（履歴エントリ + effort コメント）を GitHub 上で確認
    const raw = findArtifactText(ctx.artifacts, ISSUE_NUMBER_KEY, ctx.sessionDir);
    const number = (raw ?? "").trim();
    let body: string;
    try {
      body = fetchIssueBody(number);
    } catch (e) {
      return {
        status: "fail",
        reasons: [`gh: failed to fetch issue #${number} (${String(e)})`],
      };
    }
    const reasons: string[] = [];
    if (!/\[[^\]]*refined[^\]]*\]/.test(body)) {
      reasons.push(`issue #${number}: refined 昇格の履歴エントリが見つからない`);
    }
    if (!EFFORT_PATTERN.test(body)) {
      reasons.push(`issue #${number}: effort コメントが確定していない`);
    }
    return reasons.length > 0
      ? { status: "fail", reasons }
      : { status: "pass", reasons: [`issue #${number} promoted to refined`] };
  },
};
