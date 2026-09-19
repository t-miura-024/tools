import type { DiffNumstatEntry } from "./types.ts";
import { execGit } from "./exec-git.ts";
import { parseDiffNumstat } from "./parse-diff-numstat.ts";

/// 収集コマンドと同一の解決で `git diff --numstat -z` を実行する。
///
/// - target あり: `git diff --numstat "$base...$target"`（収集の
///   `git diff "$BASE...$TARGET"` と同一の merge-base..target 範囲）
/// - target なし: `git merge-base HEAD "$base"` を解決し、
///   `git diff --numstat <merge-base>`（収集の
///   `git diff "$(git merge-base HEAD "$BASE")"` と同一で committed + staged + unstaged を含む）
///
/// `-z` はパスを C-quote せず NUL 区切りの生パスで返すため、収集側の
/// `-c core.quotePath=false` とパス比較が直接成立する（quotePath 設定に依存しない）。
/// cwd は実行ディレクトリ（既定は process.cwd()。テストが実リポジトリを指定する）。
/// 失敗・契約外出力は空一覧へ縮退させず error を返し、呼び出し元が fail にできるようにする。
export function listDiffNumstat(
  scope: { base: string; target?: string },
  cwd?: string,
): { entries: DiffNumstatEntry[] } | { error: string } {
  try {
    let revision: string;
    if (scope.target) {
      revision = `${scope.base}...${scope.target}`;
    } else {
      const mergeBase = execGit(["merge-base", "HEAD", scope.base], { cwd }).trim();
      if (!mergeBase) {
        return {
          error: `git merge-base HEAD ${scope.base} が空の結果を返しました（base を解決できません）`,
        };
      }
      revision = mergeBase;
    }
    const entries = parseDiffNumstat(execGit(["diff", "--numstat", "-z", revision], { cwd }));
    if (!entries) {
      return {
        error:
          "git diff --numstat の出力が契約（-z の NUL 区切り `added\\tdeleted\\t<path>`）を満たしません",
      };
    }
    return { entries };
  } catch (error) {
    return { error: `git diff --numstat に失敗しました: ${String(error)}` };
  }
}
