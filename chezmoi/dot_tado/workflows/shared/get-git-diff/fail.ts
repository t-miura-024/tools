export function fail(error: string): never {
  console.log(JSON.stringify({ ok: false, hasChanges: false, error }));
  process.exit(1);
}
