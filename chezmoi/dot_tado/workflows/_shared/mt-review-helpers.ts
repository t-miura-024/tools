import { resolve, join } from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
}

export function isPathInside(base: string, target: string): boolean {
  const normalizedBase = resolve(base);
  const normalizedTarget = resolve(target);
  let realBase: string;
  try {
    realBase = fs.realpathSync(normalizedBase);
  } catch {
    realBase = normalizedBase;
  }
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(normalizedTarget);
  } catch {
    try {
      const sep = normalizedTarget.lastIndexOf("/");
      const parent = sep > 0 ? normalizedTarget.slice(0, sep) : sep === 0 ? "/" : ".";
      const realParent = fs.realpathSync(parent);
      const rest = normalizedTarget.slice(parent.length);
      realTarget = realParent + rest;
    } catch {
      realTarget = normalizedTarget;
    }
  }
  return realTarget === realBase || realTarget.startsWith(realBase + "/");
}

// =============================================================================
// 検証観点プール — 15 観点 × 4 カテゴリ × 5 Tier を SoT とする
// =============================================================================

export type Width = "low" | "medium" | "high" | "xhigh" | "max";
export type Depth = "max" | "xhigh" | "high" | "medium" | "low";

export interface Perspective {
  id: string;
  label: string;
  name: string;
  category: string;
  tier: 1 | 2 | 3 | 4 | 5;
  summary: string;
}

export const PERSPECTIVE_POOL: readonly Perspective[] = [
  {
    id: "req-1",
    label: "要件-1",
    name: "目的整合",
    category: "要件",
    tier: 1,
    summary: "Issue/背景の目的を達成し、本質的で効率的な解決か。目的外混入はないか",
  },
  {
    id: "req-2",
    label: "要件-2",
    name: "仕様カバレッジ",
    category: "要件",
    tier: 1,
    summary:
      "要求の充足、要求外の振る舞い・スコープクリープ・過剰実装(YAGNI違反/投機的一般化)がないか",
  },
  {
    id: "logic-1",
    label: "ロジック-1",
    name: "エラーハンドリング",
    category: "ロジック",
    tier: 1,
    summary: "例外・異常系の妥当性と回復戦略",
  },
  {
    id: "ai-1",
    label: "AI-1",
    name: "ハルシネーションチェック",
    category: "AIアンチパターン",
    tier: 1,
    summary: "幻覚 API・存在しない機能・未検証の前提に基づくコード",
  },
  {
    id: "logic-2",
    label: "ロジック-2",
    name: "セキュリティ",
    category: "ロジック",
    tier: 2,
    summary: "入力検証・秘匿情報・権限・データ整合性・ロールバック",
  },
  {
    id: "logic-3",
    label: "ロジック-3",
    name: "影響範囲",
    category: "ロジック",
    tier: 2,
    summary:
      "差分内の変更による波及・破壊的変更・テスト戦略。同種問題も差分内の原因行に紐付けて指摘し、差分外ファイルへの直接指摘は行わない",
  },
  {
    id: "ai-2",
    label: "AI-2",
    name: "ワイヤリング",
    category: "AIアンチパターン",
    tier: 2,
    summary: "作ったが呼ばれていない・既存機構と接続されていない・統合不整合",
  },
  {
    id: "arch-1",
    label: "アーキ-1",
    name: "関心事の分離",
    category: "アーキテクチャ",
    tier: 2,
    summary:
      "差分内の関心事の分離・ディレクトリ構成・モジュール責務境界。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "logic-4",
    label: "ロジック-4",
    name: "パフォーマンス",
    category: "ロジック",
    tier: 3,
    summary: "実行効率・リソース(エッジケースはテスト委譲)",
  },
  {
    id: "ai-3",
    label: "AI-3",
    name: "冗長性",
    category: "AIアンチパターン",
    tier: 3,
    summary:
      "冗長な条件分岐・フォールバック/デフォルト引数濫用・早すぎるキャッシュ・不要な後方互換",
  },
  {
    id: "ai-4",
    label: "AI-4",
    name: "場当たり対応",
    category: "AIアンチパターン",
    tier: 3,
    summary:
      "レビュー指摘への表面的対応・決定トレーサビリティ欠如(死蔵/未使用コードは linter 委譲)",
  },
  {
    id: "arch-2",
    label: "アーキ-2",
    name: "凝集度",
    category: "アーキテクチャ",
    tier: 3,
    summary:
      "差分内が深い module か（浅い module 検出、凝集欠如）。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "arch-3",
    label: "アーキ-3",
    name: "一貫性",
    category: "アーキテクチャ",
    tier: 4,
    summary:
      "差分内の既存コード思想・スタイル・パターンとの一致。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "arch-4",
    label: "アーキ-4",
    name: "ネーミング",
    category: "アーキテクチャ",
    tier: 4,
    summary:
      "差分内の名前が意図を表すか、ドメイン概念の表現。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
  {
    id: "arch-5",
    label: "アーキ-5",
    name: "結合度",
    category: "アーキテクチャ",
    tier: 5,
    summary:
      "差分内の依存方向・過度な結合・変更の散らばり（Shotgun Surgery）。差分外の設計論は差分内の原因行に紐付けてのみ言及",
  },
] as const;

export const WIDTH_ORDER: readonly Width[] = ["low", "medium", "high", "xhigh", "max"] as const;
export const DEPTH_ORDER: readonly Depth[] = ["max", "xhigh", "high", "medium", "low"] as const;

export const WIDTH_TO_COUNT: Record<Width, number> = {
  low: 4,
  medium: 8,
  high: 12,
  xhigh: 14,
  max: 15,
};

export const DEPTH_TO_PER_COUNT: Record<Depth, number> = {
  max: 1,
  xhigh: 2,
  high: 3,
  medium: 4,
  low: -1,
};

export function getPerspectivesForWidth(width: Width): Perspective[] {
  const count = WIDTH_TO_COUNT[width];
  if (count === undefined) throw new Error(`unknown width: ${width}`);
  return PERSPECTIVE_POOL.slice(0, count) as Perspective[];
}

export function getPerReviewerCount(depth: Depth, total: number): number {
  const per = DEPTH_TO_PER_COUNT[depth];
  if (per === undefined) throw new Error(`unknown depth: ${depth}`);
  if (per === -1) return total;
  return per;
}

export function getReviewerAssignments(width: Width, depth: Depth): Perspective[][] {
  const perspectives = getPerspectivesForWidth(width);
  const per = getPerReviewerCount(depth, perspectives.length);
  const assignments: Perspective[][] = [];
  for (let i = 0; i < perspectives.length; i += per) {
    assignments.push(perspectives.slice(i, i + per));
  }
  return assignments;
}

export function getReviewerWaves(width: Width, depth: Depth, maxPerWave = 6): Perspective[][][] {
  const assignments = getReviewerAssignments(width, depth);
  const waves: Perspective[][][] = [];
  for (let i = 0; i < assignments.length; i += maxPerWave) {
    waves.push(assignments.slice(i, i + maxPerWave));
  }
  return waves;
}

export function getReviewerCount(width: Width, depth: Depth): number {
  return getReviewerAssignments(width, depth).length;
}

export function parseEffortArgs(input: string): {
  width?: Width;
  depth?: Depth;
  base?: string;
  target?: string;
} {
  const result: { width?: Width; depth?: Depth; base?: string; target?: string } = {};
  const widthMatch = input.match(/width\s*=\s*(low|medium|high|xhigh|max)/i);
  if (widthMatch) result.width = widthMatch[1].toLowerCase() as Width;
  const depthMatch = input.match(/depth\s*=\s*(max|xhigh|high|medium|low)/i);
  if (depthMatch) result.depth = depthMatch[1].toLowerCase() as Depth;
  const baseMatch = input.match(/base\s*=\s*([^\s]+)/i);
  if (baseMatch) result.base = baseMatch[1];
  const targetMatch = input.match(/target\s*=\s*([^\s]+)/i);
  if (targetMatch) result.target = targetMatch[1];
  return result;
}

// =============================================================================
// Findings / Verdict 型と検証
// =============================================================================

export type Severity = "must" | "should" | "want";

export interface Finding {
  axis: string;
  severity: Severity;
  detail: string;
  filePath?: string;
  position?: { side: "new" | "old"; line: number };
  suggestions?: string[];
}

export interface FilteredOutItem {
  axis: string;
  filePath?: string;
  line?: number;
  reason:
    | "file_not_in_diff"
    | "line_not_in_added"
    | "missing_position"
    | "old_side"
    | "missing_filePath";
  detail?: string;
}

export interface FindingsJson {
  round: number;
  width: Width;
  depth: Depth;
  findings: Finding[];
  counts: { must: number; should: number; want: number };
  filteredOut?: { count: number; items: FilteredOutItem[] };
}

export interface VerdictJson {
  round: number;
  width: Width;
  depth: Depth;
  passed: boolean;
  blocking_threads: Array<{
    id?: string;
    file?: string;
    line?: number | { start: number; end: number } | null;
    taxonomy?: string;
    body: string;
  }>;
  findingsPath?: string;
}

export const VALID_WIDTHS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);
export const VALID_DEPTHS = new Set<string>(["max", "xhigh", "high", "medium", "low"]);
export const VALID_SEVERITIES = new Set<string>(["must", "should", "want"]);
export const VALID_AXIS_IDS = new Set<string>(PERSPECTIVE_POOL.map((p) => p.id));

type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function readSessionFile(sessionDir: string, fileName: string): string | undefined {
  const fullPath = join(sessionDir, fileName);
  if (!isPathInside(sessionDir, fullPath)) {
    throw new Error(`path traversal detected: ${fullPath}`);
  }
  try {
    return fs.readFileSync(fullPath, "utf-8") as string;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return undefined;
    throw e;
  }
}

export function findJsonObject(raw: string | undefined): JsonRecord | undefined {
  const parsed = parseJson(raw);
  if (isRecord(parsed)) return parsed;
  if (!raw) return undefined;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  if (start === 0 && end === raw.length - 1) return undefined;
  return findJsonObject(raw.slice(start, end + 1));
}

export function findArtifactText(
  artifacts: { artifactKey: string; filePath: string }[],
  key: string,
  sessionDir?: string,
): string | undefined {
  const match = artifacts.find((a) => a.artifactKey === key);
  if (!match) return undefined;
  const rawPath = match.filePath;
  if (typeof rawPath !== "string" || !rawPath.trim()) return undefined;
  const resolved = resolve(rawPath);
  if (sessionDir) {
    if (!isPathInside(sessionDir, resolved)) {
      return undefined;
    }
  } else {
    if (rawPath.includes("..")) return undefined;
  }
  try {
    return fs.readFileSync(resolved, "utf-8") as string;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return undefined;
    throw e;
  }
}

// findings.json の機械検証 (純粋関数)
export function validateFindingsJson(raw: string | undefined): {
  valid: boolean;
  error?: string;
  parsed?: FindingsJson;
} {
  if (!raw) return { valid: false, error: "findings.json not found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: "findings.json is not valid JSON" };
  }
  if (!isRecord(parsed)) return { valid: false, error: "findings.json is not an object" };
  const r = parsed as Record<string, unknown>;
  if (typeof r.round !== "number" || !Number.isInteger(r.round) || r.round < 1) {
    return { valid: false, error: "missing or invalid round" };
  }
  if (typeof r.width !== "string" || !VALID_WIDTHS.has(r.width)) {
    return { valid: false, error: `invalid width: ${String(r.width)}` };
  }
  if (typeof r.depth !== "string" || !VALID_DEPTHS.has(r.depth)) {
    return { valid: false, error: `invalid depth: ${String(r.depth)}` };
  }
  if (!Array.isArray(r.findings)) return { valid: false, error: "missing findings array" };
  if (!isRecord(r.counts)) return { valid: false, error: "missing counts" };
  const counts = r.counts as Record<string, unknown>;
  if (
    typeof counts.must !== "number" ||
    typeof counts.should !== "number" ||
    typeof counts.want !== "number"
  ) {
    return { valid: false, error: "counts must have must/should/want numbers" };
  }

  let must = 0;
  let should = 0;
  let want = 0;
  for (const item of r.findings as unknown[]) {
    if (!isRecord(item)) return { valid: false, error: "finding is not an object" };
    if (typeof item.axis !== "string" || !VALID_AXIS_IDS.has(item.axis)) {
      return { valid: false, error: `invalid axis: ${String(item.axis)}` };
    }
    if (typeof item.severity !== "string" || !VALID_SEVERITIES.has(item.severity)) {
      return { valid: false, error: `invalid severity: ${String(item.severity)}` };
    }
    if (typeof item.detail !== "string" || !item.detail.trim()) {
      return { valid: false, error: "finding detail is missing or empty" };
    }
    if (typeof item.filePath !== "string" || !item.filePath.trim()) {
      return { valid: false, error: "filePath is required and must be non-empty string" };
    }
    if (!isRecord(item.position)) {
      return { valid: false, error: "position is required and must be object" };
    }
    if (item.position.side !== "new") {
      return { valid: false, error: 'position.side must be "new"' };
    }
    if (
      typeof item.position.line !== "number" ||
      !Number.isInteger(item.position.line) ||
      item.position.line < 1
    ) {
      return { valid: false, error: "position.line must be positive integer" };
    }
    if (item.suggestions !== undefined) {
      if (!Array.isArray(item.suggestions))
        return { valid: false, error: "suggestions must be array" };
      for (const s of item.suggestions as unknown[]) {
        if (typeof s !== "string") return { valid: false, error: "suggestion must be string" };
      }
    }
    if (item.severity === "must") must++;
    else if (item.severity === "should") should++;
    else if (item.severity === "want") want++;
  }

  if (must !== counts.must || should !== counts.should || want !== counts.want) {
    return {
      valid: false,
      error: `counts mismatch: expected must=${must} should=${should} want=${want}, got must=${counts.must} should=${counts.should} want=${counts.want}`,
    };
  }

  return { valid: true, parsed: parsed as FindingsJson };
}

export function validateVerdictJson(raw: string | undefined): {
  valid: boolean;
  error?: string;
  parsed?: VerdictJson;
} {
  if (!raw) return { valid: false, error: "verdict.json not found" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false, error: "verdict.json is not valid JSON" };
  }
  if (!isRecord(parsed)) return { valid: false, error: "verdict.json is not an object" };
  const r = parsed as Record<string, unknown>;
  if (typeof r.round !== "number" || !Number.isInteger(r.round) || r.round < 1) {
    return { valid: false, error: "missing or invalid round" };
  }
  if (typeof r.width !== "string" || !VALID_WIDTHS.has(r.width)) {
    return { valid: false, error: `invalid width: ${String(r.width)}` };
  }
  if (typeof r.depth !== "string" || !VALID_DEPTHS.has(r.depth)) {
    return { valid: false, error: `invalid depth: ${String(r.depth)}` };
  }
  if (typeof r.passed !== "boolean") return { valid: false, error: "missing or invalid passed" };
  if (!Array.isArray(r.blocking_threads))
    return { valid: false, error: "missing blocking_threads" };
  for (const t of r.blocking_threads as unknown[]) {
    if (!isRecord(t) || typeof t.body !== "string")
      return { valid: false, error: "blocking_threads body invalid" };
  }
  return { valid: true, parsed: parsed as VerdictJson };
}

// =============================================================================
// 純粋関数: ±2 行マージ (機械ルール集約)
// =============================================================================

export function mergeFindingsByProximity(findings: Finding[]): Finding[] {
  if (findings.length === 0) return [];

  const sorted = [...findings].sort((a, b) => {
    const fa = a.filePath ?? "";
    const fb = b.filePath ?? "";
    if (fa !== fb) return fa.localeCompare(fb);
    const la = a.position?.line ?? Number.POSITIVE_INFINITY;
    const lb = b.position?.line ?? Number.POSITIVE_INFINITY;
    if (la !== lb) return la - lb;
    return a.axis.localeCompare(b.axis);
  });

  const severityRank: Record<Severity, number> = { must: 0, should: 1, want: 2 };

  const merged: Finding[] = [];
  let current: Finding | null = null;

  for (const f of sorted) {
    if (!current) {
      current = { ...f, suggestions: f.suggestions ? [...f.suggestions] : undefined };
      continue;
    }

    const sameFile =
      (current.filePath ?? "") === (f.filePath ?? "") && !!current.filePath && !!f.filePath;
    const curLine = current.position?.line;
    const nextLine = f.position?.line;
    const within2 =
      sameFile &&
      typeof curLine === "number" &&
      typeof nextLine === "number" &&
      Math.abs(nextLine - curLine) <= 2;

    if (within2) {
      const mergedDetail = `${current.detail.trim()}\n\n--- merged (±2) ---\n\n${f.detail.trim()}`;
      const mergedSeverity =
        severityRank[f.severity] < severityRank[current.severity] ? f.severity : current.severity;
      const mergedSuggestions = [...(current.suggestions ?? []), ...(f.suggestions ?? [])];
      current = {
        axis: current.axis,
        severity: mergedSeverity,
        detail: mergedDetail,
        filePath: current.filePath,
        position: current.position,
        ...(mergedSuggestions.length > 0 ? { suggestions: mergedSuggestions } : {}),
      };
    } else {
      merged.push(current);
      current = { ...f, suggestions: f.suggestions ? [...f.suggestions] : undefined };
    }
  }
  if (current) merged.push(current);
  return merged;
}

// =============================================================================
// diff.txt パース — 追加行集合の抽出 (純粋関数) — D1/D2/D11 対応
// =============================================================================

export function parseDiffChangedLines(diffRaw: string | undefined): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  if (!diffRaw || !diffRaw.trim()) return result;

  const lines = diffRaw.split("\n");
  let currentFile: string | null = null;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of lines) {
    const line = rawLine;
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      // バイナリ差分は追加行なしとしてスキップ
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim();
      // "+++ b/<path>" or "+++ /dev/null"
      if (rawPath === "/dev/null" || rawPath === "b/dev/null") {
        currentFile = null;
      } else if (rawPath.startsWith("b/")) {
        const filePath = rawPath.slice(2);
        if (filePath && filePath !== "/dev/null") {
          currentFile = filePath;
          if (!result.has(currentFile)) result.set(currentFile, new Set<number>());
        } else {
          currentFile = null;
        }
      } else {
        // 予期しない形式だが念のため b/ なしでも扱う
        const filePath = rawPath;
        if (filePath && filePath !== "/dev/null") {
          currentFile = filePath;
          if (!result.has(currentFile)) result.set(currentFile, new Set<number>());
        } else {
          currentFile = null;
        }
      }
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        newLine = Number.parseInt(match[1], 10);
        inHunk = true;
      } else {
        inHunk = false;
      }
      continue;
    }
    if (!inHunk || currentFile === null) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const set = result.get(currentFile);
      if (set) set.add(newLine);
      newLine++;
    } else if (line.startsWith(" ")) {
      newLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      // old側削除は newLine を進めない
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — 無視
    } else {
      // hunk外のメタ行は無視（index, ---, etc.は既に処理済み）
    }
  }

  // 空集合のファイル（バイナリや削除で追加行なし）は除外して返す（判定を file_not_in_diff に倒すため）
  for (const [file, set] of result) {
    if (set.size === 0) result.delete(file);
  }

  return result;
}

export function filterFindingsByDiff(
  findings: Finding[],
  changedLinesMap: Map<string, Set<number>>,
): { kept: Finding[]; filteredOut: FilteredOutItem[] } {
  const kept: Finding[] = [];
  const filteredOut: FilteredOutItem[] = [];

  for (const f of findings) {
    const filePath = f.filePath?.trim() ?? "";
    const position = f.position;
    const line = position?.line;
    const side = (position as unknown as { side?: string })?.side;

    if (!filePath) {
      filteredOut.push({
        axis: f.axis,
        reason: "missing_filePath",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    if (!position || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      filteredOut.push({
        axis: f.axis,
        filePath,
        reason: "missing_position",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    if (side !== "new") {
      filteredOut.push({
        axis: f.axis,
        filePath,
        line,
        reason: "old_side",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    const set = changedLinesMap.get(filePath);
    if (!set) {
      filteredOut.push({
        axis: f.axis,
        filePath,
        line,
        reason: "file_not_in_diff",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    if (!set.has(line)) {
      filteredOut.push({
        axis: f.axis,
        filePath,
        line,
        reason: "line_not_in_added",
        detail: f.detail.slice(0, 120),
      });
      continue;
    }
    kept.push(f);
  }

  return { kept, filteredOut };
}

// =============================================================================
// STML markup + summary 出力標準化 (純粋関数)
// =============================================================================

const SEVERITY_EMOJI: Record<string, string> = {
  must: "🚨",
  should: "⚠️",
  want: "💡",
};

const TAXONOMY_EMOJI: Record<string, string> = {
  issue: "🐛",
  question: "🙋",
};

const AXIS_EMOJI: Record<string, string> = {
  "req-1": "🎯",
  "req-2": "📋",
  "logic-1": "🛡️",
  "logic-2": "🔒",
  "logic-3": "🧭",
  "logic-4": "⚡",
  "ai-1": "👁️",
  "ai-2": "🔌",
  "ai-3": "♻️",
  "ai-4": "🩹",
  "arch-1": "🧩",
  "arch-2": "🧱",
  "arch-3": "🎨",
  "arch-4": "🏷️",
  "arch-5": "🔗",
};

const SEVERITY_BORDER_COLOR: Record<string, string> = {
  must: "danger",
  should: "warning",
  want: "muted",
};

function escapeStml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatReviewComment(input: {
  severity: Severity;
  axis: string;
  detail: string;
  filePath?: string;
  line?: number;
  suggestions?: string[];
}): { markup: string; summary: string } {
  const severityEmoji = SEVERITY_EMOJI[input.severity] ?? "";
  const taxonomy = input.severity === "must" ? "issue" : "question";
  const taxonomyEmoji = TAXONOMY_EMOJI[taxonomy] ?? "";
  const axisEmoji = AXIS_EMOJI[input.axis] ?? "🔍";
  const borderColor = SEVERITY_BORDER_COLOR[input.severity] ?? "muted";
  const title = `${severityEmoji} ${input.severity} · ${taxonomyEmoji} ${taxonomy} · ${axisEmoji} ${input.axis}`;
  const target = input.filePath
    ? input.line !== undefined
      ? `${input.filePath}:${input.line}`
      : input.filePath
    : "general";
  const detailHead = input.detail.trim().split("\n")[0]?.trim() ?? "";
  const truncatedHead = detailHead.length > 80 ? `${detailHead.slice(0, 77)}...` : detailHead;
  const summary = `${severityEmoji} ${input.severity} · ${taxonomyEmoji} ${taxonomy} · ${axisEmoji} ${input.axis} | ${target} — ${truncatedHead}`;
  const escapedDetail = escapeStml(input.detail.trim()).replace(/\n/g, "<br/>");
  const targetBlock = `<text><dim>📁 ${escapeStml(target)}</dim></text>`;
  const detailBlock = `<text>${escapedDetail}</text>`;
  let markup = `<box border border-color="${borderColor}" padding-x="1" padding-y="1" title="${title}">\n`;
  markup += `${targetBlock}\n`;
  markup += `<spacer size="1" />\n`;
  markup += `${detailBlock}`;
  if (input.suggestions && input.suggestions.length > 0) {
    const items = input.suggestions
      .map((s) => `<item>${escapeStml(s).replace(/\n/g, "<br/>")}</item>`)
      .join("");
    markup += `\n<spacer size="1" />\n<list>${items}</list>`;
  }
  markup += `\n</box>`;
  return { markup, summary };
}

function optionalLocation(item: JsonRecord): { filePath?: string; position?: unknown } {
  const location = isRecord(item.location) ? item.location : undefined;
  const filePathCandidate =
    item.filePath ?? item.file_path ?? location?.filePath ?? location?.file_path;
  const positionCandidate = item.position ?? location?.position;
  return {
    ...(typeof filePathCandidate === "string" && filePathCandidate.trim()
      ? { filePath: filePathCandidate }
      : {}),
    ...(isRecord(positionCandidate) ? { position: positionCandidate } : {}),
  };
}

function positionToHunkLines(
  position: unknown,
): { newLine?: number; oldLine?: number } | undefined {
  if (!isRecord(position)) return undefined;
  const line = position.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  if (position.side !== "new") return undefined;
  return { newLine: line };
}

export function buildHunkComments(findingsRaw: string | undefined): JsonRecord[] {
  const comments: JsonRecord[] = [];
  const parsed = findJsonObject(findingsRaw);
  const findingsArray: unknown[] = Array.isArray(parsed?.findings)
    ? (parsed!.findings as unknown[])
    : [];

  const merged = mergeFindingsByProximity(
    findingsArray
      .filter(isRecord)
      .map((item) => {
        const r = item as Record<string, unknown>;
        const severity = r.severity;
        const detail = r.detail;
        const axis = r.axis;
        if (typeof axis !== "string" || !VALID_AXIS_IDS.has(axis)) return null;
        if (severity !== "must" && severity !== "should" && severity !== "want") return null;
        if (typeof detail !== "string" || !detail.trim()) return null;
        const location = optionalLocation(r as JsonRecord);
        if (typeof location.filePath !== "string" || !location.filePath.trim()) return null;
        const filePath = location.filePath.trim();
        const positionLines = positionToHunkLines(location.position);
        if (!positionLines?.newLine) return null;
        const line = positionLines.newLine;
        const rawSuggestions = (r.suggestions ??
          r.suggestion ??
          r.proposals ??
          r.proposal) as unknown;
        let suggestions: string[] | undefined;
        if (Array.isArray(rawSuggestions)) {
          const filtered = (rawSuggestions as unknown[]).filter(
            (s): s is string => typeof s === "string" && s.trim().length > 0,
          );
          if (filtered.length > 0) suggestions = filtered.map((s) => s.trim());
        } else if (typeof rawSuggestions === "string" && rawSuggestions.trim()) {
          suggestions = [rawSuggestions.trim()];
        }
        return {
          axis,
          severity: severity as Severity,
          detail: (detail as string).trim(),
          filePath,
          position: location.position as { side: "new"; line: number },
          line,
          positionLines,
          suggestions,
        } as unknown as Finding & {
          line?: number;
          positionLines?: { newLine?: number; oldLine?: number };
        };
      })
      .filter(
        (
          v,
        ): v is Finding & {
          line?: number;
          positionLines?: { newLine?: number; oldLine?: number };
        } => v !== null,
      )
      .map((f) => ({
        axis: f.axis,
        severity: f.severity,
        detail: f.detail,
        filePath: f.filePath,
        position: f.position,
        ...(f.suggestions ? { suggestions: f.suggestions } : {}),
      })),
  );

  for (const f of merged) {
    const filePath = f.filePath!;
    const positionLines = f.position ? positionToHunkLines(f.position) : undefined;
    if (!positionLines?.newLine) continue;
    const line = positionLines.newLine;
    const { markup, summary } = formatReviewComment({
      severity: f.severity,
      axis: f.axis,
      detail: f.detail,
      filePath,
      line,
      suggestions: f.suggestions,
    });
    const comment: JsonRecord = { summary, markup, filePath, newLine: line };
    comments.push(comment);
  }

  return comments;
}

// =============================================================================
// hunk 連携
// =============================================================================

export const HUNK_START_KEY = "hunk-start.json";
export const HUNK_COMMENTS_KEY = "hunk-comments.json";
export const HUNK_CHECK_KEY = "hunk-check.json";
export const EFFORT_KEY = "effort.json";
export const FINDINGS_KEY = "findings.json";
export const VERDICT_KEY = "verdict.json";

export interface HunkBlockingThread {
  id?: string;
  file?: string;
  line?: number | { start: number; end: number } | null;
  taxonomy?: string;
  body: string;
  replies?: string[];
}

export interface HunkCheckOutput {
  passes: boolean;
  blocking_threads: HunkBlockingThread[];
}

export function parseHunkCheck(raw: string | undefined): HunkCheckOutput | undefined {
  const parsed = findJsonObject(raw);
  if (!parsed || typeof parsed.passes !== "boolean" || !Array.isArray(parsed.blocking_threads)) {
    return undefined;
  }
  const blockingThreads: HunkBlockingThread[] = [];
  for (const value of parsed.blocking_threads) {
    if (!isRecord(value) || typeof value.body !== "string") return undefined;
    const replies = Array.isArray(value.replies)
      ? value.replies.filter((reply): reply is string => typeof reply === "string")
      : [];
    blockingThreads.push({
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.file === "string" ? { file: value.file } : {}),
      ...(typeof value.line === "number" || isRecord(value.line)
        ? { line: value.line as HunkBlockingThread["line"] }
        : {}),
      ...(typeof value.taxonomy === "string" ? { taxonomy: value.taxonomy } : {}),
      body: value.body,
      replies,
    });
  }
  return { passes: parsed.passes, blocking_threads: blockingThreads };
}

export function runHunkCommand(args: string[]): string {
  try {
    return String(
      execFileSync("mt", ["hunk", ...args], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }),
    );
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : String(stdout ?? "");
  }
}

export function isHunkSessionActive(): boolean {
  return runHunkCommand(["status"]).includes("hunk review session: active");
}

// =============================================================================
// effort base/target バリデーション
// =============================================================================

const VALID_REF_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidGitRefName(ref: string): boolean {
  if (!ref || ref.length > 200) return false;
  if (!VALID_REF_PATTERN.test(ref)) return false;
  if (ref.includes("..")) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.includes("//"))
    return false;
  if (/[;|&$`"'<>(){}*?!\n\r]/.test(ref)) return false;
  return true;
}

export function validateEffortBaseTarget(base?: unknown, target?: unknown): string | undefined {
  if (base !== undefined) {
    if (typeof base !== "string" || !base.trim()) return "base must be non-empty string if present";
    if (!isValidGitRefName(base.trim())) return `invalid base: ${base}`;
  }
  if (target !== undefined) {
    if (typeof target !== "string" || !target.trim())
      return "target must be non-empty string if present";
    if (!isValidGitRefName(target.trim())) return `invalid target: ${target}`;
  }
  return undefined;
}
