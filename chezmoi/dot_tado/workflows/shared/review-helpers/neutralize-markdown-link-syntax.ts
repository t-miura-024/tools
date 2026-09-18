/// GFM のリンク・画像記法を無効化する。`[` / `]` をバックスラッシュでエスケープし、
/// `![alt](url)` や `[text](url)` をリテラル文字列として描画させる。`\` を先に
/// エスケープすることで、元テキストの `\[` が二重エスケープで崩れない。
/// コードスパン（`` `...` ``）内は Markdown 記法が解釈されないため対象外とし、
/// `threads[]` のようなコード片の表示を変えない。
///
/// detail / suggestions は差分（攻撃者が用意し得る）を引用するため、difit UI
/// （react-markdown + remark-gfm）が画像記法として解釈すると、人間がレビューを
/// 開いた時点で外部 URL へ自動リクエストが飛ぶ。リンク記法も同様に無効化する。
export function neutralizeMarkdownLinkSyntax(text: string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map((part) =>
      part.length >= 2 && part.startsWith("`") && part.endsWith("`")
        ? part
        : part.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]"),
    )
    .join("");
}
