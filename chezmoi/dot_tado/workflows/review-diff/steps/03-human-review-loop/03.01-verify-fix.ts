import type { ArtifactRecord, CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { validateVerifyFixJson } from "../../../shared/review-helpers/validate-verify-fix-json";
import { parseDiffChangedLines } from "../../../shared/review-helpers/parse-diff-changed-lines";
export const verifyFixStep: TaskStepDef = {
  key: "verify-fix",
  phase: "修正確認",
  type: "task",
  maxRetries: 1,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const historyPath = join(ctx.sessionDir, "review-history.jsonl");
      const verifyFixPath = join(ctx.sessionDir, "verify-fix.json");
      return [
        "## 目的",
        "",
        "前ラウンド指摘の修正有無と回帰テストの存在だけを確認する（分離ステップ）。全体の再反証は行わない（run-reviewers の責務）。",
        "",
        "## 手順",
        "",
        `1. ${historyPath} を読む。レビュー実施行が 0 行（初回）の場合は検証対象がないため ${verifyFixPath} に \`{"status":"initial"}\` と書く。`,
        "",
        "2. 1 行以上ある場合（差し戻し後の再入）は、前ラウンドからの修正を確認する:",
        "   - 最終行の `diffSha` と現在の diff.txt 全文の sha256 hex を比較する。最終行に `diffSha` がない場合は修正有無を判定できないため `unfixed` とする。",
        '   - 一致した場合は修正が行われていないため、理由（例: 差分が前ラウンドから変化していない）とともに `{"status":"unfixed","reason":"..."}` と書く。',
        '   - 変化している場合は、今回の修正に対応する回帰テストファイルを特定し、`{"status":"verified","diffChanged":true,"regressionTests":["<リポジトリ相対パス>",...]}` と書く。回帰テストは差分内に含まれるテストファイルに限定する（新規・変更のいずれも可）。該当がなければ `unfixed` とする。',
        "",
        "## 制約",
        "",
        "- 指摘内容の再反証・新規指摘の探索は行わない（run-reviewers の責務）",
        "- regressionTests への捏造・推測の記載は禁止。差分内に存在しないファイルを挙げない",
        "- workflow.db のループ制御に触れない",
        "",
        "## 成果物",
        "",
        "report 時の `artifacts` に以下を含める:",
        "```json",
        `[{"key":"verify-fix.json","path":"${verifyFixPath}"}]`,
        "```",
        "",
        "## セッション情報",
        "",
        `- セッションディレクトリ: ${ctx.sessionDir}`,
      ].join("\n");
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (ctx.attemptResult.status !== "completed") {
      return {
        status: "error",
        reasons: [ctx.attemptResult.errors ?? "verify-fix failed"],
      };
    }
    const raw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], "verify-fix.json", ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, "verify-fix.json");
    const result = validateVerifyFixJson(raw);
    if (!result.valid) {
      return { status: "error", reasons: [result.error ?? "verify-fix validation failed"] };
    }
    if (result.parsed!.status === "initial") {
      return { status: "pass", reasons: ["初回のため修正確認の対象なし"] };
    }
    if (result.parsed!.status === "unfixed") {
      return { status: "fail", reasons: [`修正未確認: ${result.parsed!.reason}`] };
    }
    // verified: 申告された回帰テストが現行 diff.txt のファイル一覧に含まれることを検証する
    const diffRaw =
      findArtifactText(ctx.artifacts as ArtifactRecord[], "diff.txt", ctx.sessionDir) ??
      readSessionFile(ctx.sessionDir, "diff.txt");
    if (diffRaw === undefined) {
      return { status: "fail", reasons: ["diff.txt not found"] };
    }
    const changedLinesMap = parseDiffChangedLines(diffRaw);
    const missing = result.parsed!.regressionTests.filter((test) => !changedLinesMap.has(test));
    if (missing.length > 0) {
      return {
        status: "fail",
        reasons: [
          `申告された回帰テストが差分内に存在しません: ${missing.join(", ")}。差分内のテストファイルを挙げてください`,
        ],
      };
    }
    return {
      status: "pass",
      reasons: [
        `修正確認: 差分変化あり・回帰テスト ${result.parsed!.regressionTests.length} 件（${result.parsed!.regressionTests.join(", ")})`,
      ],
    };
  },
};
