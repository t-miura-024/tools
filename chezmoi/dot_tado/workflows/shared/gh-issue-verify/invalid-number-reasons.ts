export function invalidNumberReasons(number: string): string[] {
  return [`invalid issue number: ${number} (expected ^[0-9]+$)`];
}
