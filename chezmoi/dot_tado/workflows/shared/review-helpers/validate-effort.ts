import type { Depth, EffortValidation, Width } from "./types.ts";
import { isRecord } from "./is-record.ts";
import { REVIEW_ROUND_LIMIT } from "./review-round-limit.ts";
import { VALID_DEPTHS } from "./valid-depths.ts";
import { VALID_WIDTHS } from "./valid-widths.ts";
import { validateEffortBaseTarget } from "./validate-effort-base-target.ts";

export function validateEffort(
  parsed: unknown,
  options: { allowRoundOverflow?: boolean } = {},
): EffortValidation {
  if (!isRecord(parsed)) {
    return { status: "error", reasons: ["effort.json is not valid JSON"] };
  }
  const width = parsed.width;
  if (typeof width !== "string" || !VALID_WIDTHS.has(width)) {
    return {
      status: "fail",
      reasons: [`invalid width: ${String(width)}. expected one of ${[...VALID_WIDTHS].join(", ")}`],
    };
  }
  const depth = parsed.depth;
  if (typeof depth !== "string" || !VALID_DEPTHS.has(depth)) {
    return {
      status: "fail",
      reasons: [`invalid depth: ${String(depth)}. expected one of ${[...VALID_DEPTHS].join(", ")}`],
    };
  }
  const baseErr = validateEffortBaseTarget(parsed.base, parsed.target);
  if (baseErr) {
    return { status: "fail", reasons: [baseErr] };
  }
  const roundRaw = parsed.round;
  if (typeof roundRaw !== "number" || !Number.isInteger(roundRaw) || roundRaw < 1) {
    return {
      status: "fail",
      reasons: [
        `invalid round: ${String(roundRaw)}. round は 1 以上の整数で指定してください（未指定も不可。初回は 1）`,
      ],
    };
  }
  const round = roundRaw;
  const overflow = round > REVIEW_ROUND_LIMIT;
  if (overflow && !options.allowRoundOverflow) {
    return {
      status: "fail",
      reasons: [
        `round limit exceeded: round=${round} > ${REVIEW_ROUND_LIMIT}. 継続/中止を human_gate で選択してください`,
      ],
    };
  }
  return { status: "pass", width: width as Width, depth: depth as Depth, round, overflow };
}
