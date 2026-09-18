import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isObjectRecord } from "../types.ts";
import { isEnoent } from "./is-enoent.ts";

interface PlanApprovalExhaustedMarker {
  loop: string;
  gate: string;
  iteration: number;
  input: string;
}

// 枯渇マーカーの厳密検証。request_changes の追加入力（input）を永続化し、
// 下流（枯渇ゲート・後続 step）へ伝達する。返値は valid マーカーか absent のみ。
// ファイル不在（ENOENT）のみ absent（null）。読み取り失敗・JSON 破損・
// 形状不一致（loop/gate/iteration/input のいずれか不一致・欠落）は throw し、
// condition ではエンジンエラー（fail-closed）、check では error/fail に倒す。
// iteration は 1-indexed（初期値 1。engine の session.ts / schema.ts default）。
// engine の枯渇判定は nextIteration > maxIterations（report.ts）であり、
// workflow の judge は iteration >= maxIterations で先回りして pass 抜けする。
// overshoot（iteration > max）でも valid として fail-closed にする。
export function readPlanApprovalExhaustedMarker(
  sessionDir: string,
): PlanApprovalExhaustedMarker | null {
  let raw: string;
  try {
    raw = readFileSync(join(sessionDir, "plan-approval-exhausted.json"), "utf-8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw new Error(
      `枯渇マーカーの読み取りに失敗しました (plan-approval-exhausted.json): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `枯渇マーカーが破損しています (plan-approval-exhausted.json): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObjectRecord(parsed)) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (plan-approval-exhausted.json): JSON オブジェクトが必要です`,
    );
  }
  if (parsed.loop !== "plan-approval-cycle") {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (plan-approval-exhausted.json): loop の一致が必要です（期待 plan-approval-cycle）`,
    );
  }
  if (parsed.gate !== "phase3b-plan-approval") {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (plan-approval-exhausted.json): gate の一致が必要です（期待 phase3b-plan-approval）`,
    );
  }
  const iterationValue = parsed.iteration;
  if (
    typeof iterationValue !== "number" ||
    !Number.isInteger(iterationValue) ||
    iterationValue < 3
  ) {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (plan-approval-exhausted.json): iteration は 3 以上の整数が必要です`,
    );
  }
  const inputValue = parsed.input;
  if (typeof inputValue !== "string" || inputValue.trim() === "") {
    throw new Error(
      `枯渇マーカーの検証に失敗しました (plan-approval-exhausted.json): input（request_changes 追加入力の永続化）が必要です`,
    );
  }
  return {
    loop: "plan-approval-cycle",
    gate: "phase3b-plan-approval",
    iteration: iterationValue,
    input: inputValue,
  };
}
