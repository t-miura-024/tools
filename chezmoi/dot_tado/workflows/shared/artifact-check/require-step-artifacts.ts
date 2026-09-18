/**
 * artifact-check — tado ワークフロー横断の成果物チェック（統一最低ライン）。
 *
 * 全生成ステップの check に強制する最低ライン:
 *   1. 申告義務: 期待キーが report 時の artifacts に申告されていること（未申告は fail）
 *   2. 申告パス正規性: 申告パスが正典パス（既定は sessionDir/<key>）と一致すること
 *   3. 実在: 申告パスにファイルが存在すること
 *   4. 非空: 内容が空でないこと
 *   5. 形式: form に応じた検証（json → パース成功 + 必須キー / markdown → 必須見出し）
 *
 * すべて純粋関数（fs 読み取りと決定論的判定のみ）で実装する。LLM の恣意的な
 * 再解釈は許さない方針（review-diff の純粋関数規律と同一）。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPathInside } from "tado/artifacts";
import type { CheckCtx, CheckResult } from "tado";
import type { ArtifactExpectation } from "./types";
import { lastArtifactRecord } from "./last-artifact-record";
import { validateJsonContent } from "./validate-json-content";
import { validateMarkdownContent } from "./validate-markdown-content";

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
