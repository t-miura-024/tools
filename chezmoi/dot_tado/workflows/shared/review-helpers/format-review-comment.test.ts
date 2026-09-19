import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatReviewComment } from "./format-review-comment.ts";

describe("formatReviewComment (対象行の無害化)", () => {
  test("filePath のバックティックでコードスパンを閉じ、画像記法を注入できない", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "実際の詳細",
      filePath: "src/a`.ts![x](https://evil.example/p.png)",
      line: 7,
    });

    // バックティックは `'` へ置換され、コードスパンは 1 組のみ
    // （filePath のバックティックで閉じられない。画像記法はスパン内で解釈されない）
    const targetLine = result.body.split("\n").find((line) => line.startsWith("**対象**:"))!;
    expect(targetLine.match(/`/g) ?? []).toHaveLength(2);
    expect(targetLine).toBe("**対象**: `src/a'.ts![x](https://evil.example/p.png):7`");
  });

  test("filePath の改行で対象行以降へ偽の Markdown 行を注入できない", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "実際の詳細",
      filePath: "src/a.ts\n**詳細**: 偽\n![img](https://evil.example/p.png)",
      line: 7,
    });

    const targetLine = result.body.split("\n").find((line) => line.startsWith("**対象**:"))!;
    // 改行は空白に畳まれ、偽の行が独立して現れない（画像記法もスパン内に閉じる）
    expect(targetLine).toContain("src/a.ts **詳細**: 偽 ![img](https://evil.example/p.png):7");
    expect(targetLine).not.toContain("\n");
    expect(result.body.split("\n").filter((line) => line === "**詳細**: 偽")).toHaveLength(0);
    // テンプレートの詳細ラベルは 1 つだけ（注入された偽ラベルは対象行内に畳まれる）
    expect(result.body.split("\n").filter((line) => line.startsWith("**詳細**:"))).toHaveLength(1);
    // 画像記法として解釈される行が対象行以外に現れない
    expect(result.body.split("\n").filter((line) => line.includes("![img]("))).toEqual([
      targetLine,
    ]);
  });

  test("[id] を含む filePath はコードスパン内でバックスラッシュエスケープせずに表示する（回帰）", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "dynamic route のパス",
      filePath: "src/app/[id]/page.tsx",
      line: 3,
    });

    // CommonMark のコードスパン内ではバックスラッシュエスケープが解釈されないため、
    // `\[id\]` と表示される退行を固定する
    expect(result.body).toContain("**対象**: `src/app/[id]/page.tsx:3`");
    expect(result.body).not.toContain("\\[id\\]");
  });

  test("detail の生テキストはリンク・画像記法を無害化する（対象行のコードスパンと分離）", () => {
    const result = formatReviewComment({
      severity: "must",
      axis: "logic-2",
      detail: "![img](https://evil.example/p.png) と [link](https://evil.example/)",
      filePath: "src/app/[id]/page.tsx",
      line: 3,
    });

    expect(result.body).toContain("!\\[img\\]");
    expect(result.body).toContain("\\[link\\]");
  });

  test("filePath なしのファイルレベル対象はコードスパンなしで表示する", () => {
    const result = formatReviewComment({ severity: "want", axis: "arch-1", detail: "d" });
    expect(result.body).toContain("**対象**: (ファイルレベル)");
  });
});

// severity / taxonomy / want のトークン契約は、TS の生成側（formatReviewComment）と
// Rust の分類側（src/difit/gate.rs の classify_body / is_want）の 2 言語にまたがる。
// DriftDetection parity と同様に gate.rs から認識トークンのリテラルを抽出し、
// 生成側が `·` 区切りヘッダで同じトークンを出力することを固定する（写像ドリフト検知）。
describe("formatReviewComment / gate.rs トークン parity", () => {
  /// gate.rs の `header_has_token(body, "<token>")` 呼び出しからリテラルを抽出する。
  function extractGateTokens(): string[] {
    const repoRoot = path.resolve(import.meta.dir, "../../../../..");
    const gateRs = readFileSync(path.join(repoRoot, "src/difit/gate.rs"), "utf-8");
    const tokens = [...gateRs.matchAll(/header_has_token\(body, "([^"]+)"\)/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0);
    return tokens;
  }

  /// gate.rs の header_tokens と同じ `·` 区切り（`**` を外して trim）で
  /// formatReviewComment のヘッダ行をトークン列にする。
  function headerTokens(body: string): string[] {
    const header = body.split("\n")[0].trim();
    return header
      .replace(/^\*\*/, "")
      .replace(/\*\*$/, "")
      .trim()
      .split("·")
      .map((token) => token.trim());
  }

  test("gate.rs の認識トークン集合は 🐛 issue / 🙋 question / 💡 want の 3 つ", () => {
    const tokens = [...new Set(extractGateTokens())];
    const expected = ["🐛 issue", "🙋 question", "💡 want"];
    expect(tokens.length).toBe(expected.length);
    for (const token of expected) {
      expect(tokens).toContain(token);
    }
  });

  test("severity ごとに gate.rs が認識する taxonomy / want トークンを `·` 区切りで出力する", () => {
    const make = (severity: "must" | "should" | "want") =>
      headerTokens(
        formatReviewComment({
          severity,
          axis: "req-1",
          detail: "d",
          filePath: "src/a.ts",
          line: 1,
        }).body,
      );

    const must = make("must");
    expect(must).toContain("🚨 must");
    expect(must).toContain("🐛 issue");
    expect(must).not.toContain("🙋 question");
    expect(must).not.toContain("💡 want");

    const should = make("should");
    expect(should).toContain("⚠️ should");
    expect(should).toContain("🙋 question");
    expect(should).not.toContain("🐛 issue");
    expect(should).not.toContain("💡 want");

    // want は Rust の is_want が 💡 want を認識し、taxonomy は question（非ブロッキング）になる
    const want = make("want");
    expect(want).toContain("💡 want");
    expect(want).toContain("🙋 question");
    expect(want).not.toContain("🐛 issue");

    // 抽出した全トークンが現行の生成出力のいずれかに現れる（gate.rs への追加を検知）
    const emitted = new Set([...must, ...should, ...want]);
    for (const token of extractGateTokens()) {
      expect(emitted.has(token)).toBe(true);
    }
  });
});
