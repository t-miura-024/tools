import { isValidIssueNumber } from "./is-valid-issue-number";
import { invalidNumberReasons } from "./invalid-number-reasons";
import { fetchIssue } from "./fetch-issue";

/** Issue が存在し OPEN かつ指定 label を持つことの検証。 */
export function verifyIssueOpenLabeled(number: string, label: string): string[] {
  if (!isValidIssueNumber(number)) return invalidNumberReasons(number);
  try {
    const issue = fetchIssue(number);
    const reasons: string[] = [];
    if (issue.state !== "OPEN") {
      reasons.push(`gh: issue #${number} is not OPEN (state=${issue.state ?? "unknown"})`);
    }
    const names = (issue.labels ?? []).map((l) => l.name ?? "");
    if (!names.includes(label)) {
      reasons.push(`gh: issue #${number} is missing label "${label}"`);
    }
    return reasons;
  } catch (e) {
    return [`gh: failed to fetch issue #${number} (${String(e)})`];
  }
}
