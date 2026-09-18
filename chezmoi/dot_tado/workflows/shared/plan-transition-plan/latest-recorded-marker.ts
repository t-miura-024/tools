export function latestRecordedMarker(body: string): string | null {
  const match = body.match(/<!-- mt-run-plan-marker: ([a-f0-9-]+) -->/);
  return match ? match[1] : null;
}
