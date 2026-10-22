import type { CheckCtx, CheckResult } from "tado";
import { listReviewTargets } from "./list-review-targets.ts";
import { readPlanReviewFindings } from "./review-findings.ts";

/// 分解モードで子 body が存在するのに review-findings.json の reviewedTargets に
/// 含まれていない場合、子未レビューとして fail にする（fail-closed）。
/// 「対象外」一文や部分文字列の言及ではなく、レビュアーが実際に読んだ対象一覧を契約にする。
export function requireChildReviewIfChildrenExist(ctx: CheckCtx): CheckResult {
  const targetList = listReviewTargets(ctx.sessionDir);
  if (targetList.error) {
    return { status: "fail", reasons: [targetList.error] };
  }
  const children = targetList.targets.filter((target) => target !== "issue-body.md");
  if (children.length === 0) return { status: "pass", reasons: [] };

  const findings = readPlanReviewFindings(ctx.sessionDir, ctx.artifacts);
  const parsed = findings.parsed;
  if (!findings.valid || parsed === undefined) {
    return {
      status: "fail",
      reasons: [
        `review-findings.json を検証できないため子レビューを確認できません: ${findings.error ?? "invalid findings"}`,
      ],
    };
  }
  const missing = children.filter((child) => !parsed.reviewedTargets.includes(child));
  if (missing.length > 0) {
    return {
      status: "fail",
      reasons: [
        `review-findings.json: reviewedTargets に子 body（${missing.join(", ")}）が含まれていない（子レビュー未実施）`,
      ],
    };
  }
  return { status: "pass", reasons: [] };
}
