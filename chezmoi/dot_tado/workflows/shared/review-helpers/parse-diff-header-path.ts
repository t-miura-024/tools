import { unquoteGitPath } from "./unquote-git-path.ts";

/// `--- ` / `+++ ` 行のパス部をリポジトリ相対の生パスへ正規化する（純粋関数）。
///
/// - `a/<path>` / `b/<path>` / `"a/<path>"` / `"b/<path>"` → `<path>`
///   （C-quote は unquoteGitPath で逆写像。`a/` / `b/` は先頭 1 つだけ外す）
/// - `/dev/null` / `a/dev/null` / `b/dev/null` → null（削除ファイルの new 側など）
/// - 空白を含むパスには git が末尾タブを付けるため、引用形・非引用形とも末尾タブを除去する
///   （`+++ "b/my \"file\".txt"<TAB>` の形がある）
export function parseDiffHeaderPath(rawPath: string): string | null {
  let path = rawPath.replace(/\t+$/, "");
  if (path.startsWith('"')) {
    const closing = path.lastIndexOf('"');
    if (closing > 0) path = unquoteGitPath(path.slice(0, closing + 1));
  }
  if (path === "/dev/null" || path === "a/dev/null" || path === "b/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  if (!path || path === "/dev/null") return null;
  return path;
}
