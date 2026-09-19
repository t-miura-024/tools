import { diffContainsPath } from "./diff-contains-path.ts";
import { indexDiffText } from "./index-diff-text.ts";

/// staged（index 上）のパス一覧が diff.txt に現れることを検証する理由を返す（純粋関数）。
///
/// staged 変更は working diff ではコミット済み変更と同じ 1 ファイルブロックに畳まれるため、
/// ファイル見出し（diffContainsPath）の一致で判定する。空配列なら欠落なし。
export function missingStagedFilesReasons(
  diffRaw: string,
  stagedFiles: readonly string[],
): string[] {
  const index = indexDiffText(diffRaw);
  const missing = stagedFiles.filter((filePath) => !diffContainsPath(index, filePath));
  if (missing.length === 0) return [];
  return [
    `diff.txt に staged（index 上）の変更が ${missing.length} 件欠落しています: ${missing.join(", ")}。収集は merge-base..ワーキングツリー（committed + staged + unstaged）で行い、staged 変更（staged された新規ファイルを含む）を diff.txt から落とさないでください`,
  ];
}
