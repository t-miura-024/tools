export function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}
