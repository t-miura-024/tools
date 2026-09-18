export interface GhIssueSnapshot {
  state?: string;
  labels?: { name?: string }[];
  body?: string;
}
