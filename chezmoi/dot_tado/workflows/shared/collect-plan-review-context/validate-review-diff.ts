import { diffCompletenessReasons } from "../review-helpers/diff-completeness-reasons";
import { diffNumstatReasons } from "../review-helpers/diff-numstat-reasons";
import { listDiffNumstat } from "../review-helpers/list-diff-numstat";
import { listStagedFiles } from "../review-helpers/list-staged-files";
import { listUntrackedFiles } from "../review-helpers/list-untracked-files";
import { missingStagedFilesReasons } from "../review-helpers/missing-staged-files-reasons";

/** 旧 collect_context check と同じ完全性検証。report の擬似生成は行わない。 */
export function validateReviewDiff(diff: string, scope: { base: string; target?: string }): void {
  const untracked = scope.target ? { files: [] } : listUntrackedFiles();
  if ("error" in untracked) throw new Error(untracked.error);
  const staged = scope.target ? { files: [] } : listStagedFiles();
  if ("error" in staged) throw new Error(staged.error);
  const numstat = listDiffNumstat(scope);
  if ("error" in numstat) throw new Error(numstat.error);
  const reasons = [
    ...diffCompletenessReasons(diff, untracked.files),
    ...missingStagedFilesReasons(diff, staged.files),
    ...diffNumstatReasons(diff, numstat.entries),
  ];
  if (reasons.length) throw new Error(reasons.join("\n"));
}
