import type {
  FilteredOutItem,
  Finding,
  FindingsJson,
  FindingsNormalizationAudit,
} from "./types.ts";
import { describeFindingKey } from "./describe-finding-key.ts";
import { diffCompletenessReasons } from "./diff-completeness-reasons.ts";
import { filterFindingsByDiff } from "./filter-findings-by-diff.ts";
import { isRecord } from "./is-record.ts";
import { mergeFindingsByProximity } from "./merge-findings-by-proximity.ts";
import { multisetMissing } from "./multiset-missing.ts";
import { parseDiffChangedLines } from "./parse-diff-changed-lines.ts";
import { VALID_AXIS_IDS } from "./valid-axis-ids.ts";
import { VALID_FILTERED_OUT_REASONS } from "./valid-filtered-out-reasons.ts";

/// 生 findings（reviewer-outputs.json の配列）が findings.json へ正規化された結果を
/// 機械照合する（純粋関数）。正規化で生 findings を落としてよい経路は次の 3 つに限られる:
///
///   1. axis / severity / detail の不正による除外（生側で判定。filteredOut には記録されない）
///   2. diff フィルタによる除外（filterFindingsByDiff が filteredOut に記録する）
///   3. ±2 行マージによる統合（mergeFindingsByProximity が複数件を 1 件にまとめる）
///
/// 期待される findings / filteredOut を同じ純粋関数で再導出し、(axis, severity, filePath, line)
/// の multiset と filteredOut キーの multiset を突合する。集約段で must / should が
/// 黙って落ちた場合、findings.json の counts が自己整合していてもここで欠落として検出する。
/// diff.txt が無い場合は diff フィルタを検証できないため fail にする。
///
/// options.changedLinesMap に呼び出し元が parseDiffChangedLines で構築済みの Map を渡すと、
/// 大規模 diff.txt の二重パースを避けられる（省略時は従来どおり内部でパースする）。
/// options.untrackedFiles は `git ls-files --others --exclude-standard` の一覧（必須）。
/// diff.txt の完全性（truncate マーカー・untracked 欠落）を照合し、打ち切られた差分を
/// SoT として通過させない（欠落ファイル上の must 指摘が file_not_in_diff へ落ちても検出する）。
export function auditFindingsNormalization(
  rawFindings: unknown,
  diffRaw: string | undefined,
  findings: FindingsJson,
  options: {
    changedLinesMap?: Map<string, Set<number>>;
    untrackedFiles: readonly string[];
  },
): FindingsNormalizationAudit {
  if (!Array.isArray(rawFindings)) {
    return { match: false, reasons: ["reviewer-outputs.json must be a JSON array"] };
  }
  if (diffRaw === undefined) {
    return { match: false, reasons: ["diff.txt not found — diff フィルタの機械照合ができません"] };
  }

  // diff.txt が完全であることを先に検証する。不完全な差分を期待値の導出元にすると、
  // 欠落ファイル上の指摘が file_not_in_diff として「正当に」除外されたように見える。
  const completenessReasons = diffCompletenessReasons(diffRaw, options.untrackedFiles);

  const candidates: Finding[] = [];
  let exceptionDropped = 0;
  for (const item of rawFindings) {
    if (!isRecord(item)) {
      exceptionDropped++;
      continue;
    }
    const axis = item.axis;
    if (typeof axis !== "string" || !VALID_AXIS_IDS.has(axis)) {
      exceptionDropped++;
      continue;
    }
    const severity = item.severity;
    if (severity !== "must" && severity !== "should" && severity !== "want") {
      exceptionDropped++;
      continue;
    }
    const detail = item.detail;
    if (typeof detail !== "string" || !detail.trim()) {
      exceptionDropped++;
      continue;
    }
    candidates.push(item as unknown as Finding);
  }

  const changedMap = options.changedLinesMap ?? parseDiffChangedLines(diffRaw);
  const { kept, filteredOut } = filterFindingsByDiff(candidates, changedMap);
  const merged = mergeFindingsByProximity(kept);

  const findingKey = (f: Finding): string =>
    [f.axis, f.severity, f.filePath ?? "", String(f.position?.line ?? "")].join("\u0000");
  const filteredKey = (f: FilteredOutItem): string =>
    [f.axis, f.filePath ?? "", f.line === undefined ? "" : String(f.line), f.reason].join("\u0000");

  const expectedFindings = merged.map(findingKey);
  const actualFindings = findings.findings.map(findingKey);
  const expectedFiltered = filteredOut.map(filteredKey);

  const reasons: string[] = [...completenessReasons];

  // findings.filteredOut は orchestrator が書く任意フィールドであり、スキーマを検証せずに
  // 読むと `items: [null]` のような形で TypeError に落ちる（例外にしない fail-closed）。
  // 形が不正な items はキー化せず reasons に積み、match=false へ倒す。
  const filteredOutRaw = findings.filteredOut;
  const actualFiltered: string[] = [];
  if (filteredOutRaw !== undefined) {
    if (!isRecord(filteredOutRaw)) {
      reasons.push("findings.filteredOut がオブジェクトではありません");
    } else if (!Array.isArray(filteredOutRaw.items)) {
      reasons.push("findings.filteredOut.items が配列ではありません");
    } else {
      for (const [index, item] of filteredOutRaw.items.entries()) {
        if (!isRecord(item)) {
          reasons.push(`findings.filteredOut.items[${index}] がオブジェクトではありません`);
          continue;
        }
        const axis = item.axis;
        if (typeof axis !== "string" || !VALID_AXIS_IDS.has(axis)) {
          reasons.push(`findings.filteredOut.items[${index}].axis が不正です: ${String(axis)}`);
          continue;
        }
        const reason = item.reason;
        if (typeof reason !== "string" || !VALID_FILTERED_OUT_REASONS.has(reason)) {
          reasons.push(`findings.filteredOut.items[${index}].reason が不正です: ${String(reason)}`);
          continue;
        }
        if (item.filePath !== undefined && typeof item.filePath !== "string") {
          reasons.push(`findings.filteredOut.items[${index}].filePath が文字列ではありません`);
          continue;
        }
        if (
          item.line !== undefined &&
          (typeof item.line !== "number" || !Number.isInteger(item.line))
        ) {
          reasons.push(`findings.filteredOut.items[${index}].line が整数ではありません`);
          continue;
        }
        actualFiltered.push(filteredKey(item as unknown as FilteredOutItem));
      }
      if (typeof filteredOutRaw.count !== "number" || !Number.isInteger(filteredOutRaw.count)) {
        reasons.push(
          `findings.filteredOut.count が整数ではありません: ${String(filteredOutRaw.count)}`,
        );
      } else if (filteredOutRaw.count !== filteredOutRaw.items.length) {
        reasons.push(
          `filteredOut.count=${filteredOutRaw.count} が items 件数 ${filteredOutRaw.items.length} と一致しません`,
        );
      }
    }
  }

  const missingFindings = multisetMissing(expectedFindings, actualFindings);
  const unexpectedFindings = multisetMissing(actualFindings, expectedFindings);
  if (missingFindings.length > 0 || unexpectedFindings.length > 0) {
    reasons.push(
      `findings が reviewer-outputs.json からの機械導出と一致しません（欠落 ${missingFindings.length} 件: ${missingFindings.map(describeFindingKey).join(" / ") || "なし"}、余剰 ${unexpectedFindings.length} 件: ${unexpectedFindings.map(describeFindingKey).join(" / ") || "なし"}）`,
    );
  }
  const missingFiltered = multisetMissing(expectedFiltered, actualFiltered);
  const unexpectedFiltered = multisetMissing(actualFiltered, expectedFiltered);
  if (missingFiltered.length > 0 || unexpectedFiltered.length > 0) {
    reasons.push(
      `filteredOut が diff フィルタの機械導出と一致しません（欠落 ${missingFiltered.length} 件: ${missingFiltered.map(describeFindingKey).join(" / ") || "なし"}、余剰 ${unexpectedFiltered.length} 件: ${unexpectedFiltered.map(describeFindingKey).join(" / ") || "なし"}）`,
    );
  }
  if (reasons.length > 0) {
    reasons.push(
      `内訳: raw=${rawFindings.length} kept(マージ後)=${merged.length} filteredOut=${filteredOut.length} merge統合=${kept.length - merged.length} 例外除外(axis/severity/detail)=${exceptionDropped}`,
    );
  }
  return { match: reasons.length === 0, reasons };
}
