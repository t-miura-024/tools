/// コードスパン（`` `...` ``）内に埋め込む target（filePath / line）を無害化する。
///
/// filePath は差分（`+++ b/<path>` のパス）由来で攻撃者が用意し得る。バックティックは
/// コードスパンを閉じ、改行は後続行への任意 Markdown 注入を許すため、バックティックは
/// `'` へ置換し、改行は空白へ畳む。CommonMark のコードスパン内ではバックスラッシュ
/// エスケープが解釈されないため、`[` / `]` のエスケープは行わない（行うと
/// `src/app/[id]/page.tsx` が `src/app/\[id\]/page.tsx` として表示される）。
/// コードスパン外の生テキストには neutralizeMarkdownLinkSyntax を使う。
export function sanitizeCodeSpanTarget(target: string): string {
  return target.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
}
