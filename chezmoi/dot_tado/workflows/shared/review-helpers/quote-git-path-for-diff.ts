/// git が `git diff` のヘッダでパスを C-quote する形を再現する（純粋関数）。
///
/// git は `core.quotePath` の既定で非 ASCII バイト・制御文字・`"`・`\` を含むパスを
/// `"..."` + octal escape へ変換する（空白は変換しない）。差分テキストから
/// untracked ファイルの出現を照合するには、同じ写像で候補行を生成する必要がある。
/// 変換不要なパスは入力と同じ文字列を返す。
export function quoteGitPathForDiff(path: string): string {
  const bytes = [...Buffer.from(path, "utf8")];
  const needsQuote = bytes.some(
    (byte) => byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x80,
  );
  if (!needsQuote) return path;
  let quoted = "";
  for (const byte of bytes) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += "\\\\";
    else if (byte === 0x09) quoted += "\\t";
    else if (byte === 0x0a) quoted += "\\n";
    else if (byte === 0x0d) quoted += "\\r";
    else if (byte < 0x20 || byte >= 0x80) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }
  return quoted;
}
