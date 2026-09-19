import { execGit } from "./exec-git.ts";

/// `git status --porcelain -z` を実行し、index（staged）に載っているパス一覧を返す。
///
/// collect_context の収集コマンド（working diff）と同じ index を参照し、staged 変更
/// （staged された新規ファイル・削除を含む）が diff.txt から欠落していないかを突合する
/// 期待値を機械導出する（-z は NUL 区切りの生パス）。未追跡（`??`）・無視（`!!`）・
/// worktree のみの変更（index 列が空白）は staged ではなく収集範囲の突合対象外なので
/// 含めない。リネーム / コピーは新しいパスを 1 件として返し、元パスのトークンは読み飛ばす。
/// 実行失敗は空一覧へ縮退させず理由付きで返し、呼び出し元が fail にできるようにする。
export function listStagedFiles(cwd?: string): { files: string[] } | { error: string } {
  try {
    const tokens = execGit(["status", "--porcelain", "-z"], { cwd }).split("\0");
    const files: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      index += 1;
      if (!token) continue;
      const staged = token[0];
      const worktree = token[1];
      const filePath = token.slice(3);
      if (staged === "R" || staged === "C" || worktree === "R" || worktree === "C") {
        // リネーム / コピーは `XY <new>\0<orig>\0` の 2 トークン（元パスを読み飛ばす）
        index += 1;
      }
      if (staged === " " || staged === "?" || staged === "!") continue;
      files.push(filePath);
    }
    return { files };
  } catch (error) {
    return {
      error: `git status --porcelain に失敗しました: ${String(error)}`,
    };
  }
}
