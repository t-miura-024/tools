export function describeFindingKey(key: string): string {
  return key
    .split("\u0000")
    .filter((part) => part.length > 0)
    .join(" ");
}
