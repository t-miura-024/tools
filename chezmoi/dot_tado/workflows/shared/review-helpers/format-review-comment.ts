import type { Severity } from "./types.ts";
import { AXIS_EMOJI } from "./axis-emoji.ts";
import { neutralizeMarkdownLinkSyntax } from "./neutralize-markdown-link-syntax.ts";
import { sanitizeCodeSpanTarget } from "./sanitize-code-span-target.ts";
import { SEVERITY_EMOJI } from "./severity-emoji.ts";
import { TAXONOMY_EMOJI } from "./taxonomy-emoji.ts";

/// difit に注入する AI レビューコメント本文を GFM Markdown で生成する。
///
/// ヘッダ行の taxonomy 絵文字（`🐛 issue` / `🙋 question`）と severity（`💡 want`）は
/// `mt difit check` の taxonomy 分類（Rust 側 classify_body / is_want）が認識する契約。
/// 「対象 / 詳細 / 提案」を GFM の太字ラベルで構造化し、非対応環境でも素のテキストとして読める。
/// detail / suggestions は攻撃者由来の差分を引用し得るため生テキストとして
/// Markdown リンク・画像記法を無害化し（自動外部リクエストの防止）、対象行の filePath は
/// コードスパン内に収めてバックティック・改行だけを除く（リンク記法はスパン内で
/// 解釈されないため、エスケープするとパス表示が壊れる）。
export function formatReviewComment(input: {
  severity: Severity;
  axis: string;
  detail: string;
  filePath?: string;
  line?: number;
  suggestions?: string[];
}): { body: string } {
  const severityEmoji = SEVERITY_EMOJI[input.severity] ?? "";
  const taxonomy = input.severity === "must" ? "issue" : "question";
  const taxonomyEmoji = TAXONOMY_EMOJI[taxonomy] ?? "";
  const axisEmoji = AXIS_EMOJI[input.axis] ?? "🔍";
  const target = input.filePath
    ? input.line !== undefined
      ? `${input.filePath}:${input.line}`
      : input.filePath
    : "(ファイルレベル)";
  const lines = [
    `**${severityEmoji} ${input.severity} · ${taxonomyEmoji} ${taxonomy} · ${axisEmoji} ${input.axis}**`,
    "",
    `**対象**: ${input.filePath ? `\`${sanitizeCodeSpanTarget(target)}\`` : target}`,
    "",
    "**詳細**:",
    "",
    neutralizeMarkdownLinkSyntax(input.detail.trim()),
  ];
  if (input.suggestions && input.suggestions.length > 0) {
    lines.push("", "**提案**:", "");
    for (const suggestion of input.suggestions) {
      lines.push(`- ${neutralizeMarkdownLinkSyntax(suggestion.trim())}`);
    }
  }
  return { body: lines.join("\n") };
}
