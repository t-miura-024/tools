/**
 * artifact-check.ts — tado ワークフロー横断の成果物チェック（統一最低ライン）。
 *
 * 全生成ステップの check に強制する最低ライン:
 *   1. 申告義務: 期待キーが report 時の artifacts に申告されていること（未申告は fail）
 *   2. 申告パス正規性: 申告パスが正典パス（既定は sessionDir/<key>）と一致すること
 *   3. 実在: 申告パスにファイルが存在すること
 *   4. 非空: 内容が空でないこと
 *   5. 形式: form に応じた検証（json → パース成功 + 必須キー / markdown → 必須見出し）
 *
 * すべて純粋関数（fs 読み取りと決定論的判定のみ）で実装する。LLM の恣意的な
 * 再解釈は許さない方針（mt-review-diff の純粋関数規律と同一）。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPathInside } from "tado/artifacts";
import type { ArtifactRecord, CheckCtx, CheckResult } from "tado";

export type ArtifactForm = "json" | "markdown" | "text";

/** ステップが成果物ごとに宣言する期待。省略項目は検証しない。 */
export interface ArtifactExpectation {
  /** report 時の artifacts に要求する key（= 正典ファイル名を想定） */
  key: string;
  form: ArtifactForm;
  /** json（オブジェクト）: トップレベルに必須のキー */
  keys?: string[];
  /** json: 配列であることの要求と最小要素数 */
  minItems?: number;
  /** json: 配列の全要素に必須のキー（配列要素がオブジェクトの場合） */
  itemKeys?: string[];
  /** markdown: 存在必須の見出し（`#` 接頭辞は任意。例: "## 完了条件"） */
  sections?: string[];
  /** text の許容パターン（例: /^[0-9]+$/） */
  pattern?: RegExp;
  /** markdown/text の内容に必須のパターン（例: effort コメント） */
  patterns?: RegExp[];
  /** 正典パス。既定は join(sessionDir, key) */
  path?: string;
}

/** 申告レコードは retry で累積するため、同一キーの最後（最新）の申告を正とする。 */
export function lastArtifactRecord(
  artifacts: ArtifactRecord[],
  key: string,
): ArtifactRecord | undefined {
  let found: ArtifactRecord | undefined;
  for (const record of artifacts) {
    if (record.artifactKey === key) found = record;
  }
  return found;
}

/** 申告された成果物のパス（正）を返す。plan_number のようにパス欄に値を格納するキーにも使う。 */
export function reportedArtifactPath(artifacts: ArtifactRecord[], key: string): string | undefined {
  return lastArtifactRecord(artifacts, key)?.filePath;
}

function missingJsonKeys(parsed: unknown, keys: string[]): string[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return keys;
  const record = parsed as Record<string, unknown>;
  return keys.filter((k) => !(k in record));
}

/** json 形式の中身検証。違反理由の配列を返す（空なら合格）。 */
export function validateJsonContent(content: string, expectation: ArtifactExpectation): string[] {
  const reasons: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [`${expectation.key}: invalid JSON`];
  }
  if (expectation.minItems !== undefined) {
    if (!Array.isArray(parsed)) {
      reasons.push(`${expectation.key}: expected a JSON array`);
    } else if (parsed.length < expectation.minItems) {
      reasons.push(
        `${expectation.key}: expected at least ${expectation.minItems} items, got ${parsed.length}`,
      );
    }
  }
  if (expectation.keys) {
    const missing = missingJsonKeys(parsed, expectation.keys);
    if (missing.length > 0) {
      reasons.push(`${expectation.key}: missing required keys: ${missing.join(", ")}`);
    }
  }
  if (expectation.itemKeys) {
    if (!Array.isArray(parsed)) {
      reasons.push(`${expectation.key}: expected a JSON array`);
    } else {
      parsed.forEach((item, i) => {
        const missing = missingJsonKeys(item, expectation.itemKeys!);
        if (missing.length > 0) {
          reasons.push(`${expectation.key}[${i}]: missing required keys: ${missing.join(", ")}`);
        }
      });
    }
  }
  return reasons;
}

/** markdown 形式の中身検証。違反理由の配列を返す（空なら合格）。 */
export function validateMarkdownContent(
  content: string,
  expectation: ArtifactExpectation,
): string[] {
  const reasons: string[] = [];
  for (const section of expectation.sections ?? []) {
    // 見出しレベルは問わず、見出しテキストの一致のみを検証する
    const title = section.replace(/^#+\s*/, "");
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const heading = new RegExp(`^#{1,6}\\s*${escaped}\\s*$`, "m");
    if (!heading.test(content)) {
      reasons.push(`${expectation.key}: missing required section: ${section}`);
    }
  }
  return reasons;
}

/**
 * 統一最低ラインの複合ヘルパー。D7/D15 の判定を一括で行う。
 * 期待は複数渡せて、1 件でも違反があれば fail（理由は全件返す）。
 */
export function requireStepArtifacts(
  ctx: Pick<CheckCtx, "artifacts" | "sessionDir">,
  expectations: ArtifactExpectation[],
): CheckResult {
  const reasons: string[] = [];
  for (const expectation of expectations) {
    const record = lastArtifactRecord(ctx.artifacts, expectation.key);
    if (!record) {
      reasons.push(`"${expectation.key}" is not reported — report 時の artifacts に申告すること`);
      continue;
    }
    const expectedPath = resolve(expectation.path ?? join(ctx.sessionDir, expectation.key));
    const reportedPath = resolve(record.filePath);
    if (reportedPath !== expectedPath) {
      reasons.push(
        `"${expectation.key}": path mismatch (reported: ${record.filePath}, expected: ${expectedPath})`,
      );
    }
    if (!isPathInside(ctx.sessionDir, reportedPath)) {
      reasons.push(`"${expectation.key}": path outside session directory`);
      continue;
    }
    let content: string;
    try {
      content = readFileSync(reportedPath, "utf-8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      reasons.push(
        code === "ENOENT"
          ? `"${expectation.key}": file not found at ${record.filePath}`
          : `"${expectation.key}": read error (${String(e)})`,
      );
      continue;
    }
    if (content.trim().length === 0) {
      reasons.push(`"${expectation.key}": file is empty`);
      continue;
    }
    if (expectation.form === "json") {
      reasons.push(...validateJsonContent(content, expectation));
    } else if (expectation.form === "markdown") {
      reasons.push(...validateMarkdownContent(content, expectation));
    } else {
      // text: pattern があれば内容文字列に適用する
      if (expectation.pattern && !expectation.pattern.test(content.trim())) {
        reasons.push(`"${expectation.key}": content does not match required pattern`);
      }
    }
    for (const pattern of expectation.patterns ?? []) {
      if (!pattern.test(content)) {
        reasons.push(`"${expectation.key}": content does not match required pattern (${pattern})`);
      }
    }
  }
  return reasons.length > 0 ? { status: "fail", reasons } : { status: "pass", reasons: [] };
}
