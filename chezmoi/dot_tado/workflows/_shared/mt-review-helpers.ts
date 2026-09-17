import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 成果物の安全な読み取りの正典は tado 本体の `tado/artifacts`。
// この共有処理は後方互換の入口として再公開する。
export { findArtifactText, isPathInside, readSessionFile } from "tado/artifacts";

export function shellQuote(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'";
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

/// `filteredOut.items[].reason` として受理する値（filterFindingsByDiff の機械導出と同期）。
export const VALID_FILTERED_OUT_REASONS: ReadonlySet<string> = new Set([
  "file_not_in_diff",
  "line_not_in_added",
  "missing_position",
  "old_side",
  "missing_filePath",
]);

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

  return { valid: true, parsed: parsed as unknown as FindingsJson };
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
  return { valid: true, parsed: parsed as unknown as VerdictJson };
}

/// レビューラウンドの上限（ADR-0026）。round limit の判定規則は
/// `isRoundLimitReached` に一本化し、mt-review-diff の collect_verdict と
/// mt-plan-run の round_limit_gate が同じ写像を使う（写像ドリフト防止）。
export const REVIEW_ROUND_LIMIT = 5;

/// verdict がラウンド上限（round > 3、または round = 3 かつ未通過）に達しているか（純粋関数）。
/// 上限は再実行では解消しないため、消費者は human gate で継続/中止を人間に委ねる。
export function isRoundLimitReached(verdict: Pick<VerdictJson, "round" | "passed">): boolean {
  return (
    verdict.round > REVIEW_ROUND_LIMIT || (verdict.round === REVIEW_ROUND_LIMIT && !verdict.passed)
  );
}

// =============================================================================
// 純粋関数: ±2 行マージ (機械ルール集約)
// =============================================================================

/// ±2 行以内の findings を 1 件へ統合する（純粋関数）。
/// 統合しても各 finding の型（filePath / position などの必須フィールド）は保持されるため、
/// ジェネリクスで呼び出し元の型をそのまま返す（buildDifitComments の position 必須化に使う）。
export function mergeFindingsByProximity<T extends Finding>(findings: T[]): T[] {
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

  const merged: T[] = [];
  let current: T | null = null;

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
      } as T;
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

/// git が C-quote したパス（`"b/..."` 形式）を生のリポジトリ相対パスへ逆写像する（純粋関数）。
///
/// `quoteGitPathForDiff` の逆変換。`"..."` の囲みを外し、`\t` `\n` `\r` `\"` `\\` と
/// git が非 ASCII バイトに使う 3 桁 octal escape をデコードする。引用符で囲まれていない
/// 入力はそのまま返す（壊れた入力も例外にせず原文を返し、無音落ちではなく
/// file_not_in_diff として扱えるようにする）。
export function unquoteGitPath(quoted: string): string {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) return quoted;
  const inner = quoted.slice(1, -1);
  const simpleEscapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '"': 0x22,
    "\\": 0x5c,
  };
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "\\") {
      const rest = inner.slice(i + 1);
      const octal = /^([0-7]{3})/.exec(rest);
      if (octal) {
        bytes.push(Number.parseInt(octal[1], 8));
        i += 4;
        continue;
      }
      const escaped = simpleEscapes[rest[0] ?? ""];
      if (escaped !== undefined) {
        bytes.push(escaped);
        i += 2;
        continue;
      }
      // 未知の escape はバックスラッシュごと原文として保持する（例外にしない）
      bytes.push(0x5c);
      i += 1;
      continue;
    }
    const codePoint = inner.codePointAt(i)!;
    for (const byte of Buffer.from(String.fromCodePoint(codePoint), "utf8")) bytes.push(byte);
    i += codePoint > 0xffff ? 2 : 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/// `--- ` / `+++ ` 行のパス部をリポジトリ相対の生パスへ正規化する（純粋関数）。
///
/// - `a/<path>` / `b/<path>` / `"a/<path>"` / `"b/<path>"` → `<path>`
///   （C-quote は unquoteGitPath で逆写像。`a/` / `b/` は先頭 1 つだけ外す）
/// - `/dev/null` / `a/dev/null` / `b/dev/null` → null（削除ファイルの new 側など）
/// - 空白を含むパスには git が末尾タブを付けるため、引用形・非引用形とも末尾タブを除去する
///   （`+++ "b/my \"file\".txt"<TAB>` の形がある）
function parseDiffHeaderPath(rawPath: string): string | null {
  let path = rawPath.replace(/\t+$/, "");
  if (path.startsWith('"')) {
    const closing = path.lastIndexOf('"');
    if (closing > 0) path = unquoteGitPath(path.slice(0, closing + 1));
  }
  if (path === "/dev/null" || path === "a/dev/null" || path === "b/dev/null") return null;
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  if (!path || path === "/dev/null") return null;
  return path;
}

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
      // `+++ b/<path>` / `+++ "b/<path>"` / `+++ /dev/null`。
      // C-quote（core.quotePath 既定で非 ASCII・引用符を含むパスが引用される）は
      // parseDiffHeaderPath が逆写像し、レビュアーが返す生の filePath とキーを一致させる。
      currentFile = parseDiffHeaderPath(line.slice(4));
      if (currentFile !== null && !result.has(currentFile)) {
        result.set(currentFile, new Set<number>());
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
      // 差分のメタ行は無視（index, ---, etc.は既に処理済み）
    }
  }

  // 空集合のファイル（バイナリや削除で追加行なし）は除外して返す（判定を file_not_in_diff に倒すため）
  for (const [file, set] of result) {
    if (set.size === 0) result.delete(file);
  }

  return result;
}

/// diff.txt のファイル別追加/削除行数（`git diff --numstat` との突合に使う）。
export interface DiffPathLineCounts {
  added: number;
  deleted: number;
}

/// diff.txt からファイル別の追加/削除行数を集計する（純粋関数）。
///
/// `git diff --numstat` のファイル別行数と突合し、head 等による部分出力（ファイル丸ごと
/// 欠落・行数不一致）を検出するために使う。キーは new 側のパス（`+++ b/<path>`）とし、
/// 削除ファイルは old 側のパス（`--- a/<path>`）で数える（numstat も削除は old 側の
/// パスを返す）。リネームは `+++ b/<new>` に集約され、numstat の new 側パスと一致する。
/// バイナリ・モード変更のみのファイルは +/- 行を持たないため現れない（突合側が
/// 行数なしエントリとして扱う）。hunk 内の `+++` / `---` 始まりの内容行はヘッダと
/// 誤認せず +/- の行として数える。
export function countDiffLinesByPath(diffRaw: string): Map<string, DiffPathLineCounts> {
  const result = new Map<string, DiffPathLineCounts>();
  const countsFor = (filePath: string): DiffPathLineCounts => {
    let counts = result.get(filePath);
    if (!counts) {
      counts = { added: 0, deleted: 0 };
      result.set(filePath, counts);
    }
    return counts;
  };

  let currentPath: string | null = null;
  let inHunk = false;
  for (const line of diffRaw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentPath = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // `--- a/<path>` / `+++ b/<path>` はヘッダ。`+++ /dev/null`（追加）は
      // currentPath を更新せず、`--- /dev/null`（新規追加の old 側）も同様。
      if (line.startsWith("--- ") || line.startsWith("+++ ")) {
        const parsed = parseDiffHeaderPath(line.slice(4));
        if (parsed !== null) currentPath = parsed;
      }
      continue;
    }
    if (currentPath === null) continue;
    if (line.startsWith("+")) countsFor(currentPath).added += 1;
    else if (line.startsWith("-")) countsFor(currentPath).deleted += 1;
  }
  return result;
}

// =============================================================================
// diff.txt の完全性検証 — untracked 打ち切り・truncate マーカーの検出
// =============================================================================

/// 検証者プロンプトへの転記時に付記する truncate マーカー
/// （run_reviewers が diff.txt のコピーを切り詰めるときだけ使う）。
/// diff.txt 自体にこの行が現れたら、機械照合（normalize / audit）の SoT が
/// 打ち切られている（表示用の切り詰めと SoT を混同している）。
export const DIFF_TRUNCATION_MARKER_PATTERN = /^\[\.\.\. truncated: \d+ lines omitted\]\s*$/;

/// git が `git diff` のヘッダでパスを C-quote する形を再現する（純粋関数）。
///
/// git は `core.quotePath` の既定で非 ASCII バイト・制御文字・`"`・`\` を含むパスを
/// `"..."` + octal escape へ変換する（空白は変換しない）。差分テキストから
/// untracked ファイルの出現を照合するには、同じ写像で候補行を生成する必要がある。
/// 変換不要なパスは入力と同じ文字列を返す。
export function quoteGitPathForDiff(path: string): string {
  const bytes = [...Buffer.from(path, "utf8")];
  const needsQuote = bytes.some(
    (byte) => byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x80,
  );
  if (!needsQuote) return path;
  let quoted = "";
  for (const byte of bytes) {
    if (byte === 0x22) quoted += '\\"';
    else if (byte === 0x5c) quoted += "\\\\";
    else if (byte === 0x09) quoted += "\\t";
    else if (byte === 0x0a) quoted += "\\n";
    else if (byte === 0x0d) quoted += "\\r";
    else if (byte < 0x20 || byte >= 0x80) quoted += `\\${byte.toString(8).padStart(3, "0")}`;
    else quoted += String.fromCharCode(byte);
  }
  return quoted;
}

/// diff.txt を行配列と行 Set へ 1 回だけ展開したインデックス（純粋データ）。
///
/// `diffCompletenessReasons` は truncate マーカー検査（行配列の走査）と untracked 突合
/// （行の完全一致）の両方でこのインデックスを共有する。呼び出しごとに
/// `diffRaw.split("\n")` と untracked 件数分の split を繰り返す O(F×L) を避ける。
export interface DiffTextIndex {
  lines: readonly string[];
  lineSet: ReadonlySet<string>;
}

/// diff テキストを 1 回だけ split して DiffTextIndex を作る。
export function indexDiffText(diffRaw: string): DiffTextIndex {
  const lines = diffRaw.split("\n");
  return { lines, lineSet: new Set(lines) };
}

/// diff.txt に `filePath` がファイル見出しとして現れるか（純粋関数）。
///
/// 追加・変更ファイルは `+++ b/<path>`、削除ファイルは `--- a/<path>`、リネームは
/// `rename to <path>`（C-quote 形を含む）で現れる。text の新規追加は `diff --git
/// a/<path> b/<path>` 見出しでも現れ、バイナリ・空ファイルもこの見出しだけは出力される。
/// 判定は行の完全一致で行う（部分一致だと "a.txt" が "a.txt2" に誤ヒットし、
/// 打ち切りを見逃す）。非 ASCII 等の C-quote 形と、`core.quotePath=false` の
/// 生パス形、空白パスに git が付ける末尾タブ形の両方を候補にする。
/// diffRaw ではなくインデックス（indexDiffText）を受け取り、split を呼び出しごとに
/// 繰り返さない。
export function diffContainsPath(index: DiffTextIndex, filePath: string): boolean {
  const quoted = quoteGitPathForDiff(filePath);
  const candidates = new Set<string>([
    `diff --git a/${filePath} b/${filePath}`,
    `diff --git "a/${quoted}" "b/${quoted}"`,
    `+++ b/${filePath}`,
    `+++ b/${filePath}\t`,
    `+++ "b/${quoted}"`,
    `+++ "b/${quoted}"\t`,
    `--- a/${filePath}`,
    `--- a/${filePath}\t`,
    `--- "a/${quoted}"`,
    `--- "a/${quoted}"\t`,
    `rename to ${filePath}`,
    `rename to "${quoted}"`,
    `rename from ${filePath}`,
    `rename from "${quoted}"`,
  ]);
  for (const candidate of candidates) {
    if (index.lineSet.has(candidate)) return true;
  }
  return false;
}

/// diff.txt が untracked ファイル `filePath` の差分を含むか（純粋関数）。
/// 見出し候補の生成は diffContainsPath に集約する。
export function diffContainsUntrackedFile(index: DiffTextIndex, filePath: string): boolean {
  return diffContainsPath(index, filePath);
}

/// untracked 一覧と diff.txt の出現を突合し、差分が見つからないファイルを返す（純粋関数）。
export function findMissingUntrackedFiles(
  index: DiffTextIndex,
  untrackedFiles: readonly string[],
): string[] {
  return untrackedFiles.filter((filePath) => !diffContainsUntrackedFile(index, filePath));
}

/// diff.txt の完全性検証（truncate マーカー・untracked 欠落）の理由を返す（純粋関数）。
/// 空配列なら「収集コマンドの打ち切り・失敗なし」を意味する。
/// 行の展開は 1 回だけ行い、マーカー検査と untracked 突合で同じインデックスを共有する。
export function diffCompletenessReasons(
  diffRaw: string,
  untrackedFiles: readonly string[],
): string[] {
  const index = indexDiffText(diffRaw);
  const reasons: string[] = [];
  if (index.lines.some((line) => DIFF_TRUNCATION_MARKER_PATTERN.test(line))) {
    reasons.push(
      "diff.txt に truncate マーカー（[... truncated: N lines omitted]）が含まれています。diff.txt は normalize_findings / audit と検証者が参照する SoT であり、完全な差分でなければなりません（truncate は検証者プロンプトへの転記時のみに限定してください）",
    );
  }
  const missing = findMissingUntrackedFiles(index, untrackedFiles);
  if (missing.length > 0) {
    reasons.push(
      `diff.txt に untracked ファイルの差分が ${missing.length} 件欠落しています: ${missing.join(", ")}。head 等による打ち切り、または git diff 失敗の握り潰しを検出しました。diff.txt は機械照合（normalize / audit）の SoT であり、省略せず完全に収集してください`,
    );
  }
  return reasons;
}

/// git 一覧系出力（ls-files / status / numstat）の上限。大量の変更ファイルでも
/// 切り詰めず、取得失敗（原因不明の打ち切り）と区別する。
const GIT_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/// git をクリーンな文脈（GIT_DIR 等を除去）で実行し stdout を返す。
/// 失敗は例外のまま伝播し、呼び出し元が error 理由へ変換する。
/// cwd は実行ディレクトリ（既定は process.cwd()）。
function execGit(args: string[], options: { cwd?: string; maxBuffer?: number } = {}): string {
  return String(
    execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: options.maxBuffer ?? GIT_LIST_MAX_BUFFER_BYTES,
      env: cleanGitEnv(),
      ...(options.cwd ? { cwd: options.cwd } : {}),
    }),
  );
}

/// `git ls-files --others --exclude-standard -z` を実行して untracked 一覧を返す。
///
/// collect_context の収集コマンドと同じ cwd・同じオプションで列挙し、diff.txt に
/// 現れるべき untracked パス集合の期待値を機械導出する（-z は NUL 区切りの生パス）。
/// 実行失敗は空一覧へ縮退させず理由付きで返し、呼び出し元が fail にできるようにする。
export function listUntrackedFiles(cwd?: string): { files: string[] } | { error: string } {
  try {
    return {
      files: execGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd })
        .split("\0")
        .filter((file) => file.length > 0),
    };
  } catch (error) {
    return {
      error: `git ls-files --others --exclude-standard に失敗しました: ${String(error)}`,
    };
  }
}

/// `git status --porcelain -z` を実行し、index（staged）に載っているパス一覧を返す。
///
/// collect_context の収集コマンド（working diff）と同じ index を参照し、staged 変更
/// （staged された新規ファイル・削除を含む）が diff.txt から欠落していないかを突合する
/// 期待値を機械導出する（-z は NUL 区切りの生パス）。未追跡（`??`）・無視（`!!`）・
/// worktree のみの変更（index 列が空白）は staged ではなく収集範囲の突合対象外なので
/// 含めない。リネーム / コピーは新しいパスを 1 件として返し、元パスのトークンは読み飛ばす。
/// 実行失敗は空一覧へ縮退させず理由付きで返し、呼び出し元が fail にできるようにする。
export function listStagedFiles(cwd?: string): { files: string[] } | { error: string } {
  try {
    const tokens = execGit(["status", "--porcelain", "-z"], { cwd }).split("\0");
    const files: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      index += 1;
      if (!token) continue;
      const staged = token[0];
      const worktree = token[1];
      const filePath = token.slice(3);
      if (staged === "R" || staged === "C" || worktree === "R" || worktree === "C") {
        // リネーム / コピーは `XY <new>\0<orig>\0` の 2 トークン（元パスを読み飛ばす）
        index += 1;
      }
      if (staged === " " || staged === "?" || staged === "!") continue;
      files.push(filePath);
    }
    return { files };
  } catch (error) {
    return {
      error: `git status --porcelain に失敗しました: ${String(error)}`,
    };
  }
}

/// staged（index 上）のパス一覧が diff.txt に現れることを検証する理由を返す（純粋関数）。
///
/// staged 変更は working diff ではコミット済み変更と同じ 1 ファイルブロックに畳まれるため、
/// ファイル見出し（diffContainsPath）の一致で判定する。空配列なら欠落なし。
export function missingStagedFilesReasons(
  diffRaw: string,
  stagedFiles: readonly string[],
): string[] {
  const index = indexDiffText(diffRaw);
  const missing = stagedFiles.filter((filePath) => !diffContainsPath(index, filePath));
  if (missing.length === 0) return [];
  return [
    `diff.txt に staged（index 上）の変更が ${missing.length} 件欠落しています: ${missing.join(", ")}。収集は merge-base..ワーキングツリー（committed + staged + unstaged）で行い、staged 変更（staged された新規ファイルを含む）を diff.txt から落とさないでください`,
  ];
}

/// `git diff --numstat -z` の 1 ファイル分。
/// 追加/削除行数が数値でない（バイナリ・サブモジュール等）場合は null。
export interface DiffNumstatEntry {
  path: string;
  added: number | null;
  deleted: number | null;
  /// リネーム / コピーの元パス（numstat -z の 2 パス形式のときのみ）。
  origPath?: string;
}

/// `git diff --numstat -z` の出力をパースする（純粋関数）。
///
/// -z では生パスが NUL 区切りで並び、通常エントリは `added\tdeleted\t<path>\0`、
/// リネーム / コピーは `added\tdeleted\t\0<orig>\0<new>\0` の形になる。契約外の
/// 出力は例外にせず null を返し、呼び出し元が fail-closed に扱えるようにする。
export function parseDiffNumstat(raw: string): DiffNumstatEntry[] | null {
  const tokens = raw.split("\0");
  const entries: DiffNumstatEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(token);
    if (!match) return null;
    let path = match[3];
    let origPath: string | undefined;
    if (path === "") {
      origPath = tokens[index];
      index += 1;
      path = tokens[index] ?? "";
      index += 1;
      if (!origPath || !path) return null;
    }
    entries.push({
      path,
      origPath,
      added: match[1] === "-" ? null : Number(match[1]),
      deleted: match[2] === "-" ? null : Number(match[2]),
    });
  }
  return entries;
}

/// 収集コマンドと同一の解決で `git diff --numstat -z` を実行する。
///
/// - target あり: `git diff --numstat "$base...$target"`（収集の
///   `git diff "$BASE...$TARGET"` と同一の merge-base..target 範囲）
/// - target なし: `git merge-base HEAD "$base"` を解決し、
///   `git diff --numstat <merge-base>`（収集の
///   `git diff "$(git merge-base HEAD "$BASE")"` と同一で committed + staged + unstaged を含む）
///
/// `-z` はパスを C-quote せず NUL 区切りの生パスで返すため、収集側の
/// `-c core.quotePath=false` とパス比較が直接成立する（quotePath 設定に依存しない）。
/// cwd は実行ディレクトリ（既定は process.cwd()。テストが実リポジトリを指定する）。
/// 失敗・契約外出力は空一覧へ縮退させず error を返し、呼び出し元が fail にできるようにする。
export function listDiffNumstat(
  scope: { base: string; target?: string },
  cwd?: string,
): { entries: DiffNumstatEntry[] } | { error: string } {
  try {
    let revision: string;
    if (scope.target) {
      revision = `${scope.base}...${scope.target}`;
    } else {
      const mergeBase = execGit(["merge-base", "HEAD", scope.base], { cwd }).trim();
      if (!mergeBase) {
        return {
          error: `git merge-base HEAD ${scope.base} が空の結果を返しました（base を解決できません）`,
        };
      }
      revision = mergeBase;
    }
    const entries = parseDiffNumstat(execGit(["diff", "--numstat", "-z", revision], { cwd }));
    if (!entries) {
      return {
        error:
          "git diff --numstat の出力が契約（-z の NUL 区切り `added\\tdeleted\\t<path>`）を満たしません",
      };
    }
    return { entries };
  } catch (error) {
    return { error: `git diff --numstat に失敗しました: ${String(error)}` };
  }
}

/// `git diff --numstat` のファイル別追加/削除行数と diff.txt の集計を突合する（純粋関数）。
///
/// 空配列なら一致。ファイル丸ごと欠落は `diffContainsPath` の見出し一致で、行数不一致は
/// `countDiffLinesByPath` の集計で検出し、理由を返す（呼び出し元が head 等による部分出力を
/// fail にできる）。行数を持たないエントリ（バイナリ等）は見出しの出現だけを検証する。
export function diffNumstatReasons(
  diffRaw: string,
  entries: readonly DiffNumstatEntry[],
): string[] {
  const index = indexDiffText(diffRaw);
  const counts = countDiffLinesByPath(diffRaw);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const entry of entries) {
    if (!diffContainsPath(index, entry.path)) {
      missing.push(entry.path);
      continue;
    }
    if (entry.added === null || entry.deleted === null) continue;
    const actual = counts.get(entry.path) ?? { added: 0, deleted: 0 };
    if (actual.added !== entry.added || actual.deleted !== entry.deleted) {
      mismatched.push(
        `${entry.path} (numstat +${entry.added}/-${entry.deleted}, diff.txt +${actual.added}/-${actual.deleted})`,
      );
    }
  }
  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(
      `diff.txt に git diff --numstat のファイルが ${missing.length} 件欠落しています: ${missing.join(", ")}。head 等による打ち切り、または収集範囲の不一致を検出しました。diff.txt は機械照合（normalize / audit）の SoT であり、省略せず完全に収集してください`,
    );
  }
  if (mismatched.length > 0) {
    reasons.push(
      `diff.txt のファイル別追加/削除行数が git diff --numstat と一致しません: ${mismatched.join(" / ")}。途中で打ち切られた diff.txt を SoT にしないでください`,
    );
  }
  return reasons;
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
// reviewer-outputs.json → findings.json の正規化監査 (純粋関数)
// =============================================================================

/// reviewer-outputs.json（生 findings）と findings.json（正規化後）の対応監査。
export interface FindingsNormalizationAudit {
  match: boolean;
  reasons: string[];
}

function multisetMissing(expected: string[], actual: string[]): string[] {
  const counts = new Map<string, number>();
  for (const key of actual) counts.set(key, (counts.get(key) ?? 0) + 1);
  const missing: string[] = [];
  for (const key of expected) {
    const count = counts.get(key) ?? 0;
    if (count <= 0) {
      missing.push(key);
    } else {
      counts.set(key, count - 1);
    }
  }
  return missing;
}

function describeFindingKey(key: string): string {
  return key
    .split("\u0000")
    .filter((part) => part.length > 0)
    .join(" ");
}

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

// =============================================================================
// GFM Markdown コメント本文の生成 (純粋関数)
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

/// GFM のリンク・画像記法を無効化する。`[` / `]` をバックスラッシュでエスケープし、
/// `![alt](url)` や `[text](url)` をリテラル文字列として描画させる。`\` を先に
/// エスケープすることで、元テキストの `\[` が二重エスケープで崩れない。
/// コードスパン（`` `...` ``）内は Markdown 記法が解釈されないため対象外とし、
/// `threads[]` のようなコード片の表示を変えない。
///
/// detail / suggestions は差分（攻撃者が用意し得る）を引用するため、difit UI
/// （react-markdown + remark-gfm）が画像記法として解釈すると、人間がレビューを
/// 開いた時点で外部 URL へ自動リクエストが飛ぶ。リンク記法も同様に無効化する。
function neutralizeMarkdownLinkSyntax(text: string): string {
  return text
    .split(/(`[^`]*`)/g)
    .map((part) =>
      part.length >= 2 && part.startsWith("`") && part.endsWith("`")
        ? part
        : part.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]"),
    )
    .join("");
}

/// コードスパン（`` `...` ``）内に埋め込む target（filePath / line）を無害化する。
///
/// filePath は差分（`+++ b/<path>` のパス）由来で攻撃者が用意し得る。バックティックは
/// コードスパンを閉じ、改行は後続行への任意 Markdown 注入を許すため、バックティックは
/// `'` へ置換し、改行は空白へ畳む。CommonMark のコードスパン内ではバックスラッシュ
/// エスケープが解釈されないため、`[` / `]` のエスケープは行わない（行うと
/// `src/app/[id]/page.tsx` が `src/app/\[id\]/page.tsx` として表示される）。
/// コードスパン外の生テキストには neutralizeMarkdownLinkSyntax を使う。
function sanitizeCodeSpanTarget(target: string): string {
  return target.replace(/`/g, "'").replace(/[\r\n]+/g, " ");
}

/// difit に注入する AI レビューコメント本文を GFM Markdown で生成する。
///
/// ヘッダ行の taxonomy 絵文字（`🐛 issue` / `🙋 question`）と severity（`💡 want`）は
/// `mt difit check` の taxonomy 分類（Rust 側 classify_body / is_want）が認識する契約。
/// 「対象 / 詳細 / 提案」を GFM の太字ラベルで構造化し、非対応環境でも素のテキストとして読める。
/// detail / suggestions は攻撃者由来の差分を引用し得るため生テキストとして
/// Markdown リンク・画像記法を無害化し（自動外部リクエストの防止）、対象行の filePath は
/// コードスパン内に収めてバックティック・改行だけを除く（リンク記法はスパン内で
/// 解釈されないため、エスケープするとパス表示が壊れる）。
export function formatReviewComment(input: {
  severity: Severity;
  axis: string;
  detail: string;
  filePath?: string;
  line?: number;
  suggestions?: string[];
}): { body: string } {
  const severityEmoji = SEVERITY_EMOJI[input.severity] ?? "";
  const taxonomy = input.severity === "must" ? "issue" : "question";
  const taxonomyEmoji = TAXONOMY_EMOJI[taxonomy] ?? "";
  const axisEmoji = AXIS_EMOJI[input.axis] ?? "🔍";
  const target = input.filePath
    ? input.line !== undefined
      ? `${input.filePath}:${input.line}`
      : input.filePath
    : "(ファイルレベル)";
  const lines = [
    `**${severityEmoji} ${input.severity} · ${taxonomyEmoji} ${taxonomy} · ${axisEmoji} ${input.axis}**`,
    "",
    `**対象**: ${input.filePath ? `\`${sanitizeCodeSpanTarget(target)}\`` : target}`,
    "",
    "**詳細**:",
    "",
    neutralizeMarkdownLinkSyntax(input.detail.trim()),
  ];
  if (input.suggestions && input.suggestions.length > 0) {
    lines.push("", "**提案**:", "");
    for (const suggestion of input.suggestions) {
      lines.push(`- ${neutralizeMarkdownLinkSyntax(suggestion.trim())}`);
    }
  }
  return { body: lines.join("\n") };
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

function positionToNewLine(position: unknown): number | undefined {
  if (!isRecord(position)) return undefined;
  const line = position.line;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return undefined;
  if (position.side !== "new") return undefined;
  return line;
}

/// findings.json を difit comment import 形式の JSON 配列へ変換する (純粋関数)。
///
/// 各要素は `{"type":"thread","filePath":...,"position":{"side":"new","line":...},"body":...}`。
/// body は formatReviewComment が生成する GFM Markdown（severity / taxonomy / axis を絵文字で継承）。
/// filePath なし / position なし / `side:"old"` / line 不正は機械的に除外する（diff-only 規律）。
export function buildDifitComments(findingsRaw: string | undefined): JsonRecord[] {
  // map で filePath / position を検証済みの型。mergeFindingsByProximity は filePath /
  // position を保持するため、統合後もこの型のまま扱える（再検証は到達不能なデッドコード）。
  type PositionedFinding = Finding & {
    filePath: string;
    position: { side: "new"; line: number };
  };
  const comments: JsonRecord[] = [];
  const parsed = findJsonObject(findingsRaw);
  const findingsArray: unknown[] = Array.isArray(parsed?.findings)
    ? (parsed!.findings as unknown[])
    : [];

  const normalized = findingsArray
    .filter(isRecord)
    .map((item): PositionedFinding | null => {
      const r = item as JsonRecord;
      const severity = r.severity;
      const detail = r.detail;
      const axis = r.axis;
      if (typeof axis !== "string" || !VALID_AXIS_IDS.has(axis)) return null;
      if (severity !== "must" && severity !== "should" && severity !== "want") return null;
      if (typeof detail !== "string" || !detail.trim()) return null;
      const location = optionalLocation(r);
      if (typeof location.filePath !== "string" || !location.filePath.trim()) return null;
      const line = positionToNewLine(location.position);
      if (line === undefined) return null;
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
        detail: detail.trim(),
        filePath: location.filePath.trim(),
        position: { side: "new", line },
        ...(suggestions ? { suggestions } : {}),
      };
    })
    .filter((finding): finding is PositionedFinding => finding !== null);

  const merged = mergeFindingsByProximity(normalized);

  for (const f of merged) {
    const { body } = formatReviewComment({
      severity: f.severity,
      axis: f.axis,
      detail: f.detail,
      filePath: f.filePath,
      line: f.position.line,
      suggestions: f.suggestions,
    });
    comments.push({
      type: "thread",
      filePath: f.filePath,
      position: { side: "new", line: f.position.line },
      body,
    });
  }

  return comments;
}

// =============================================================================
// difit 連携
// =============================================================================

export const DIFIT_START_KEY = "difit-start.json";
export const DIFIT_COMMENTS_KEY = "difit-comments.json";
export const DIFIT_CHECK_KEY = "difit-check.json";
export const EFFORT_KEY = "effort.json";
export const FINDINGS_KEY = "findings.json";
export const VERDICT_KEY = "verdict.json";

export interface DifitBlockingThread {
  id?: string;
  file?: string;
  line?: number | { start: number; end: number } | null;
  taxonomy?: string;
  body: string;
  replies?: string[];
}

/// difit のリビジョン選択（`CommentSelection` の JSON 表現）。
export interface DifitSelectionView {
  base: string;
  target: string;
  baseMode?: string;
}

/// 選択ドリフトの検知結果（Rust `DriftDetection` の三値）。
/// - `detected`: probe 成功かつサーバの現在選択 != 起動時選択
/// - `none`: probe 成功かつ一致（ドリフトなし）
/// - `unavailable`: probe 失敗（検知不能）。workflow は fail-closed で扱う
export type DifitDriftDetection = "detected" | "none" | "unavailable";

/// Rust の `DriftDetection` が出力し得る値（`#[serde(rename_all = "lowercase")]`）。
export const VALID_DIFIT_DRIFT_DETECTIONS: ReadonlySet<string> = new Set([
  "detected",
  "none",
  "unavailable",
]);

/// `mt difit check --dry-run` / `mt difit threads --json` の出力 JSON に載る
/// 選択ドリフト検知（Rust の `SelectionDrift` と同名の契約）。difit UI の
/// リビジョンセレクタが起動時（state.selection）と異なる場合に `detection` が
/// `"detected"` になる。probe 失敗時は `"unavailable"`（検知不能）で `current` は null。
export interface DifitSelectionDrift {
  detection: DifitDriftDetection;
  /// state に記録された起動時の選択（ゲートが読み書きするセッション）。
  expected?: DifitSelectionView;
  /// difit サーバが現在返す選択。probe 失敗時は undefined（Rust では null）。
  current?: DifitSelectionView;
}

function parseDifitSelectionView(value: unknown): DifitSelectionView | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.base !== "string" || typeof value.target !== "string") return undefined;
  return {
    base: value.base,
    target: value.target,
    ...(typeof value.baseMode === "string" ? { baseMode: value.baseMode } : {}),
  };
}

/// `selection_drift` の解釈結果（フィールド欠落と解釈不能を区別する）。
/// - `{ drift }`: 解釈できた
/// - `{ error }`: フィールドは存在するが解釈できない（契約違反）
/// - `undefined`: フィールドが存在しない（done など probe しない経路では正当）
function inspectDifitSelectionDrift(
  value: unknown,
): { drift: DifitSelectionDrift } | { error: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    return { error: "selection_drift がオブジェクトではありません" };
  }
  const detection = value.detection;
  if (typeof detection !== "string" || !VALID_DIFIT_DRIFT_DETECTIONS.has(detection)) {
    return { error: `selection_drift.detection が未知の値です: ${String(detection)}` };
  }
  const expected = parseDifitSelectionView(value.expected);
  const current = parseDifitSelectionView(value.current);
  return {
    drift: {
      detection: detection as DifitDriftDetection,
      ...(expected ? { expected } : {}),
      ...(current ? { current } : {}),
    },
  };
}

/// `mt difit check --dry-run` / `threads --json` の `selection_drift` を
/// fail-closed の契約として取り出す。
///
/// 両コマンドは選択ドリフト検知を常に含む契約（Rust 側で `Option` ではなく必須）。
/// フィールド欠落・解釈不能を「ドリフトなし」と混同せず契約違反として返し、
/// 呼び出し元（start_difit_review / collect_verdict）が通過・後始末を認めないようにする。
/// done 出力は drift を省略し得るため、この関数の対象外（ゲート判定に使わない）。
export function requireDifitSelectionDrift(output: {
  selection_drift?: DifitSelectionDrift;
  selection_drift_error?: string;
}): { drift: DifitSelectionDrift } | { violation: string } {
  if (output.selection_drift_error) {
    return {
      violation: `selection_drift を解釈できません（契約違反）: ${output.selection_drift_error}。difit CLI の出力スキーマ変更を検知しています`,
    };
  }
  if (!output.selection_drift) {
    return {
      violation:
        "selection_drift が出力にありません（契約違反）。`mt difit threads --json` / `check --dry-run` は選択ドリフト検知を常に含む契約です",
    };
  }
  return { drift: output.selection_drift };
}

function formatDifitSelectionView(view: DifitSelectionView | undefined): string {
  if (!view) return "不明";
  return `base=${view.base} target=${view.target} baseMode=${view.baseMode ?? "direct"}`;
}

/// 選択ドリフトの復旧手順を含む理由文を組み立てる。
///
/// ゲート判定とコメント追加は起動時の選択（state.selection）に固定される。
/// - `detected`: UI のセレクタを起動時の選択へ戻すまで reply / resolve は
///   ゲートが読まない別セッションへ書き込まれるため、セレクタ復旧を案内する。
/// - `unavailable`: probe 失敗で検知不能。ドリフトなしと混同せず fail-closed に
///   扱うため、`mt difit start` によるセッション復旧と UI 選択の確認を案内する。
export function describeDifitSelectionDrift(drift: DifitSelectionDrift): string {
  if (drift.detection === "unavailable") {
    return (
      "difit サーバの現在の選択を確認できませんでした（GET /api/diff の probe 失敗＝検知不能）。" +
      `ゲート判定とコメント追加は起動時の選択（${formatDifitSelectionView(drift.expected)}）に固定されていますが、` +
      "difit UI での reply / resolve が同じセッションへ向かうことは確認できていません。" +
      "`mt difit start <base-branch>` でセッションを復旧し、" +
      "difit UI のリビジョンセレクタが起動時の選択（base/target）を指していることを確認してから reply / resolve してください"
    );
  }
  if (drift.detection === "none") {
    return "difit サーバの現在の選択は起動時の選択と一致しています（ドリフトなし）";
  }
  return (
    "difit UI のリビジョンセレクタが起動時の選択と異なります" +
    `（起動時: ${formatDifitSelectionView(drift.expected)} / 現在: ${formatDifitSelectionView(drift.current)}）。` +
    "ゲート判定とコメント追加は起動時のセッションに固定されているため、" +
    "このままでは UI での reply / resolve は別セッションへ書き込まれ、ゲートに届きません。" +
    "difit UI のリビジョンセレクタを起動時の選択に戻してから resolve / reply し直してください"
  );
}

export interface DifitCheckOutput {
  passes: boolean;
  blocking_threads: DifitBlockingThread[];
  /// Rust の `selection_drift`（`threads --json` / `check` 系は常に含み、done は省略する）。
  selection_drift?: DifitSelectionDrift;
  /// `selection_drift` フィールドは存在したが解釈できなかった場合の理由（契約違反）。
  /// 「ドリフトなし」へのフォールバックを避けるため、呼び出し元は
  /// `requireDifitSelectionDrift` で fail-closed に扱う。
  selection_drift_error?: string;
}

export interface DifitThreadReply {
  author: string | null;
  body: string;
}

/// `mt difit threads --json` の `threads[]` 1 件（未 resolve スレッドの読み取りビュー）。
export interface DifitThreadView {
  id: string;
  filePath: string;
  position: unknown;
  taxonomy: string;
  blocking: boolean;
  body: string;
  author: string | null;
  replies: DifitThreadReply[];
}

/// `mt difit threads --json` の出力契約。selected 固定・未 resolve スレッドと
/// `mt difit check` と同一分類の blocking_threads を返す。
export interface DifitThreadsOutput {
  passes: boolean;
  blocking_threads: DifitBlockingThread[];
  threads: DifitThreadView[];
  /// Rust の `selection_drift`（`mt difit threads --json` の出力契約）。
  /// 解釈できない場合は selection_drift_error が設定される（fail-closed で扱う）。
  selection_drift?: DifitSelectionDrift;
  selection_drift_error?: string;
}

/// パース済みオブジェクトから `mt difit check` / `mt difit done` の契約
/// （passes / blocking_threads / selection_drift）を取り出す。
/// `fetchDifitThreads` が 1 回の JSON.parse 結果を再利用するために分離している。
function parseDifitCheckRecord(parsed: JsonRecord | undefined): DifitCheckOutput | undefined {
  if (!parsed || typeof parsed.passes !== "boolean" || !Array.isArray(parsed.blocking_threads)) {
    return undefined;
  }
  const blockingThreads: DifitBlockingThread[] = [];
  for (const value of parsed.blocking_threads) {
    if (!isRecord(value) || typeof value.body !== "string") return undefined;
    const replies = Array.isArray(value.replies)
      ? value.replies.filter((reply): reply is string => typeof reply === "string")
      : [];
    blockingThreads.push({
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.file === "string" ? { file: value.file } : {}),
      ...(typeof value.line === "number" || isRecord(value.line)
        ? { line: value.line as DifitBlockingThread["line"] }
        : {}),
      ...(typeof value.taxonomy === "string" ? { taxonomy: value.taxonomy } : {}),
      body: value.body,
      replies,
    });
  }
  const inspectedDrift = inspectDifitSelectionDrift(parsed.selection_drift);
  return {
    passes: parsed.passes,
    blocking_threads: blockingThreads,
    ...(inspectedDrift && "drift" in inspectedDrift
      ? { selection_drift: inspectedDrift.drift }
      : {}),
    // フィールド欠落（done 経路で正当）と解釈不能（契約違反）を区別して保持する。
    ...(inspectedDrift && "error" in inspectedDrift
      ? { selection_drift_error: inspectedDrift.error }
      : {}),
  };
}

/// `mt difit check` / `mt difit done` の stdout JSON をパースする。
export function parseDifitCheck(raw: string | undefined): DifitCheckOutput | undefined {
  return parseDifitCheckRecord(findJsonObject(raw));
}

/// `mt difit` stdout の上限。`mt difit threads --json` は未 resolve スレッド全件の
/// 親本文と replies を含み、指摘数・本文長に比例して増える。execFileSync の既定
/// 1 MiB では大規模レビューで切り詰められ「原因不明のパース失敗」になるため、
/// 16 MiB まで許容する。
export const DIFIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/// `mt difit` の stdout が `DIFIT_MAX_BUFFER_BYTES` を超えたことを表すエラー。
/// 切り詰められた stdout をパース失敗として扱わず、原因（出力サイズ超過）を
/// CheckResult の理由へ届けるために使う。
export class DifitOutputTooLargeError extends Error {
  constructor(args: string[]) {
    super(
      `mt difit ${args.join(" ")} の stdout が maxBuffer (${DIFIT_MAX_BUFFER_BYTES} bytes = ${DIFIT_MAX_BUFFER_BYTES / 1024 / 1024} MiB) を超えました。レビュー対象または未 resolve スレッドが多すぎるため出力を取得できません`,
    );
    this.name = "DifitOutputTooLargeError";
  }
}

export function isDifitOutputTooLargeError(error: unknown): error is DifitOutputTooLargeError {
  return error instanceof DifitOutputTooLargeError;
}

/// `mt difit` 呼び出し 1 回あたりの許容時間。workflow の check から spawnSync で
/// 同期実行されるため、difit サーバが accept したまま応答しない場合でも
/// イベントループを塞いだまま無制限にブロックしない上限を設ける。
/// (`mt difit done` は stale 復旧時に保存済みコメントを分割 HTTP POST する
/// ため、チャンク数 × HTTP タイムアウトが理論上ここに達し得る。)
export const DIFIT_COMMAND_TIMEOUT_MS = 120_000;

/// `mt difit` の stdout / stderr が `DIFIT_COMMAND_TIMEOUT_MS` 内に得られなかったことを表すエラー。
/// spawnSync の timeouts は child を kill しても result.error.code=ETIMEDOUT を返すため、
/// 切り詰められた stdout / stderr を契約出力として扱わず、原因（時間超過）を
/// CheckResult の理由へ届けるために使う。
export class DifitTimeoutError extends Error {
  constructor(args: string[]) {
    super(
      `mt difit ${args.join(" ")} が ${DIFIT_COMMAND_TIMEOUT_MS / 1000} 秒以内に応答しませんでした（timeout）。difit サーバが応答していないか、mt difit done の stale 復旧が長時間化しています`,
    );
    this.name = "DifitTimeoutError";
  }
}

export function isDifitTimeoutError(error: unknown): error is DifitTimeoutError {
  return error instanceof DifitTimeoutError;
}

/// `mt difit` の実行ファイルを起動できなかった（ENOENT / EACCES 等）ことを表すエラー。
/// 空 stdout / stderr の正常戻りとして扱うと、呼び出し元が「difit セッション不在」や
/// 「ゲート出力なし」と誤診し、実際の原因（PATH 破損・mt 不在）が CheckResult の理由から
/// 消えるため、専用エラーで原因を届ける。
export class DifitSpawnError extends Error {
  constructor(args: string[], cause: unknown) {
    const code = (cause as { code?: unknown } | null)?.code;
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `mt difit ${args.join(" ")} を起動できませんでした（spawn 失敗${typeof code === "string" ? `: ${code}` : ""}）: ${detail}。mt が PATH に無い・実行権限が無い等の環境要因を確認してください`,
    );
    this.name = "DifitSpawnError";
  }
}

export function isDifitSpawnError(error: unknown): error is DifitSpawnError {
  return error instanceof DifitSpawnError;
}

/// difit コマンド実行が投げる失敗（DifitOutputTooLargeError / DifitTimeoutError /
/// DifitSpawnError）を CheckResult / 後始末の理由メッセージへ変換する。
/// 対象外の例外は undefined を返し、呼び出し元が rethrow する。
///
/// 扱いを分けている呼び出し元（3 エラー型の追加・変更はこの関数だけを直す）:
///   1. cleanupDifitSession（本ファイル） — メッセージを `status: "error"` の理由にする
///   2. start_difit_review の check（mt-review-diff/index.ts） — メッセージを
///      `status: "fail"` の理由にする
///   3. collect_verdict の check（同） — verifyDifitDryRun 経由。round limit 経路は
///      メッセージを理由に残して人間判断（human_gate）へ継続し、通常経路は
///      `status: "error"` の理由にする
export function difitCommandFailureMessage(error: unknown): string | undefined {
  if (isDifitOutputTooLargeError(error) || isDifitTimeoutError(error) || isDifitSpawnError(error)) {
    return error.message;
  }
  return undefined;
}

function isTimeoutFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ETIMEDOUT") return true;
  return error instanceof Error && /ETIMEDOUT|timed?\s*out/i.test(error.message);
}

function isMaxBufferOverflow(error: unknown): boolean {
  // Node は ERR_CHILD_PROCESS_STDIO_MAXBUFFER、bun は ENOBUFS を返す。
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || code === "ENOBUFS") return true;
  return error instanceof Error && /maxBuffer/i.test(error.message);
}

/// `mt difit` サブコマンドの stdout / stderr。
export interface DifitCommandResult {
  stdout: string;
  stderr: string;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/// mt difit サブコマンドを実行して stdout / stderr を回収して返す。
/// exit 1 はゲートブロックなど正常系の出力を伴うため、throw せず stdout を回収する。
/// stderr は選択ドリフト警告・同一性照合エラー等の診断情報を含むため捨てずに返し、
/// 呼び出し元が CheckResult の理由 / executor フィードバックへ流せるようにする。
/// stdout が maxBuffer を超えた場合は切り詰められた stdout を返さず
/// `DifitOutputTooLargeError` を投げる（パース失敗で原因を覆い隠さない）。
/// timeoutMs 以内に応答しない場合は child を kill して `DifitTimeoutError` を投げる
/// （同期実行で workflow が無制限にブロックしない）。
/// 実行ファイルを起動できない場合（ENOENT / EACCES 等）は空出力を返さず
/// `DifitSpawnError` を投げ、原因を CheckResult の理由へ届ける。
export function runDifitCommand(
  args: string[],
  timeoutMs = DIFIT_COMMAND_TIMEOUT_MS,
): DifitCommandResult {
  const result = spawnSync("mt", ["difit", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: DIFIT_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    // bun は process.env への代入を実行パス解決に反映しないため、
    // テストの PATH 差し替えが効くよう明示的に現在の env を渡す
    env: { ...process.env },
  });
  if (isMaxBufferOverflow(result.error)) throw new DifitOutputTooLargeError(args);
  if (isTimeoutFailure(result.error)) throw new DifitTimeoutError(args);
  if (result.error) throw new DifitSpawnError(args, result.error);
  return {
    stdout: outputText(result.stdout),
    stderr: outputText(result.stderr),
  };
}

/// `mt difit` の stderr を CheckResult の理由行へ整形する（空なら空配列）。
/// 選択ドリフト警告や同一性照合エラーを握りつぶさず人間・executor へ届ける。
export function difitStderrReasons(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `mt difit stderr: ${line}`);
}

// Rust 側 `src/git/common.rs` の GIT_CONTEXT_ENV と同じ集合。
// git hook / ラッパーが設定する GIT_DIR 等が残っていると repo root の解決や
// difit の内部 git 呼び出しが実行文脈に引きずられるため除去する。
const GIT_CONTEXT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
] as const;

function cleanGitEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of GIT_CONTEXT_ENV) {
    delete env[key];
  }
  return env;
}

/// `difit-review.json` から読み取る生存判定用の最小状態。
export interface DifitReviewState {
  port: number;
  pid: number;
  /// state に記録された選択固定キー（`mt difit start` が probe した解決済み選択）。
  /// 旧 state（選択キー未記録）では undefined になり得る。
  selection?: DifitSelectionView;
}

/// `git rev-parse --show-toplevel` を Rust と同じクリーンな git 文脈
/// （GIT_DIR 等を除去）で実行し、リポジトリルートを返す。
function resolveGitRepoRoot(): string | undefined {
  try {
    const repoRoot = String(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      }),
    ).trim();
    return repoRoot || undefined;
  } catch {
    return undefined;
  }
}

/// `readDifitReviewState` の読み取り結果。
///
/// 「state 不在（ENOENT）」・「読み取り不能（EACCES / EISDIR / 競合）」・
/// 「契約違反（port / pid 不正）」を区別する。undefined に畳むと、done 後の
/// 後始末検証が読み取り失敗を『state 削除済み』と誤認して false pass し、
/// start の live 判定が一時的な読み取り障害を『セッション未起動』と誤診する。
export type DifitReviewStateRead =
  | { state: DifitReviewState }
  | { missing: true }
  | { error: string };

/// `mt difit start` が書く状態ファイル `.difit/difit-review.json`
/// （port / pid / comments / difit_args / selection）を読み、`port` が 1〜65535 の整数、
/// `pid` が正の整数である場合のみ `{state}` を返す。読み取り専用。
///
/// 旧 `tab` フィールドは表示ツール時代の互換入力であり現行スキーマには存在しない。
/// 契約として解釈せず読み飛ばす（Rust 側 `src/difit/shared.rs` の read_review_state と同じ）。
///
/// ファイル不在は `{missing: true}`、読み取り失敗・契約違反は `{error: reason}` を返し、
/// 呼び出し元（start の live 判定 / done 後始末検証）が fail にできるようにする。
///
/// `.difit` ディレクトリや state ファイルが symlink / 非通常ファイルの場合は
/// 追従せず error（fail-closed）にする。`.gitignore` の `.difit/` は末尾スラッシュの
/// ため `.difit` symlink は commit され得る。リンク先の任意ファイルを state として
/// 読むと、start の port 比較や done の後始末検証が別ディレクトリを参照する。
/// Rust 側 `src/difit/shared.rs` の read_review_state と同じ fail-closed に揃える。
export function readDifitReviewState(): DifitReviewStateRead {
  const repoRoot = resolveGitRepoRoot();
  if (!repoRoot) return { error: "git rev-parse --show-toplevel に失敗しました" };

  const dirPath = join(repoRoot, ".difit");
  try {
    const dirStat = lstatSync(dirPath);
    if (dirStat.isSymbolicLink()) {
      return {
        error: `${dirPath} が symlink のため、セッション状態を読みません（clone 先に仕込まれた細工の可能性があります）`,
      };
    }
    if (!dirStat.isDirectory()) {
      return { error: `${dirPath} がディレクトリではありません` };
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return { missing: true };
    return { error: `${dirPath} を確認できませんでした (${String(code ?? error)})` };
  }

  const statePath = join(dirPath, "difit-review.json");
  try {
    const stateStat = lstatSync(statePath);
    if (stateStat.isSymbolicLink()) {
      return {
        error: `${statePath} が symlink のため、セッション状態を読みません（リンク先の state を読み書きしない fail-closed 契約）`,
      };
    }
    if (!stateStat.isFile()) {
      return { error: `${statePath} が通常ファイルではありません` };
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return { missing: true };
    return { error: `${statePath} を確認できませんでした (${String(code ?? error)})` };
  }

  let raw: string;
  try {
    raw = readFileSync(statePath, "utf-8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOENT") return { missing: true };
    return { error: `${statePath} を読めませんでした (${String(code ?? error)})` };
  }
  const state = parseJson(raw);
  if (!isRecord(state)) {
    return { error: `${statePath} が JSON オブジェクトではありません` };
  }

  const port = state.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: `${statePath} の port が不正です: ${String(port)}` };
  }
  const pid = state.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return { error: `${statePath} の pid が不正です: ${String(pid)}` };
  }
  let selection: DifitSelectionView | undefined;
  if (state.selection !== undefined) {
    const parsed = parseDifitSelectionView(state.selection);
    if (!parsed) {
      return { error: `${statePath} の selection が不正です` };
    }
    selection = parsed;
  }
  return { state: { port, pid, ...(selection ? { selection } : {}) } };
}

/// PID のプロセスが生存しているか（signal 0 の送信可否）を返す。
/// `mt difit done` の後始末検証（state 消失に加えて記録 pid が終了したこと）に使う。
///
/// ESRCH（プロセス不在）のみ false。EPERM は対象プロセスが存在しても権限が
/// 無い場合に返るため生存（true）として扱い、孤児プロセスの見逃しを防ぐ
/// （死んだと誤認して後始末完了と判定しない fail-closed）。
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code !== "ESRCH";
  }
}

/// `cleanupDifitSession` の結果。
export interface DifitSessionCleanup {
  /// pass = `mt difit done` の後始末出力を取得し、state 消失と（控えられた場合は）
  /// 記録 pid の終了まで確認できた。error = 後始末完了を検証できない（fail-closed）。
  status: "pass" | "error";
  reasons: string[];
  /// `mt difit done` の stdout 契約出力（後始末出力が得られた場合のみ）。
  /// passes=false は「done 実行時点のゲート変化」であり後始末失敗ではない
  /// （人間が dry-run 突合後に未 resolve コメントを追加した場合等）。呼び出し元が判定する。
  done?: DifitCheckOutput;
  /// `mt difit done` の stderr を理由行へ整形したもの（空なら空配列）。
  stderr: string[];
}

/// difit セッションの後始末（`mt difit done` の実行と実効性検証）を 1 箇所に集約する。
///
/// 手順:
///   1. done の前に state を読み、記録 pid を控える（生存していれば done 後に orphan として検出する）
///   2. `mt difit done`（冪等・exit 0）を実行し、stdout のゲート出力契約を検証する
///   3. `.difit/difit-review.json` の消失を検証する（読み取り不能は『削除済み』と断定しない）
///   4. done 前に控えた pid が終了していることを検証する
///
/// collect_verdict（通過時の後始末）と mt-plan-run の release_difit_session（受容時の後始末）が
/// 同一の検証規則を使う（片側だけ pid 検証が弱い、という非対称を作らない）。
/// 呼び出し元は done を先行実行しないこと（先行実行すると pid を控えられず検証が弱くなる）。
export function cleanupDifitSession(): DifitSessionCleanup {
  const beforeRead = readDifitReviewState();
  const pidBeforeDone = "state" in beforeRead ? beforeRead.state.pid : undefined;

  let doneResult: DifitCommandResult;
  try {
    doneResult = runDifitCommand(["done"]);
  } catch (error) {
    // 振り分けは difitCommandFailureMessage に集約（呼び出し元ごとの扱いは同関数の doc）。
    const failure = difitCommandFailureMessage(error);
    if (failure === undefined) throw error;
    return { status: "error", reasons: [failure], stderr: [] };
  }
  const stderr = difitStderrReasons(doneResult.stderr);
  const done = parseDifitCheck(doneResult.stdout);
  if (!done) {
    return {
      status: "error",
      reasons: [
        "`mt difit done` が後始末出力 (passes / blocking_threads の JSON) を返しませんでした。difit セッションが残っている可能性があります",
        ...stderr,
      ],
      stderr,
    };
  }

  // 後始末の実効性を state 消失まで確認する（削除失敗の検出）。
  // 読み取り不能（EACCES / EISDIR / 競合）は「削除済み」と断定せず error にする。
  const remainingRead = readDifitReviewState();
  if ("error" in remainingRead) {
    return {
      status: "error",
      reasons: [
        `\`mt difit done\` 後の .difit/difit-review.json を読み取れません (${remainingRead.error})。後始末の完了を検証できないため error とします`,
      ],
      stderr,
    };
  }
  if ("state" in remainingRead) {
    const remaining = remainingRead.state;
    return {
      status: "error",
      reasons: [
        `\`mt difit done\` 実行後も .difit/difit-review.json が残っています (port=${remaining.port}, pid=${remaining.pid})。後始末が完了していません`,
      ],
      stderr,
    };
  }
  // state 削除に加えて、記録 pid が終了していることまで確認する
  // （kill が同一性未確認でスキップされた orphan の検出）。
  if (pidBeforeDone !== undefined && isProcessAlive(pidBeforeDone)) {
    return {
      status: "error",
      reasons: [
        `\`mt difit done\` 実行後も difit プロセス (pid=${pidBeforeDone}) が生存しています。後始末が完了しておらず、orphan プロセスが残っている可能性があります。\`mt difit status\` で確認してください`,
      ],
      stderr,
    };
  }

  return {
    status: "pass",
    reasons: [
      pidBeforeDone === undefined
        ? "difit session released (state removed)"
        : `difit session released (state removed, pid=${pidBeforeDone} exited)`,
    ],
    done,
    stderr,
  };
}

/// `mt difit threads --json` の実行・パース結果。
export interface DifitThreadsFetchResult {
  /// stdout が契約（passes / blocking_threads / threads）を満たす場合のみ設定される。
  /// コマンド失敗・契約違反時は undefined（unpinned な `difit comment get` へは
  /// フォールバックしない。無音 pass を避ける）。
  output?: DifitThreadsOutput;
  /// コマンドの stderr（選択ドリフト警告・同一性照合エラー等）。成功・失敗を
  /// 問わず保持し、呼び出し元が CheckResult の理由へ流せるようにする。
  stderr: string;
}

/// `mt difit threads --json` を実行し、state に固定された選択で未 resolve スレッドを
/// 読み取る（read-only）。サーバ状態・state ファイルは変更しない。
///
/// `mt difit threads --json` は state 不在・選択キー未記録・サーバ不応答・
/// 同一性照合失敗で非 0 exit し、stdout を返さない。その場合 output は undefined。
/// stdout が maxBuffer を超えた場合のみ `DifitOutputTooLargeError` を投げる
/// （呼び出し元が原因を CheckResult の理由として届けられるようにする）。
export function fetchDifitThreads(): DifitThreadsFetchResult {
  const result = runDifitCommand(["threads", "--json"]);
  // 最大級の入力（未 resolve 全件 + replies）を 2 回フルパースしないよう、
  // JSON.parse は findJsonObject の 1 回に統一し、gate 契約の取り出しも
  // その結果を再利用する。
  const parsed = findJsonObject(result.stdout);
  const gate = parseDifitCheckRecord(parsed);
  if (!gate || !parsed || !Array.isArray(parsed.threads)) return { stderr: result.stderr };

  const threads: DifitThreadView[] = [];
  for (const value of parsed.threads) {
    if (!isRecord(value)) return { stderr: result.stderr };
    const id = value.id;
    const filePath = value.filePath;
    const taxonomy = value.taxonomy;
    const blocking = value.blocking;
    const body = value.body;
    if (
      typeof id !== "string" ||
      typeof filePath !== "string" ||
      typeof taxonomy !== "string" ||
      typeof blocking !== "boolean" ||
      typeof body !== "string"
    ) {
      return { stderr: result.stderr };
    }
    if (!Array.isArray(value.replies)) return { stderr: result.stderr };
    const replies: DifitThreadReply[] = [];
    for (const reply of value.replies) {
      if (!isRecord(reply) || typeof reply.body !== "string") return { stderr: result.stderr };
      replies.push({
        author: typeof reply.author === "string" ? reply.author : null,
        body: reply.body,
      });
    }
    threads.push({
      id,
      filePath,
      position: value.position ?? null,
      taxonomy,
      blocking,
      body,
      author: typeof value.author === "string" ? value.author : null,
      replies,
    });
  }

  return {
    output: {
      passes: gate.passes,
      blocking_threads: gate.blocking_threads,
      threads,
      ...(gate.selection_drift ? { selection_drift: gate.selection_drift } : {}),
      ...(gate.selection_drift_error ? { selection_drift_error: gate.selection_drift_error } : {}),
    },
    stderr: result.stderr,
  };
}

/// blocking_threads を daemon 出力と verdict の間で突合するための正規化文字列。
///
/// 配列順と省略された任意フィールド（id / file / line / taxonomy / replies）の
/// 差を吸収しつつ、内容が 1 つでも異なれば文字列も異なる。並び替えキーは
/// id（なければ file+line+body）で安定させる。
export function canonicalizeDifitThreads(threads: DifitBlockingThread[]): string {
  const normalized = threads.map((thread) => ({
    id: thread.id ?? "",
    file: thread.file ?? "",
    line: thread.line ?? null,
    taxonomy: thread.taxonomy ?? "",
    body: thread.body,
    replies: thread.replies ?? [],
  }));
  normalized.sort((a, b) => {
    const keyA = a.id || `${a.file}\u0000${JSON.stringify(a.line)}\u0000${a.body}`;
    const keyB = b.id || `${b.file}\u0000${JSON.stringify(b.line)}\u0000${b.body}`;
    return keyA.localeCompare(keyB);
  });
  return JSON.stringify(normalized);
}

/// difit comment import 1 件を突合キー（type / filePath / position.side / position.line / body）へ
/// 正規化する。生成側（buildDifitComments）と保存側（difit-comments.json）の差分検出に使う。
/// `type` と `position.side` を含めることで、side 改変（new → old）や type 改変も
/// キー不一致として検出する。キーを生成できない要素は invalidReason を返し、
/// 呼び出し元が読み飛ばさず fail にできるようにする。
function difitCommentKey(value: unknown): { key: string } | { invalidReason: string } {
  if (!isRecord(value)) return { invalidReason: "not an object" };
  const reasons: string[] = [];
  const type = value.type;
  const filePath = value.filePath;
  const position = isRecord(value.position) ? value.position : undefined;
  const side = position?.side;
  const line = position?.line;
  const body = value.body;
  if (typeof type !== "string" || !type.trim()) reasons.push("type");
  if (typeof filePath !== "string" || !filePath.trim()) reasons.push("filePath");
  if (side !== "new" && side !== "old") reasons.push("position.side");
  if (typeof line !== "number" || !Number.isInteger(line)) reasons.push("position.line");
  if (typeof body !== "string") reasons.push("body");
  if (reasons.length > 0) return { invalidReason: reasons.join("/") };
  return { key: `${type}\u0000${filePath}\u0000${side}\u0000${line}\u0000${body}` };
}

function describeDifitCommentKey(key: string): string {
  const [type, filePath, side, line, body] = key.split("\u0000");
  const excerpt = body.length > 60 ? `${body.slice(0, 60)}…` : body;
  return `${type} ${filePath}:${line} [${side}] (${excerpt.replace(/\n/g, " ")})`;
}

/// `buildDifitComments(findings.json)` の期待出力と difit-comments.json を
/// 正規化比較する（純粋関数）。findings から 1 件でも落ちた部分集合・改変・余剰・
/// キー生成不能要素を検出し、欠落を可視化する。difit への注入前に normalize_findings が使う。
export function diffDifitComments(
  expected: unknown[],
  actual: unknown,
): { match: boolean; missing: string[]; unexpected: string[]; invalid: string[] } {
  // キー生成不能要素は invalid に記録する（読み飛ばさない）。invalid が空であることが
  // 「配列長とキー総数の一致」を意味し、position なしの余剰要素等を fail に落とす。
  const invalid: string[] = [];
  const countKeys = (values: unknown[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const [index, value] of values.entries()) {
      const result = difitCommentKey(value);
      if ("invalidReason" in result) {
        invalid.push(`[${index}] ${result.invalidReason}`);
        continue;
      }
      counts.set(result.key, (counts.get(result.key) ?? 0) + 1);
    }
    return counts;
  };

  const expectedCounts = countKeys(expected);
  const actualValues = Array.isArray(actual) ? actual : [];
  const actualCounts = countKeys(actualValues);

  const missing: string[] = [];
  for (const [key, count] of expectedCounts) {
    const actualCount = actualCounts.get(key) ?? 0;
    if (actualCount < count) missing.push(describeDifitCommentKey(key));
  }
  const unexpected: string[] = [];
  for (const [key, count] of actualCounts) {
    const expectedCount = expectedCounts.get(key) ?? 0;
    if (count > expectedCount) unexpected.push(describeDifitCommentKey(key));
  }

  return {
    match:
      Array.isArray(actual) &&
      invalid.length === 0 &&
      missing.length === 0 &&
      unexpected.length === 0,
    missing,
    unexpected,
    invalid,
  };
}

/// `difit-comments.json`（注入側）の各コメントが `mt difit threads --json` の
/// `threads[]`（選択固定・read-only のサーバ実体）に `{filePath, position.side,
/// position.line, body}` の組の multiset として存在することを検証する（純粋関数）。
///
/// start_difit_review の再入では、サーバに前ラウンドの未 resolve スレッドや人間
/// コメントが残るため、サーバ側の余剰は許容する（containment 検証）。注入側の
/// 欠落（同一 body の片方欠落を含む）・位置 / side の差し替え・キー生成不能を
/// missing / invalid として検出する。サーバ側でキー生成できない要素（人間の範囲
/// コメント等）は照合対象外とする（一致すべき注入コメントは常に valid な位置を持つ）。
export function diffDifitCommentPresence(
  expected: unknown[],
  actualThreads: readonly DifitThreadView[],
): { match: boolean; missing: string[]; invalid: string[] } {
  const invalid: string[] = [];
  const expectedCounts = new Map<string, number>();
  for (const [index, value] of expected.entries()) {
    const result = difitCommentKey(value);
    if ("invalidReason" in result) {
      invalid.push(`[${index}] ${result.invalidReason}`);
      continue;
    }
    expectedCounts.set(result.key, (expectedCounts.get(result.key) ?? 0) + 1);
  }

  const actualCounts = new Map<string, number>();
  for (const thread of actualThreads) {
    const result = difitCommentKey({
      type: "thread",
      filePath: thread.filePath,
      position: thread.position,
      body: thread.body,
    });
    if ("invalidReason" in result) continue;
    actualCounts.set(result.key, (actualCounts.get(result.key) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const [key, count] of expectedCounts) {
    if ((actualCounts.get(key) ?? 0) < count) missing.push(describeDifitCommentKey(key));
  }

  return {
    match: invalid.length === 0 && missing.length === 0,
    missing,
    invalid,
  };
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

/// effort.json（parse 済み）の機械検証（純粋関数）。
///
/// mt-review-diff の resolve_effort check と mt-plan-run の resolve_effort override が
/// 同じ写像（width / depth / base / target / round）を使う。plan-run の継続再入
/// （round_limit_gate の revise で execute_work の check が round を +1 した後）だけは
/// round > REVIEW_ROUND_LIMIT を人間が選んだ継続として許容するため、
/// `options.allowRoundOverflow` で round の超過のみを pass（overflow=true）へ畳む。
/// round 以外の契約（width / depth / base / target）は常に同じ判定を返す。
///
/// round は「1 以上の整数」で必須（欠落・0・小数・文字列は fail）。round の検証は
/// この関数が SoT であり、advanceReviewRound / advanceReviewRoundOnReentry /
/// collect_context check / normalize_findings の round 照合はすべてこの結果を使う
/// （サイトごとに合否が割れる手書き検証を置かない）。
export type EffortValidation =
  | { status: "pass"; width: Width; depth: Depth; round: number; overflow: boolean }
  | { status: "fail"; reasons: string[] }
  | { status: "error"; reasons: string[] };

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

/// effort.json の base 未指定時に collect_context / `mt difit start` が使う既定 base を
/// 解決する（`origin/HEAD` のブランチ名 → 失敗時 `main`）。
/// base が明示されていれば trim してそのまま返す（git 実行なし）。
export function resolveEffectiveEffortBase(base?: unknown): string {
  if (typeof base === "string" && base.trim()) return base.trim();
  try {
    const out = String(
      execFileSync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      }),
    ).trim();
    const name = out.replace(/^origin\//, "");
    if (name) return name;
  } catch {
    // origin/HEAD が無い・git 実行失敗時は main（collect_context と同じ既定）
  }
  return "main";
}

/// difit の解決済み commitish（full hash）から短縮表示を作る。
/// difit 本体（`dist/cli/utils.js` の `shortHash`）と同じく先頭 7 文字を使う
/// （`git rev-parse --short` は曖昧さ回避で 7 文字を超えることがあり一致しない）。
/// この写像は difit 配布物の shortHash に依存するため、mt-review-helpers.test.ts の
/// parity テスト（difit dist の shortHash との一致検証）で固定する。
function hashPrefix(fullHash: string): string | undefined {
  const hash = fullHash.trim().split("\n").pop()?.trim() ?? "";
  return hash ? hash.slice(0, 7) : undefined;
}

/// `git rev-parse <ref>` の full hash から difit 短縮表示を作る。
function resolveGitRevPrefix(ref: string): string | undefined {
  try {
    const out = String(
      execFileSync("git", ["rev-parse", ref], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      }),
    );
    return hashPrefix(out);
  } catch {
    return undefined;
  }
}

/// `git merge-base <a> <b>` の full hash から difit 短縮表示を作る。
function resolveGitMergeBasePrefix(a: string, b: string): string | undefined {
  try {
    const out = String(
      execFileSync("git", ["merge-base", a, b], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanGitEnv(),
      }),
    );
    return hashPrefix(out);
  } catch {
    return undefined;
  }
}

/// effort.json の base/target から、`mt difit start` が提示すべき選択（state.selection の期待値）を
/// 解決する（git 実行を伴う）。
///
/// - target なし: `mt difit start <base>` → `. <base> --merge-base`。
///   選択は base=merge-base(H, HEAD)、target=`.`（ワーキングディレクトリ）。
///   これは collect_context の `git diff "$(git merge-base HEAD "$BASE")"`（committed +
///   staged + unstaged。difit の `.` 提示 = `git diff <merge-base>` と同じ範囲）と一致する。
/// - target あり: `mt difit start <target> <base> --merge-base` → 選択は
///   base=merge-base(target, base)、target=<target>。これは collect_context の
///   `git diff <base>...<target>` と同じ範囲（difit の第2引数が compare-with=base のため、
///   引数順は target が先）。
///
/// 検証は「提示範囲 = 検証対象範囲」というゲートの前提を機械的に固定する。
/// target を提示できない起動（単独 base の変換）をした場合、ここで不一致になる。
export function expectedDifitSelection(
  base: string,
  target?: string,
): { expected: DifitSelectionView } | { error: string } {
  if (target) {
    const expectedBase = resolveGitMergeBasePrefix(target, base);
    const expectedTarget = resolveGitRevPrefix(target);
    if (!expectedBase || !expectedTarget) {
      return {
        error: `difit の選択（base=${base}, target=${target}）を git で解決できませんでした。ref が存在するか確認してください`,
      };
    }
    return { expected: { base: expectedBase, target: expectedTarget, baseMode: "merge-base" } };
  }
  const expectedBase = resolveGitMergeBasePrefix("HEAD", base);
  if (!expectedBase) {
    return {
      error: `difit の選択（base=${base}）を git で解決できませんでした。ref が存在するか確認してください`,
    };
  }
  return { expected: { base: expectedBase, target: ".", baseMode: "merge-base" } };
}

function formatDifitSelectionMismatch(actual: DifitSelectionView | undefined): string {
  if (!actual) return "未記録";
  return `base=${actual.base} target=${actual.target} baseMode=${actual.baseMode ?? "direct"}`;
}

/// state.selection と effort.json 由来の期待選択の一致を検証する（純粋関数）。
/// 不一致理由を返す（一致なら undefined）。差分提示範囲のドリフトを fail-closed に扱う。
///
/// 期待選択（短縮ハッシュの桁数・merge-base の解決基準）は difit 内部実装の写経であり、
/// difit 側の解決形式が変わると state.selection と一致しなくなる。不一致時は
/// 「difit 側の解決形式変更の可能性」を理由に含め、parity テスト（difit dist の
/// shortHash との比較）で検知できることを案内する。
export function validateDifitSelection(
  actual: DifitSelectionView | undefined,
  expected: DifitSelectionView,
): string | undefined {
  if (!actual) {
    return "difit state に selection（選択固定キー）が記録されていません。選択固定の契約を満たすセッションを `mt difit start` で開始し直してください";
  }
  if (
    actual.baseMode === "merge-base" &&
    actual.base === expected.base &&
    actual.target === expected.target
  ) {
    return undefined;
  }
  return `difit の選択が effort.json の base/target と一致しません（state: ${formatDifitSelectionMismatch(actual)} / 期待: ${formatDifitSelectionView(expected)}）。検証対象の diff.txt と difit に提示された差分が乖離しているため fail とします。期待値は difit 内部の解決形式（短縮ハッシュ先頭 7 文字・merge-base 基準）の写経であり、difit 側の解決形式変更の可能性がある場合は parity テスト（_shared/mt-review-helpers.test.ts）と difit CLI の出力を確認してください`;
}

/// difit 由来の動的文字列をコードフェンスで隔離する決定論的前処理（純粋関数）。
/// blocking_threads の原文維持のため行頭 `#` のエスケープではなくフェンス隔離を優先する。
/// feedback 内に ``` が含まれる場合は 4 連フェンスで囲み、フェンスの早期終了を防ぐ。
export function isolateDifitFeedback(feedback: string): string {
  const fence = feedback.includes("```") ? "````" : "```";
  return `${fence}markdown\n${feedback}\n${fence}`;
}
