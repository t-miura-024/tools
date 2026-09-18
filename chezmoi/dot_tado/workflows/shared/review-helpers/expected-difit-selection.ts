import type { DifitSelectionView } from "./types.ts";
import { resolveGitMergeBasePrefix } from "./resolve-git-merge-base-prefix.ts";
import { resolveGitRevPrefix } from "./resolve-git-rev-prefix.ts";

/// effort.json の base/target から、`mt difit start` が提示すべき選択（state.selection の期待値）を
/// 解決する（git 実行を伴う）。
///
/// - target なし: `mt difit start <base>` → `. <base> --merge-base`。
///   選択は base=merge-base(H, HEAD)、target=`.`（ワーキングディレクトリ）。
///   これは collect_context の `git diff "$(git merge-base HEAD "$BASE")"`（committed +
///   staged + unstaged。difit の `.` 提示 = `git diff <merge-base>` と同じ範囲）と一致する。
/// - target あり: `mt difit start <target> <base> --merge-base` → 選択は
///   base=merge-base(target, base)、target=<target>。これは collect_context の
///   `git diff <base>...<target>` と同じ範囲（difit の第2引数が compare-with=base のため、
///   引数順は target が先）。
///
/// 検証は「提示範囲 = 検証対象範囲」というゲートの前提を機械的に固定する。
/// target を提示できない起動（単独 base の変換）をした場合、ここで不一致になる。
export function expectedDifitSelection(
  base: string,
  target?: string,
): { expected: DifitSelectionView } | { error: string } {
  if (target) {
    const expectedBase = resolveGitMergeBasePrefix(target, base);
    const expectedTarget = resolveGitRevPrefix(target);
    if (!expectedBase || !expectedTarget) {
      return {
        error: `difit の選択（base=${base}, target=${target}）を git で解決できませんでした。ref が存在するか確認してください`,
      };
    }
    return { expected: { base: expectedBase, target: expectedTarget, baseMode: "merge-base" } };
  }
  const expectedBase = resolveGitMergeBasePrefix("HEAD", base);
  if (!expectedBase) {
    return {
      error: `difit の選択（base=${base}）を git で解決できませんでした。ref が存在するか確認してください`,
    };
  }
  return { expected: { base: expectedBase, target: ".", baseMode: "merge-base" } };
}
