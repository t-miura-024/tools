import type { ArtifactExpectation } from "./types";

/** markdown 形式の中身検証。違反理由の配列を返す（空なら合格）。 */
export function validateMarkdownContent(
  content: string,
  expectation: ArtifactExpectation,
): string[] {
  const reasons: string[] = [];
  for (const section of expectation.sections ?? []) {
    // 見出しレベルは問わず、見出しテキストの一致のみを検証する
    const title = section.replace(/^#+\s*/, "");
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const heading = new RegExp(`^#{1,6}\\s*${escaped}\\s*$`, "m");
    if (!heading.test(content)) {
      reasons.push(`${expectation.key}: missing required section: ${section}`);
    }
  }
  return reasons;
}
