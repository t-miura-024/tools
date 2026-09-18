import type { CheckCtx, CheckResult, ConditionCtx, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { join } from "node:path";
import fs from "node:fs";
import { findArtifactText } from "tado/artifacts";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { requireStepArtifacts } from "../../shared/artifact-check/require-step-artifacts";

// -------------------------------------------------------------------
// Step 2.5: ドキュメント転記
// -------------------------------------------------------------------
export const transcribeDocsStep: TaskStepDef = {
  key: "transcribe-docs",
  phase: "ドキュメント転記",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  condition: (ctx: ConditionCtx): boolean => {
    const body = findArtifactText(ctx.artifacts, "issue-body.md", ctx.sessionDir);
    return body?.includes("## 📄 ドキュメント") ?? false;
  },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      return buildStepPrompt({
        purpose: [
          "計画 Issue の `## 📄 ドキュメント` セクションをリポジトリの実ファイルへ転記する。",
        ],
        criteria: [],
        approach: [
          {
            title: "1. ドキュメントセクションの抽出",
            content: [
              `セッションディレクトリの issue-body.md から \`## 📄 ドキュメント\` セクションを抽出する。`,
              "",
            ],
          },
          {
            title: "2. 各ブロックの書き出し",
            content: [
              "各 `### <リポジトリ相対パス>` 見出しと直下のコードフェンス（ファイル全文）を、指定パスへ書き出す。",
              "",
              "- ADR 連番が既存ファイルと衝突する場合は、次の空き番号へリネームして書き出す",
              "- 既存ファイル（主に `CONTEXT.md`）がある場合は既存内容を読み、計画側の内容を正としてマージする（`_Avoid_` ルールに従う）",
              "- 書き出しは未コミット差分として残す（コミットは行わない）",
              "",
            ],
          },
          {
            title: "3. 書き出し結果の報告",
            content: ["書き出したファイル一覧（パス・新規/更新・マージの有無）を報告する。", ""],
          },
        ],
        output: [
          "書き出したファイルの一覧をセッションディレクトリの `transcribed-docs.json` に保存する（パスはリポジトリルート相対）:",
          "",
          "```json",
          '[{ "path": "docs/adr/0002-xxx.md", "action": "new" | "update" | "merge" }]',
          "```",
          "",
          "report 時の `artifacts` に以下を含める（申告漏れは check で fail になる）:",
          "```json",
          `{"key": "transcribed-docs.json", "path": "${ctx.sessionDir}/transcribed-docs.json"}`,
          "```",
        ],
      });
    },
  },
  // 統一最低ライン: 転記一覧の申告・実在・スキーマ + 転記先ファイルの実在を強制
  check: (ctx: CheckCtx): CheckResult => {
    const result = requireStepArtifacts(ctx, [
      { key: "transcribed-docs.json", form: "json", minItems: 1, itemKeys: ["path", "action"] },
    ]);
    if (result.status !== "pass") return result;
    const raw = fs.readFileSync(join(ctx.sessionDir, "transcribed-docs.json"), "utf-8");
    const transcribed = JSON.parse(raw) as { path: unknown }[];
    const reasons: string[] = [];
    for (const entry of transcribed) {
      if (typeof entry.path !== "string" || !fs.existsSync(entry.path)) {
        reasons.push(`transcribed file does not exist: ${String(entry.path)}`);
      }
    }
    return reasons.length > 0
      ? { status: "fail", reasons }
      : { status: "pass", reasons: [`${transcribed.length} file(s) transcribed`] };
  },
};
