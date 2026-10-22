import { join } from "node:path";
import type { ArtifactRecord } from "tado";
import { findArtifactText, readSessionFile } from "tado/artifacts";
import { isRecord } from "../../shared/review-helpers/is-record";
import { parseJson } from "../../shared/review-helpers/parse-json";
import {
  REVIEW_BODY_KEY,
  REVIEW_DECISIONS_KEY,
  REVIEW_FINDINGS_KEY,
  REVIEW_ROUND_KEY,
} from "./review-limits.ts";

export type Perspective = "A" | "B" | "C" | "D" | "E";
export type Severity = "must" | "should" | "want";
export type FindingType = "decision" | "mechanical";

export const PERSPECTIVE_LABELS: Record<Perspective, string> = {
  A: "追加すり合わせ候補",
  B: "決定間矛盾",
  C: "思想・ポリシー違反＋ADR記載明記",
  D: "plan-format準拠性",
  E: "実行可能性・検証可能性",
};

const PERSPECTIVES = new Set<string>(["A", "B", "C", "D", "E"]);
const SEVERITIES = new Set<string>(["must", "should", "want"]);
const TYPES = new Set<string>(["decision", "mechanical"]);
const TARGET_PATTERN = /^issue-body(?:-\d+)?\.md$/;
const FINDING_ID_PATTERN = /^R[1-9]\d*-F[1-9]\d*$/;

export interface PlanReviewFinding {
  id: string;
  severity: Severity;
  perspective: Perspective;
  type: FindingType;
  target: string;
  evidence: string;
  problem: string;
  proposedQuestion: string | null;
  proposedOptions: string[];
  proposedFix: string | null;
}

export interface PlanReviewFindings {
  reviewer: string;
  round: number;
  cycleRound: number;
  reviewedTargets: string[];
  findings: PlanReviewFinding[];
  counts: { must: number; should: number; want: number };
}

export interface PlanReviewFindingsValidation {
  valid: boolean;
  parsed?: PlanReviewFindings;
  error?: string;
}

function fail(error: string): PlanReviewFindingsValidation {
  return { valid: false, error };
}

/// 正規化済み review-findings.json の厳密検証。
/// afterStep が付与する id / round / cycleRound / counts まで含めて検証する。
export function validatePlanReviewFindings(raw: string | undefined): PlanReviewFindingsValidation {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return fail("レビュー結果が JSON オブジェクトではありません");

  if (typeof parsed.reviewer !== "string" || parsed.reviewer.trim() === "") {
    return fail("reviewer は非空文字列が必要です");
  }
  if (!isPositiveInteger(parsed.round)) {
    return fail("round は 1 以上の整数が必要です");
  }
  if (!isPositiveInteger(parsed.cycleRound)) {
    return fail("cycleRound は 1 以上の整数が必要です");
  }
  const round = parsed.round;
  if (!Array.isArray(parsed.reviewedTargets) || parsed.reviewedTargets.length === 0) {
    return fail("reviewedTargets は非空配列が必要です");
  }
  const reviewedTargets: string[] = [];
  for (const target of parsed.reviewedTargets) {
    if (typeof target !== "string" || !TARGET_PATTERN.test(target)) {
      return fail(`reviewedTargets に不正な対象ファイルがあります: ${String(target)}`);
    }
    if (reviewedTargets.includes(target)) {
      return fail(`reviewedTargets に重複があります: ${target}`);
    }
    reviewedTargets.push(target);
  }
  if (!reviewedTargets.includes("issue-body.md")) {
    return fail("reviewedTargets に issue-body.md が含まれていません");
  }
  if (!Array.isArray(parsed.findings)) {
    return fail("findings は配列が必要です");
  }

  const findings: PlanReviewFinding[] = [];
  const ids = new Set<string>();
  for (const rawFinding of parsed.findings) {
    if (!isRecord(rawFinding)) return fail("findings の要素がオブジェクトではありません");
    const id = rawFinding.id;
    if (typeof id !== "string" || !FINDING_ID_PATTERN.test(id) || !id.startsWith(`R${round}-`)) {
      return fail(`findings の id が不正です: ${String(id)}（R${round}-F<n> が必要）`);
    }
    if (ids.has(id)) return fail(`findings の id が重複しています: ${id}`);
    ids.add(id);

    const severity = rawFinding.severity;
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
      return fail(`${id}: severity は must/should/want のいずれかが必要です`);
    }
    const perspective = rawFinding.perspective;
    if (typeof perspective !== "string" || !PERSPECTIVES.has(perspective)) {
      return fail(`${id}: perspective は A〜E のいずれかが必要です`);
    }
    const type = rawFinding.type;
    if (typeof type !== "string" || !TYPES.has(type)) {
      return fail(`${id}: type は decision/mechanical のいずれかが必要です`);
    }
    const target = rawFinding.target;
    if (typeof target !== "string" || target.trim() === "") {
      return fail(`${id}: target は非空文字列が必要です`);
    }
    if (!reviewedTargets.some((t) => target === t || target.startsWith(`${t}#`))) {
      return fail(`${id}: target が reviewedTargets のいずれかで始まっていません: ${target}`);
    }
    const evidence = rawFinding.evidence;
    if (typeof evidence !== "string" || evidence.trim() === "") {
      return fail(`${id}: evidence は非空文字列が必要です`);
    }
    const problem = rawFinding.problem;
    if (typeof problem !== "string" || problem.trim() === "") {
      return fail(`${id}: problem は非空文字列が必要です`);
    }
    const proposedQuestion = rawFinding.proposedQuestion;
    if (proposedQuestion !== null && typeof proposedQuestion !== "string") {
      return fail(`${id}: proposedQuestion は文字列または null が必要です`);
    }
    const proposedOptions = rawFinding.proposedOptions;
    if (
      !Array.isArray(proposedOptions) ||
      proposedOptions.some((option) => typeof option !== "string" || option.trim() === "")
    ) {
      return fail(`${id}: proposedOptions は非空文字列の配列が必要です`);
    }
    const proposedFix = rawFinding.proposedFix;
    if (proposedFix !== null && typeof proposedFix !== "string") {
      return fail(`${id}: proposedFix は文字列または null が必要です`);
    }
    if (type === "decision" && (proposedQuestion === null || proposedQuestion.trim() === "")) {
      return fail(`${id}: type=decision には proposedQuestion が必要です`);
    }
    if (type === "mechanical" && (proposedFix === null || proposedFix.trim() === "")) {
      return fail(`${id}: type=mechanical には proposedFix が必要です`);
    }

    findings.push({
      id,
      severity: severity as Severity,
      perspective: perspective as Perspective,
      type: type as FindingType,
      target,
      evidence,
      problem,
      proposedQuestion: proposedQuestion ?? null,
      proposedOptions,
      proposedFix: proposedFix ?? null,
    });
  }

  const counts = parsed.counts;
  if (!isRecord(counts)) return fail("counts はオブジェクトが必要です");
  const computed = computeCounts(findings);
  for (const key of ["must", "should", "want"] as const) {
    const value = counts[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return fail(`counts.${key} は 0 以上の整数が必要です`);
    }
    if (value !== computed[key]) {
      return fail(`counts.${key}=${value} が findings の件数 ${computed[key]} と一致しません`);
    }
  }

  return {
    valid: true,
    parsed: {
      reviewer: parsed.reviewer,
      round,
      cycleRound: parsed.cycleRound,
      reviewedTargets,
      findings,
      counts: computed,
    },
  };
}

/// セッションの最新 review-findings.json を読む。成果物登録よりセッションファイルを優先する。
export function readPlanReviewFindings(
  sessionDir: string,
  artifacts: ArtifactRecord[],
): PlanReviewFindingsValidation {
  const raw =
    readSessionFile(sessionDir, REVIEW_FINDINGS_KEY) ??
    findArtifactText(artifacts, REVIEW_FINDINGS_KEY, sessionDir);
  return validatePlanReviewFindings(raw);
}

export function computeCounts(findings: PlanReviewFinding[]): {
  must: number;
  should: number;
  want: number;
} {
  return {
    must: findings.filter((finding) => finding.severity === "must").length,
    should: findings.filter((finding) => finding.severity === "should").length,
    want: findings.filter((finding) => finding.severity === "want").length,
  };
}

export interface RawReviewFindings {
  reviewer: string;
  reviewedTargets: string[];
  findings: Array<{
    severity: Severity;
    perspective: Perspective;
    type: FindingType;
    target: string;
    evidence: string;
    problem: string;
    proposedQuestion: string | null;
    proposedOptions: string[];
    proposedFix: string | null;
  }>;
}

/// レビュアー SubAgent の生 JSON を検証する（id / round / counts はまだ無い）。
/// コードフェンスが付いていても剥がして解釈する。
export function parseRawReviewFindings(raw: string | undefined): {
  valid: boolean;
  parsed?: RawReviewFindings;
  error?: string;
} {
  if (raw === undefined) return { valid: false, error: "review-findings.json がありません" };
  const unfenced = stripCodeFence(raw);
  const parsed = parseJson(unfenced);
  if (!isRecord(parsed))
    return { valid: false, error: "レビュアー出力が JSON オブジェクトではありません" };

  const reviewedTargetsRaw = parsed.reviewedTargets;
  if (!Array.isArray(reviewedTargetsRaw) || reviewedTargetsRaw.length === 0) {
    return { valid: false, error: "reviewedTargets は非空配列が必要です" };
  }
  const reviewedTargets: string[] = [];
  for (const target of reviewedTargetsRaw) {
    if (typeof target !== "string" || !TARGET_PATTERN.test(target)) {
      return {
        valid: false,
        error: `reviewedTargets に不正な対象ファイルがあります: ${String(target)}`,
      };
    }
    if (reviewedTargets.includes(target)) {
      return { valid: false, error: `reviewedTargets に重複があります: ${target}` };
    }
    reviewedTargets.push(target);
  }
  if (!reviewedTargets.includes("issue-body.md")) {
    return { valid: false, error: "reviewedTargets に issue-body.md が含まれていません" };
  }
  const findingsRaw = parsed.findings;
  if (!Array.isArray(findingsRaw)) return { valid: false, error: "findings は配列が必要です" };

  const findings: RawReviewFindings["findings"] = [];
  for (const rawFinding of findingsRaw) {
    if (!isRecord(rawFinding)) {
      return { valid: false, error: "findings の要素がオブジェクトではありません" };
    }
    const severity = rawFinding.severity;
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
      return { valid: false, error: "severity は must/should/want のいずれかが必要です" };
    }
    const perspective = rawFinding.perspective;
    if (typeof perspective !== "string" || !PERSPECTIVES.has(perspective)) {
      return { valid: false, error: "perspective は A〜E のいずれかが必要です" };
    }
    const type = rawFinding.type;
    if (typeof type !== "string" || !TYPES.has(type)) {
      return { valid: false, error: "type は decision/mechanical のいずれかが必要です" };
    }
    const target = rawFinding.target;
    if (typeof target !== "string" || target.trim() === "") {
      return { valid: false, error: "target は非空文字列が必要です" };
    }
    if (!reviewedTargets.some((t) => target === t || target.startsWith(`${t}#`))) {
      return {
        valid: false,
        error: `target が reviewedTargets のいずれかで始まっていません: ${target}`,
      };
    }
    const evidence = rawFinding.evidence;
    if (typeof evidence !== "string" || evidence.trim() === "") {
      return { valid: false, error: "evidence は非空文字列が必要です" };
    }
    const problem = rawFinding.problem;
    if (typeof problem !== "string" || problem.trim() === "") {
      return { valid: false, error: "problem は非空文字列が必要です" };
    }
    const proposedQuestion =
      typeof rawFinding.proposedQuestion === "string" && rawFinding.proposedQuestion.trim() !== ""
        ? rawFinding.proposedQuestion
        : null;
    const proposedOptionsRaw = rawFinding.proposedOptions;
    if (
      proposedOptionsRaw !== undefined &&
      (!Array.isArray(proposedOptionsRaw) ||
        proposedOptionsRaw.some((option) => typeof option !== "string" || option.trim() === ""))
    ) {
      return { valid: false, error: "proposedOptions は非空文字列の配列が必要です" };
    }
    const proposedOptions = (proposedOptionsRaw ?? []) as string[];
    const proposedFix =
      typeof rawFinding.proposedFix === "string" && rawFinding.proposedFix.trim() !== ""
        ? rawFinding.proposedFix
        : null;
    if (type === "decision" && proposedQuestion === null) {
      return { valid: false, error: "type=decision には proposedQuestion が必要です" };
    }
    if (type === "mechanical" && proposedFix === null) {
      return { valid: false, error: "type=mechanical には proposedFix が必要です" };
    }
    findings.push({
      severity: severity as Severity,
      perspective: perspective as Perspective,
      type: type as FindingType,
      target,
      evidence,
      problem,
      proposedQuestion,
      proposedOptions,
      proposedFix,
    });
  }

  return {
    valid: true,
    parsed: { reviewer: "mt-plan-reviewer", reviewedTargets, findings },
  };
}

export function normalizeReviewFindings(
  raw: RawReviewFindings,
  round: number,
  cycleRound: number,
): PlanReviewFindings {
  const findings = raw.findings.map((finding, index) => ({
    ...finding,
    id: `R${round}-F${index + 1}`,
  }));
  return {
    reviewer: "mt-plan-reviewer",
    round,
    cycleRound,
    reviewedTargets: raw.reviewedTargets,
    findings,
    counts: computeCounts(findings),
  };
}

export function formatMustFindingsForGrill(findings: PlanReviewFindings): string {
  const must = findings.findings.filter((finding) => finding.severity === "must");
  if (must.length === 0) return "";
  return must
    .map((finding) => {
      const lines = [
        `### ${finding.id} [${finding.type}] ${finding.target}`,
        `- 問題: ${finding.problem}`,
        `- 根拠: ${finding.evidence}`,
      ];
      if (finding.proposedQuestion) {
        lines.push(`- 確認すべき質問: ${finding.proposedQuestion}`);
      }
      if (finding.proposedOptions.length > 0) {
        lines.push(`- 選択肢候補: ${finding.proposedOptions.join(" / ")}`);
      }
      if (finding.proposedFix) {
        lines.push(`- 機械的修正案: ${finding.proposedFix}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/// Markdown の `## <prefix>` セクションを抽出する。同名セクションが複数ある場合は
/// 最後のものを返す（grill の再試行で追記された場合も最新の決定を読む）。
/// 見つからなければ undefined。
export function extractMarkdownSection(text: string, headingPrefix: string): string | undefined {
  const lines = text.split("\n");
  const escaped = headingPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^##\\s+${escaped}(?:[\\s（(]|$)`);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (headingPattern.test(lines[index])) {
      start = index;
    }
  }
  if (start === -1) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/// `### <findingId>` ブロックに - 決定: adopt|reject|modify と非空の - 内容: があるか。
export function hasFindingDecision(section: string, findingId: string): boolean {
  const lines = section.split("\n");
  const escaped = findingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const idPattern = new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("### ") && idPattern.test(line)) {
      start = index;
      break;
    }
  }
  if (start === -1) return false;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("### ") || lines[index].startsWith("## ")) {
      end = index;
      break;
    }
  }
  return hasDecisionLines(lines.slice(start, end));
}

/// `## 人間差し戻し` セクションに - 決定: adopt|reject|modify と非空の - 内容: があるか。
export function hasHumanDecision(section: string): boolean {
  return hasDecisionLines(section.split("\n"));
}

function hasDecisionLines(lines: string[]): boolean {
  const normalized = lines.map((line) => line.trim());
  const decision = normalized.some((line) => /^-\s*決定\s*:\s*(adopt|reject|modify)$/.test(line));
  const content = normalized.some((line) => /^-\s*内容\s*:\s*.+$/.test(line));
  return decision && content;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return match ? match[1].trim() : trimmed;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export const REVIEW_KEYS = {
  findings: REVIEW_FINDINGS_KEY,
  body: REVIEW_BODY_KEY,
  decisions: REVIEW_DECISIONS_KEY,
  round: REVIEW_ROUND_KEY,
} as const;

export function reviewFilePath(sessionDir: string, key: string): string {
  return join(sessionDir, key);
}
