import type { CheckCtx } from "tado";
import { resolveEffortScope } from "./resolve-effort-scope.ts";
/// effort.json の target を解決する（target ありセッションの収集範囲判定に使う）。
/// effort.json が無い・target が空の場合は undefined（target なし = working diff + untracked 経路）。
export function resolveEffortTarget(ctx: CheckCtx): string | undefined {
  return resolveEffortScope(ctx).target;
}
