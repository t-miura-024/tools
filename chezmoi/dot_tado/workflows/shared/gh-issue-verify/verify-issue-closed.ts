import { isValidIssueNumber } from "./is-valid-issue-number";
import { invalidNumberReasons } from "./invalid-number-reasons";
import { fetchIssue } from "./fetch-issue";

/** Issue が存在し state が CLOSED であることの検証（done 遷移の実照合）。 */
export function verifyIssueClosed(number: string): string[] {
  if (!isValidIssueNumber(number)) return invalidNumberReasons(number);
  try {
    const issue = fetchIssue(number);
    if (issue.state !== "CLOSED") {
      return [`gh: issue #${number} is not CLOSED (state=${issue.state ?? "unknown"})`];
    }
    return [];
  } catch (e) {
    return [`gh: failed to fetch issue #${number} (${String(e)})`];
  }
}
