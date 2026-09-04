import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ArtifactRecord, CheckCtx } from "tado";
import { requireStepArtifacts } from "./artifact-check";

function makeCtx(sessionDir: string, artifacts: ArtifactRecord[]): CheckCtx {
  // attemptResult は最低ライン判定に使わないため、型を満たす最小値を入れる
  return { sessionDir, artifacts, attemptResult: { status: "completed" } };
}

function record(key: string, filePath: string): ArtifactRecord {
  return {
    id: 0,
    sessionId: "ses_test",
    stepKey: "step",
    artifactKey: key,
    filePath,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function write(sessionDir: string, name: string, content: string): string {
  const p = path.join(sessionDir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("requireStepArtifacts", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-check-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("pass: 申告・実在・非空・形式をすべて満たす", () => {
    const p = write(tmp, "data.json", '{"a": 1, "list": [1, 2]}');
    const result = requireStepArtifacts(makeCtx(tmp, [record("data.json", p)]), [
      { key: "data.json", form: "json", keys: ["a", "list"] },
    ]);
    expect(result.status).toBe("pass");
    expect(result.reasons).toEqual([]);
  });

  it("pass: itemKeys を満たす配列", () => {
    const p = write(tmp, "list.json", '[{"id": 1, "title": "t"}, {"id": 2, "title": "u"}]');
    const result = requireStepArtifacts(makeCtx(tmp, [record("list.json", p)]), [
      { key: "list.json", form: "json", minItems: 2, itemKeys: ["id", "title"] },
    ]);
    expect(result.status).toBe("pass");
  });

  it("fail: 申告漏れ", () => {
    const result = requireStepArtifacts(makeCtx(tmp, []), [
      { key: "report.md", form: "markdown", sections: ["## 要約"] },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons[0]).toContain("not reported");
  });

  it("fail: ファイル未存在", () => {
    const result = requireStepArtifacts(
      makeCtx(tmp, [record("report.md", path.join(tmp, "report.md"))]),
      [{ key: "report.md", form: "markdown" }],
    );
    expect(result.status).toBe("fail");
    expect(result.reasons[0]).toContain("file not found");
  });

  it("fail: 空ファイル", () => {
    const p = write(tmp, "out.txt", "   \n");
    const result = requireStepArtifacts(makeCtx(tmp, [record("out.txt", p)]), [
      { key: "out.txt", form: "text" },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons[0]).toContain("empty");
  });

  it("fail: 申告パスが正典パスと不一致", () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-check-other-"));
    const p = write(otherDir, "issue-body.md", "# body");
    const result = requireStepArtifacts(makeCtx(tmp, [record("issue-body.md", p)]), [
      { key: "issue-body.md", form: "markdown" },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("path mismatch");
    expect(result.reasons.join("\n")).toContain("outside session directory");
    fs.rmSync(otherDir, { recursive: true, force: true });
  });

  it("fail: セッション外パス（パストラバーサル）", () => {
    const result = requireStepArtifacts(makeCtx(tmp, [record("secret", "/etc/passwd")]), [
      { key: "secret", form: "text" },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("outside session directory");
  });

  it("fail: JSON パース失敗", () => {
    const p = write(tmp, "data.json", "{ not json");
    const result = requireStepArtifacts(makeCtx(tmp, [record("data.json", p)]), [
      { key: "data.json", form: "json" },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("invalid JSON");
  });

  it("fail: json 必須キー欠落", () => {
    const p = write(tmp, "data.json", '{"a": 1}');
    const result = requireStepArtifacts(makeCtx(tmp, [record("data.json", p)]), [
      { key: "data.json", form: "json", keys: ["a", "b"] },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("missing required keys: b");
  });

  it("fail: minItems 未満", () => {
    const p = write(tmp, "list.json", '[{"id": 1}]');
    const result = requireStepArtifacts(makeCtx(tmp, [record("list.json", p)]), [
      { key: "list.json", form: "json", minItems: 3 },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("at least 3");
  });

  it("fail: markdown 必須見出し欠落", () => {
    const p = write(tmp, "report.md", "## 要約\n\n本文\n");
    const result = requireStepArtifacts(makeCtx(tmp, [record("report.md", p)]), [
      { key: "report.md", form: "markdown", sections: ["## 要約", "## 詳細"] },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("missing required section: ## 詳細");
  });

  it("pass: markdown 見出しは任意の見出しレベル数を許容", () => {
    const p = write(tmp, "report.md", "### 要約\n\n本文\n");
    const result = requireStepArtifacts(makeCtx(tmp, [record("report.md", p)]), [
      { key: "report.md", form: "markdown", sections: ["## 要約"] },
    ]);
    expect(result.status).toBe("pass");
  });

  it("fail: text pattern 不一致", () => {
    const p = write(tmp, "issue-number.txt", "abc");
    const result = requireStepArtifacts(makeCtx(tmp, [record("issue-number.txt", p)]), [
      { key: "issue-number.txt", form: "text", pattern: /^[0-9]+$/ },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.join("\n")).toContain("pattern");
  });

  it("pass: 同一キーの再申告（リトライ）では最後の申告を正とする", () => {
    const old = write(tmp, "issue-body.md", "## 古い");
    const newest = write(tmp, "issue-body.md", "## 新しい");
    // 旧申告は失敗アテンプトのもの。同じパスでも、後の申告を参照する
    const result = requireStepArtifacts(
      makeCtx(tmp, [record("issue-body.md", old), record("issue-body.md", newest)]),
      [{ key: "issue-body.md", form: "markdown", sections: ["## 新しい"] }],
    );
    expect(result.status).toBe("pass");
  });

  it("fail: 理由は全件集約する", () => {
    const p = write(tmp, "a.json", "{}");
    const result = requireStepArtifacts(makeCtx(tmp, [record("a.json", p)]), [
      { key: "a.json", form: "json", keys: ["x"] },
      { key: "b.json", form: "json" },
    ]);
    expect(result.status).toBe("fail");
    expect(result.reasons.length).toBe(2);
  });
});
