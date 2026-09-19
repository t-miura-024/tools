// =============================================================================
// diff.txt パース — 追加行集合の抽出 (純粋関数) — D1/D2/D11 対応
// =============================================================================

/// git が C-quote したパス（`"b/..."` 形式）を生のリポジトリ相対パスへ逆写像する（純粋関数）。
///
/// `quoteGitPathForDiff` の逆変換。`"..."` の囲みを外し、`\t` `\n` `\r` `\"` `\\` と
/// git が非 ASCII バイトに使う 3 桁 octal escape をデコードする。引用符で囲まれていない
/// 入力はそのまま返す（壊れた入力も例外にせず原文を返し、無音落ちではなく
/// file_not_in_diff として扱えるようにする）。
export function unquoteGitPath(quoted: string): string {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const inner = quoted.slice(1, -1);
  const simpleEscapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    "\\": 0x5c,
  };
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "\\") {
      const rest = inner.slice(i + 1);
      const octal = /^([0-7]{3})/.exec(rest);
      if (octal) {
        bytes.push(Number.parseInt(octal[1], 8));
        i += 4;
        continue;
      }
      const escaped = simpleEscapes[rest[0] ?? ""];
      if (escaped !== undefined) {
        bytes.push(escaped);
        i += 2;
        continue;
      }
      // 未知の escape はバックスラッシュごと原文として保持する（例外にしない）
      bytes.push(0x5c);
      i += 1;
      continue;
    }
    const codePoint = inner.codePointAt(i)!;
    for (const byte of Buffer.from(String.fromCodePoint(codePoint), "utf8")) bytes.push(byte);
    i += codePoint > 0xffff ? 2 : 1;
  }
  return Buffer.from(bytes).toString("utf8");
}
