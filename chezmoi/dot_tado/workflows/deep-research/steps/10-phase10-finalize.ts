import type { CheckCtx, CheckResult, PromptCtx } from "tado";
import type { TaskStepDef } from "tado/types/workflow-def.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStepPrompt } from "../../shared/prompt/build-step-prompt";
import { auditWriterReviewerCycle } from "../scripts/audit";
import { SCRIPTS_DIR } from "../helper/scripts-dir.ts";
import { openResearchDb } from "../helper/open-research-db.ts";
import { toCheckResult } from "../helper/to-check-result.ts";

// -----------------------------------------------------------------------
// Phase 10: 最終レポート確定
// -----------------------------------------------------------------------
export const phase10FinalizeStep: TaskStepDef = {
  key: "phase10-finalize",
  phase: "Phase 10: 最終レポート確定",
  type: "task",
  maxRetries: 3,
  onFail: { action: "escalate" },
  task: {
    action: "orchestrate",
    buildPrompt: (ctx: PromptCtx) => {
      const reportPath = join(ctx.sessionDir, "report.md");
      return buildStepPrompt({
        purpose: ["report.md を最終更新し、lint を実行してレポートを確定する。"],
        criteria: [
          "auditWriterReviewerCycle が pass かつ lint が pass かつ report に禁止コンテンツ（次のアクション/未解決の問い/中間まとめ/SearXNG 信頼性）がないこと",
        ],
        approach: [
          {
            title: "手順",
            content: [
              "1. `lint.ts` で report.md をフォーマット・lint する",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "lint.ts")} --file ${reportPath}`,
              "```",
              "",
              "2. 最終サイクル監査を実行する",
              "",
              "```bash",
              `bun run ${join(SCRIPTS_DIR, "audit.ts")} cycle --cycle writer-reviewer --db-path ${ctx.artifactDbPath} --report-path ${reportPath}`,
              "```",
              "",
              "3. lint エラーがある場合は Writer に明示的な修正を依頼（最大 3 回）",
              "4. レポートに未解決の問い・次のアクション・中間まとめ・SearXNG 信頼性注意書きが含まれていないか確認",
              "5. report.md 全文はセッションに出さない",
            ],
          },
        ],
        output: ["lint 済みの確定版 report.md。"],
        input: [
          `セッションディレクトリ: ${ctx.sessionDir}`,
          `research.db: ${ctx.artifactDbPath ?? "(none)"}`,
          `report.md: ${reportPath}`,
        ],
      });
    },
  },
  check: (ctx: CheckCtx): CheckResult => {
    if (!ctx.artifactDbPath) return { status: "error", reasons: ["No artifact DB path"] };
    const db = openResearchDb(ctx.artifactDbPath);
    try {
      const reportPath = join(ctx.sessionDir, "report.md");
      const checks = auditWriterReviewerCycle(db, reportPath);

      const lintResult = Bun.spawnSync(
        ["bun", "run", join(SCRIPTS_DIR, "lint.ts"), "--file", reportPath],
        { stdout: "pipe", stderr: "pipe", timeout: 60_000, maxBuffer: 1024 * 1024 },
      );
      const lintStderr = lintResult.stderr.toString().slice(0, 2000);
      checks.push({
        check_name: "lint_passed",
        status: lintResult.exitCode === 0 ? "pass" : "fail",
        detail: lintResult.exitCode === 0 ? "lint passed" : `lint failed:\n${lintStderr}`,
      });

      const content = existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null;
      if (content) {
        const forbiddenWords = ["次のアクション", "未解決の問い", "中間まとめ", "SearXNG 信頼性"];
        const found = forbiddenWords.filter((w) => content.includes(w));
        checks.push({
          check_name: "report_no_forbidden_content",
          status: found.length === 0 ? "pass" : "fail",
          detail: found.length === 0 ? "no forbidden content" : `found: ${found.join(", ")}`,
        });
      }

      return toCheckResult(checks);
    } finally {
      db.close();
    }
  },
};
