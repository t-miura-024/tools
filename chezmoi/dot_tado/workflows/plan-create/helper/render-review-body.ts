import type { PlanReviewFinding, PlanReviewFindings, Severity } from "./review-findings.ts";
import { PERSPECTIVE_LABELS } from "./review-findings.ts";

const SEVERITY_EMOJI: Record<Severity, string> = {
  must: "🚨",
  should: "⚠️",
  want: "💡",
};

/// review-findings.json から review-body.md を決定論的に生成する。
/// LLM に Markdown を書かせず、レビュー記録の形式を固定する。
export function renderReviewBody(findings: PlanReviewFindings): string {
  const { must, should, want } = findings.counts;
  const judgment =
    must > 0
      ? "must の解消が必要"
      : should > 0
        ? "must はゼロ。should の確認が必要"
        : want > 0
          ? "must/should はゼロ。want のみ"
          : "指摘なし";

  const lines: string[] = [
    "## レビュー結果",
    "",
    `概要（指摘件数: must ${must} / should ${should} / want ${want}、総合判断: ${judgment}）`,
    "",
    "## 指摘一覧",
    "",
  ];

  if (findings.findings.length === 0) {
    lines.push("指摘なし");
  } else {
    for (const finding of findings.findings) {
      lines.push(...renderFinding(finding));
    }
  }

  lines.push("## レビュー対象", "");
  for (const target of findings.reviewedTargets) {
    lines.push(`- ${target}`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderFinding(finding: PlanReviewFinding): string[] {
  const lines: string[] = [
    `### ${finding.id}: ${firstLine(finding.problem)}`,
    "",
    "| 項目 | 内容 |",
    "|------|------|",
    `| 優先度 | ${SEVERITY_EMOJI[finding.severity]} ${finding.severity} |`,
    `| 観点 | ${finding.perspective}: ${PERSPECTIVE_LABELS[finding.perspective]} |`,
    `| 種別 | ${finding.type} |`,
    `| 対象 | ${escapeTableCell(finding.target)} |`,
    "",
    finding.problem,
    "",
    `**根拠:** ${finding.evidence}`,
    "",
  ];
  if (finding.proposedFix) {
    lines.push(`**修正案:** ${finding.proposedFix}`, "");
  }
  if (finding.proposedQuestion) {
    lines.push(`**確認すべき質問:** ${finding.proposedQuestion}`, "");
  }
  if (finding.proposedOptions.length > 0) {
    lines.push(`**選択肢候補:** ${finding.proposedOptions.join(" / ")}`, "");
  }
  return lines;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
