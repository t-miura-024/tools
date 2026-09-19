import { execGit } from "./exec-git.ts";

/// `git ls-files --others --exclude-standard -z` を実行して untracked 一覧を返す。
///
/// collect_context の収集コマンドと同じ cwd・同じオプションで列挙し、diff.txt に
/// 現れるべき untracked パス集合の期待値を機械導出する（-z は NUL 区切りの生パス）。
/// 実行失敗は空一覧へ縮退させず理由付きで返し、呼び出し元が fail にできるようにする。
export function listUntrackedFiles(cwd?: string): { files: string[] } | { error: string } {
  try {
    return {
      files: execGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd })
        .split("\0")
        .filter((file) => file.length > 0),
    };
  } catch (error) {
    return {
      error: `git ls-files --others --exclude-standard に失敗しました: ${String(error)}`,
    };
  }
}
