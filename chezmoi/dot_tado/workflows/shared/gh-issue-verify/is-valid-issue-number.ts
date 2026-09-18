export function isValidIssueNumber(number: string): boolean {
  return /^[0-9]+$/.test(number);
}
