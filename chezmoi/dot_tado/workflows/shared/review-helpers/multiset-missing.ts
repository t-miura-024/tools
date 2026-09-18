export function multisetMissing(expected: string[], actual: string[]): string[] {
  const counts = new Map<string, number>();
  for (const key of actual) counts.set(key, (counts.get(key) ?? 0) + 1);
  const missing: string[] = [];
  for (const key of expected) {
    const count = counts.get(key) ?? 0;
    if (count <= 0) {
      missing.push(key);
    } else {
      counts.set(key, count - 1);
    }
  }
  return missing;
}
