import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { findArtifactText, readSessionFile } from "tado/artifacts";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";
import { shellQuote } from "../../shared/review-helpers/shell-quote";
import { readRepoInfo } from "../helper/read-repo-info.ts";

// -----------------------------------------------------------------
// Step 3: Issue 更新（GitHub操作）
// -----------------------------------------------------------------
export const updateIssueStep: TaskStepDef = {
  key: "update-issue",
  phase: "Issue 更新",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const issueBodyQuoted = shellQuote(join(ctx.sessionDir, "issue-body.md"));
      const issueNumberQuoted = shellQuote(join(ctx.sessionDir, "issue-number.txt"));
      return [
        "## 目的",
        "",
        "draft-bodyで確定した本文で既存Plan Issueを更新し、変更サマリを残す。",
        "",
        "## 手順",
        "",
        "### 0. 事前ガード（req-2:315 — codeで検証、promptでは参考）",
        "",
        "更新前に既存Issueの状態を検証する（logic-2:457 — Issue番号は `^[0-9]+$` で検証し `shellQuote` してから `gh` に渡す）:",
        "```bash",
        `ISSUE_NUMBER=$(cat ${shellQuote(join(ctx.sessionDir, "issue-number.txt"))} | tr -d '[:space:]')`,
        'if ! echo "$ISSUE_NUMBER" | grep -qE "^[0-9]+$"; then echo "invalid issue number: $ISSUE_NUMBER" >&2; exit 1; fi',
        `gh issue view "$ISSUE_NUMBER" --json state,labels,body,number,title,url --jq '{state,labels,body}'`,
        "```",
        "- `state` が `CLOSED` なら abort",
        "- Project Status が `done` の Issue は更新せず abort",
        "- 分解済み親（Sub Issueを持つ）の場合は警告を提示し、子との整合性を確認してから進む",
        "- `external/<repo>` ラベルが付与された Issue は対象repoが正しいか確認",
        "（check でも同様の検証を code で行うため、ここでの失敗は check で fail として検出される）",
        "",
        "### 1. 入力の読み込み",
        "",
        "セッションディレクトリの `issue-body.md`、`body-diff.md`, `evidence.json` を読み込む。",
        "",
        "### 2. 楽観的ロック（logic-2:321 — codeでも検証）",
        "",
        "編集直前に現行本文のハッシュを取得し、edit前に再比較する（darwin 対応: sha256sum → shasum -a 256 フォールバック）:",
        "```bash",
        `SHA_CMD=$(command -v sha256sum >/dev/null 2>&1 && echo "sha256sum" || echo "shasum -a 256")`,
        `BEFORE_BODY=$(gh issue view "$ISSUE_NUMBER" --json body --jq .body | $SHA_CMD | cut -d' ' -f1)`,
        `DRAFT_BODY_HASH=$($SHA_CMD ${issueBodyQuoted} | cut -d' ' -f1)`,
        `CURRENT_BODY=$(gh issue view "$ISSUE_NUMBER" --json body --jq .body | $SHA_CMD | cut -d' ' -f1)`,
        'if [ "$BEFORE_BODY" != "$CURRENT_BODY" ]; then echo "競合検出: 他者がIssueを更新しました。中断して body-diff を再生成してください" >&2; exit 1; fi',
        "```",
        "不一致なら中断し、draft-body に戻って body-diff を再生成する。（check でも hash 比較を再検証する）",
        "",
        "### 3. Issue 本文の更新",
        "",
        "```bash",
        `gh issue edit "$ISSUE_NUMBER" --body-file ${issueBodyQuoted}`,
        "```",
        "失敗時はリトライ前に `gh issue view --json body` で本文が更新済みか確認し、冪等性を担保する。",
        "",
        "### 4. 変更サマリの投稿（秘密マスキング: ai-2:330 — codeでも再検証）",
        "",
        "投稿前に secret スキャンを実行し、トークン・APIキー・内部URLをマスキングしてから投稿する:",
        "```bash",
        `sed -E 's/(gh[pous]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[bpras]-[A-Za-z0-9-]+|npm_[A-Za-z0-9_]+|Bearer [A-Za-z0-9._-]+|-----BEGIN.*PRIVATE KEY-----)/***REDACTED***/g' ${shellQuote(join(ctx.sessionDir, "summary.md"))} > ${shellQuote(join(ctx.sessionDir, "summary.masked.md"))}`,
        `gh issue comment "$ISSUE_NUMBER" --body-file ${shellQuote(join(ctx.sessionDir, "summary.masked.md"))}`,
        "```",
        "投稿は最小権限トークンで実行し、内容は人間が承認した差分サマリのみとする。（check でマスキング漏れを再スキャンする）",
        "マスク済みサマリを `summary.masked.md` として保存したことを report 時の `artifacts` に含める（申告漏れは check で fail になる）:",
        "```json",
        `[{"key": "issue-number.txt", "path": "${join(ctx.sessionDir, "issue-number.txt")}"}, {"key": "summary.masked.md", "path": "${join(ctx.sessionDir, "summary.masked.md")}"}]`,
        "```",
        "",
        "### 5. ラベル付与",
        "",
        "`plan:update` ラベルが存在しなければ作成し、Issueに付与する:",
        "```bash",
        `gh label view "plan:update" --json name >/dev/null 2>&1 || gh label create "plan:update" --description "計画更新" --color "0e8a16"`,
        `gh issue edit "$ISSUE_NUMBER" --add-label "plan:update"`,
        "```",
        "失敗時は本文更新は成功しているため、ラベル付与のみリトライする。コメント重複投稿を避けるため、直前のコメント一覧を `gh issue view --json comments` で確認し、同一サマリが既に投稿済みならスキップする。",
        "既存の `kind/plan` ラベルは維持する。",
        "",
        "### 6. Issue番号の記録",
        "",
        "更新したIssue番号を `issue-number.txt` に記録する（reportで参照）。",
        "```bash",
        `echo "$ISSUE_NUMBER" > ${issueNumberQuoted}`,
        "```",
        "",
        "## 成果物",
        "",
        "report 時の `artifacts` に以下を含める:",
        "```json",
        `{"key": "issue-number.txt", "path": "${join(ctx.sessionDir, "issue-number.txt")}"}`,
        "```",
        "",
        "## セッション情報",
        "",
        `- セッションディレクトリ: ${ctx.sessionDir}`,
      ].join("\n");
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    try {
      if (ctx.attemptResult.status !== "completed") {
        return {
          status: "error",
          reasons: [ctx.attemptResult.errors ?? "update-issue failed"],
        };
      }
      const issueNumber =
        readSessionFile(ctx.sessionDir, "issue-number.txt") ??
        findArtifactText(ctx.artifacts, "issue-number.txt", ctx.sessionDir);
      if (!issueNumber) return { status: "fail", reasons: ["issue-number.txt not found"] };
      const trimmedNumber = issueNumber.trim();
      if (!/^[0-9]+$/.test(trimmedNumber)) {
        return { status: "fail", reasons: [`invalid issue number: ${trimmedNumber}`] };
      }
      const body =
        readSessionFile(ctx.sessionDir, "issue-body.md") ??
        findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
      if (!body) return { status: "fail", reasons: ["issue-body.md not verified"] };
      // 統一最低ライン: マスク済みサマリの申告・実在を強制
      const maskedCheck = requireStepArtifacts(ctx, [
        { key: "summary.masked.md", form: "markdown" },
      ]);
      if (maskedCheck.status !== "pass") return maskedCheck;
      // 追加: 事前ガードの code 検証（req-2:315, logic-2:321, req-2:596）
      try {
        const repoInfo = readRepoInfo(ctx.artifacts, ctx.sessionDir);
        if (!repoInfo.owner || !repoInfo.repo)
          return { status: "fail", reasons: ["repo-info.json invalid"] };
      } catch (e) {
        return { status: "fail", reasons: [`repo-info check failed: ${String(e)}`] };
      }
      // 事前ガード: gh で state 取得を試み、CLOSED は fail（code配線、promptは参考）
      try {
        const stateOut = execSync(
          `gh issue view ${shellQuote(trimmedNumber)} --json state --jq .state`,
          { encoding: "utf-8" },
        ).trim();
        if (stateOut === "CLOSED")
          return { status: "fail", reasons: ["issue is CLOSED — reopen required"] };
      } catch (e) {
        return {
          status: "error",
          reasons: [
            `gh issue state verification failed: ${e instanceof Error ? e.message : String(e)}`,
          ],
        };
      }
      // 秘密マスキング漏れの簡易スキャン（ai-2:330, logic-2:432 — promptと同一パターンに統一、Bearer/PrivateKey追加）
      const secretPattern =
        /(gh[pous]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|xox[bpras]-[A-Za-z0-9-]+|npm_[A-Za-z0-9_]+|Bearer [A-Za-z0-9._-]+|-----BEGIN.*PRIVATE KEY-----)/;
      const bodiesToScan = [body];
      const bodyDiff = readSessionFile(ctx.sessionDir, "body-diff.md");
      if (bodyDiff) bodiesToScan.push(bodyDiff);
      const summaryMasked = readSessionFile(ctx.sessionDir, "summary.masked.md");
      if (summaryMasked) bodiesToScan.push(summaryMasked);
      for (const b of bodiesToScan) {
        if (secretPattern.test(b)) {
          return { status: "fail", reasons: ["potential secret detected — masking required"] };
        }
      }
      // 楽観的ロックの code 検証（logic-2:536, req-2:596）— 現行 body と draft の hash 比較を試みる
      try {
        const currentBodyRaw = execSync(
          `gh issue view ${shellQuote(trimmedNumber)} --json body --jq .body`,
          { encoding: "utf-8" },
        );
        const currentHash = createHash("sha256").update(currentBodyRaw).digest("hex");
        const draftHash = createHash("sha256").update(body).digest("hex");
        if (currentHash === draftHash) {
          return {
            status: "fail",
            reasons: ["issue body is already up to date — no update needed"],
          };
        }
      } catch (e) {
        return {
          status: "error",
          reasons: [
            `issue body hash verification failed: ${e instanceof Error ? e.message : String(e)}`,
          ],
        };
      }
      return { status: "pass", reasons: [`updated issue ${trimmedNumber}`] };
    } catch (e) {
      return { status: "fail", reasons: [e instanceof Error ? e.message : String(e)] };
    }
  },
};
