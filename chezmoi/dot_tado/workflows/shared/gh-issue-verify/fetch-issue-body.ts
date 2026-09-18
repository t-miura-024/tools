import { fetchIssue } from "./fetch-issue";

/** Issue body の本文照合用（例: `## 🐢 履歴` の遷移エントリ確認）。 */
export function fetchIssueBody(number: string): string {
  const issue = fetchIssue(number);
  return issue.body ?? "";
}
