/// difit の解決済み commitish（full hash）から短縮表示を作る。
/// difit 本体（`dist/cli/utils.js` の `shortHash`）と同じく先頭 7 文字を使う
/// （`git rev-parse --short` は曖昧さ回避で 7 文字を超えることがあり一致しない）。
/// この写像は difit 配布物の shortHash に依存するため、expected-difit-selection.test.ts の
/// parity テスト（difit dist の shortHash との一致検証）で固定する。
export function hashPrefix(fullHash: string): string | undefined {
  const hash = fullHash.trim().split("\n").pop()?.trim() ?? "";
  return hash ? hash.slice(0, 7) : undefined;
}
