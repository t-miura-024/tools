import type { ArtifactRecord, CheckCtx } from "tado";
import { findArtifactText } from "tado/artifacts";
import { readSessionFile } from "tado/artifacts";
import { parseJson } from "../../shared/review-helpers/parse-json";
import { isRecord } from "../../shared/review-helpers/is-record";
import { resolveEffectiveEffortBase } from "../../shared/review-helpers/resolve-effective-effort-base";
import { EFFORT_KEY } from "../../shared/review-helpers/effort-key";
/// effort.json の収集スコープ（base / target）を解決する（収集範囲と numstat 突合に使う）。
/// base 未指定は collect-context の収集コマンドと同じく resolveEffectiveEffortBase
/// （origin/HEAD → main）で解決する。effort.json が無い・target が空の場合は target なし
/// （working diff + untracked 経路）。
export function resolveEffortScope(ctx: CheckCtx): { base: string; target?: string } {
  const effortRaw =
    findArtifactText(ctx.artifacts as ArtifactRecord[], EFFORT_KEY, ctx.sessionDir) ??
    readSessionFile(ctx.sessionDir, EFFORT_KEY);
  const effort = parseJson(effortRaw ?? "");
  const target =
    isRecord(effort) && typeof effort.target === "string" && effort.target.trim()
      ? effort.target.trim()
      : undefined;
  return {
    base: resolveEffectiveEffortBase(isRecord(effort) ? effort.base : undefined),
    ...(target ? { target } : {}),
  };
}
