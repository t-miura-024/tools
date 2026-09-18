import { isValidIssueNumber } from "./is-valid-issue-number";
import { invalidNumberReasons } from "./invalid-number-reasons";
import { fetchIssue } from "./fetch-issue";

/** Issue が存在し state が OPEN であることの検証。違反理由の配列（空なら合格）。 */
export function verifyIssueOpen(number: string): string[] {
  if (!isValidIssueNumber(number)) return invalidNumberReasons(number);
  try {
    const issue = fetchIssue(number);
    if (issue.state !== "OPEN") {
      return [`gh: issue #${number} is not OPEN (state=${issue.state ?? "unknown"})`];
    }
    return [];
  } catch (e) {
    return [`gh: failed to fetch issue #${number} (${String(e)})`];
  }
}
