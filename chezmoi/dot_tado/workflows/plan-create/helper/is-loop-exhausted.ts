import { join } from "node:path";
import { readFileSync } from "node:fs";
import { isRecord } from "../../shared/review-helpers/is-record";

// 枯渇マーカーの厳密検証。返値は valid マーカーのみ（absent は false）。
// ファイル不在（ENOENT）のみ absent として返す。読み取り失敗・JSON 破損・
// 形状不一致（loop/gate/iteration のいずれか不一致）は throw し、呼び出し元の
// condition ではエンジンエラー（fail-closed）、check では fail/error に倒す。
// fail-open の false 返しはしない。
// iteration は 1-indexed（初期値 1。engine の session.ts / schema.ts default）。
// engine の枯渇判定は nextIteration > maxIterations（report.ts）であり、
// workflow の judge は iteration >= maxIterations で先回りして pass 抜けする。
// overshoot（iteration > max）でも valid として fail-closed にする。
export function isLoopExhausted(
  sessionDir: string,
  markerKey: string,
  loopKey: string,
  gateKey: string,
  maxIterations: number,
): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, markerKey), "utf-8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw new Error(
      `枯渇マーカーの読み取りに失敗しました (${markerKey}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `枯渇マーカーが破損しています (${markerKey}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`枯渇マーカーの検証に失敗しました (${markerKey}): JSON オブジェクトが必要です`);
  }
  if (parsed.loop !== loopKey) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${markerKey}): loop の一致が必要です（期待 ${loopKey}）`,
    );
  }
  if (parsed.gate !== gateKey) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${markerKey}): gate の一致が必要です（期待 ${gateKey}）`,
    );
  }
  const iterationValue = parsed.iteration;
  if (
    typeof iterationValue !== "number" ||
    !Number.isInteger(iterationValue) ||
    iterationValue < maxIterations
  ) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (${markerKey}): iteration は ${maxIterations} 以上の整数が必要です`,
    );
  }
  return true;
}
