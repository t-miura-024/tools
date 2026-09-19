import type { ArtifactRecord, CheckCtx } from "tado";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { parseJson } from "../../shared/review-helpers/parse-json";
import { isRecord } from "../../shared/review-helpers/is-record";
import { EFFORT_KEY } from "../../shared/review-helpers/effort-key";
import { DIFIT_RECOVERY_BASE_COMMAND } from "./difit-recovery-base-command.ts";
import { DIFIT_RECOVERY_TARGET_COMMAND } from "./difit-recovery-target-command.ts";
/// fail reasons に埋め込む復旧コマンドを effort.json の base/target から解決する。
/// target ありでは base 単独起動（別選択になる）を案内しない。base を解決できない
/// 場合はプレースホルダ表記にフォールバックする（案内を欠落させない）。
export function describeRecoveryCommand(ctx: CheckCtx): string {
  const effortRaw =
    findArtifactText(ctx.artifacts as ArtifactRecord[], EFFORT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, EFFORT_KEY);
  const effort = parseJson(effortRaw);
  const target =
    isRecord(effort) && typeof effort.target === "string" && effort.target.trim()
      ? effort.target.trim()
      : undefined;
  const base =
    isRecord(effort) && typeof effort.base === "string" && effort.base.trim()
      ? effort.base.trim()
      : undefined;
  if (target) {
    return base
      ? `mt difit start "${target}" "${base}" --merge-base`
      : DIFIT_RECOVERY_TARGET_COMMAND;
  }
  return base ? `mt difit start "${base}"` : DIFIT_RECOVERY_BASE_COMMAND;
}
