import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findArtifactText, readSessionFile } from "tado/artifacts";
import { reworkFeedbackSection } from "../../helper/rework-feedback-section.ts";

// -----------------------------------------------------------------
// Step 2: 本文マッピング（grill合意 → plan-format）
// -----------------------------------------------------------------
export const draftBodyStep: TaskStepDef = {
  key: "draft-body",
  phase: "本文マッピング",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const planFormatPath = join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "..",
        "..",
        "shared",
        "plan-plan-format.md",
      );

      return [
        "## 目的",
        "",
        "grillで合意した内容を plan-format にマッピングし、既存Issueを更新するための最終本文を確定する。",
        "",
        ...reworkFeedbackSection(ctx.gateAnswers, "confirm-update"),
        "## 手順",
        "",
        "### 1. 入力の読み込み",
        "",
        "セッションディレクトリの `analysis.md` を読み込む。",
        "`gh issue view <number> --json body,state,labels --jq .` で既存Issueの現行本文と状態も取得する（差分生成とガードのため）。",
        "",
        "### 2. 最終本文の確定",
        "",
        `plan-format.md（${planFormatPath}）に従い、Issue body の最終本文を確定する。`,
        "既存本文をベースに、grillで確定した変更を反映する。全面書き換えではなく、差分を最小にして更新する。",
        "必須セクション（`## 💭 背景` / `## ✅ 完了条件` / `## 📦 アウトプット` / `## 🧭 方針` / `## 🐿️ メモ` / `## 🔍 レビュー` / `## 🐢 履歴`）を維持する。",
        "`## 🧩 ミッション` が必要な場合はWave方式で定義する。`## 📄 ドキュメント` は該当する場合のみ。",
        "",
        "履歴の扱い:",
        "- 本文は最新計画で上書き更新する",
        "- 変更理由・前提の再検証メモは `## 🐿️ メモ` または `## 🐢 履歴` に軽量に追記する（重い専用セクションは設けない）",
        "- `## 🐢 履歴` には `- YYYY-MM-DD HH:mm [plan:update] <変更サマリ>` の形式でエントリを追記する（transition-plan.tsの形式に準拠）",
        "",
        "確定した本文をセッションディレクトリに `issue-body.md` として書き出す。",
        `既存本文との差分を \`${join(ctx.sessionDir, "body-diff.md")}\` にも書き出す（updateステップでの人間確認用）。差分行数と変更セクションを evidence にも記録する。`,
        "",
        "## 成果物",
        "",
        "report 時の `artifacts` に以下を含める:",
        "```json",
        `[{"key": "issue-body.md", "path": "${join(ctx.sessionDir, "issue-body.md")}"}, {"key": "body-diff.md", "path": "${join(ctx.sessionDir, "body-diff.md")}"}]`,
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
          reasons: [ctx.attemptResult.errors ?? "draft-body failed"],
        };
      }
      const body =
        readSessionFile(ctx.sessionDir, "issue-body.md") ??
        findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
      if (!body) return { status: "fail", reasons: ["issue-body.md not found"] };
      if (!body.includes("## ✅ 完了条件") || !body.includes("## 🧭 方針")) {
        return { status: "fail", reasons: ["issue-body.md: 必須セクション欠落"] };
      }
      const diff =
        readSessionFile(ctx.sessionDir, "body-diff.md") ??
        findArtifactText(ctx.artifacts, "body-diff.md", ctx.sessionDir);
      if (!diff) return { status: "fail", reasons: ["body-diff.md not found"] };
      return { status: "pass", reasons: ["draft-body artifacts verified"] };
    } catch (e) {
      return { status: "fail", reasons: [e instanceof Error ? e.message : String(e)] };
    }
  },
};
