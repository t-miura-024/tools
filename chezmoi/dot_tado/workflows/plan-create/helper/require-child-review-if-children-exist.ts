import type { CheckCtx, CheckResult } from "tado";
import { join, resolve } from "node:path";
import { readdirSync, lstatSync } from "node:fs";
import { isPathInside } from "tado/artifacts";
import { findArtifactText } from "tado/artifacts";

const REVIEW_BODY_KEY = "review-body.md";

// 分解モードで子 body が存在するのに review-body.md が子に言及しない場合は
// 子未レビューとみなして fail に倒す（未レビュー子の refined 化を防ぐ機械ゲート）。
// prepare-decision.json の有無に依存せず、子ファイルの実在で判定する。
// 子レビュー痕跡の対応検証: 子ファイル名への単なる言及ではなく、子ごとの
// 指摘セクション見出し（例: ### 対象: issue-body-1.md）または対象表行
// （例: | 対象 | issue-body-1.md |）での言及を要求する。
// 「対象外」一文のような除外記載だけでは子レビューとみなさない。
export function requireChildReviewIfChildrenExist(ctx: CheckCtx): CheckResult {
  let children: string[];
  try {
    children = readdirSync(ctx.sessionDir).filter((f) => /^issue-body-\d+\.md$/.test(f));
  } catch {
    return { status: "fail", reasons: ["子body列挙に失敗したため検証不能"] };
  }
  if (children.length === 0) return { status: "pass", reasons: [] };
  // symlink 差し替えによる任意ファイル流出を防ぐ: 子 body は実ファイルのみ許容し、
  // 解決後パスが sessionDir 配下であることを確認する（fail-closed）。
  for (const child of children) {
    const fullPath = resolve(join(ctx.sessionDir, child));
    try {
      if (lstatSync(fullPath).isSymbolicLink()) {
        return {
          status: "fail",
          reasons: [`${child}: symlink のため検証不能（子 body は実ファイルであること）`],
        };
      }
    } catch {
      return { status: "fail", reasons: ["子body列挙に失敗したため検証不能"] };
    }
    if (!isPathInside(ctx.sessionDir, fullPath)) {
      return { status: "fail", reasons: [`${child}: sessionDir 配下にないため検証不能`] };
    }
  }
  const reviewBody = findArtifactText(ctx.artifacts, REVIEW_BODY_KEY, ctx.sessionDir) ?? "";
  const missing = children.filter((child) => {
    const escaped = child.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingPattern = new RegExp(`^###.*対象.*${escaped}`);
    return !reviewBody.split("\n").some((line) => {
      if (!line.includes(child)) return false;
      if (line.includes("対象外")) return false;
      if (headingPattern.test(line)) return true;
      if (line.includes("|") && line.includes("対象")) return true;
      return false;
    });
  });
  if (missing.length > 0) {
    return {
      status: "fail",
      reasons: [
        `${REVIEW_BODY_KEY}: 子 body（${children.join(", ")}）が存在するのに子レビューの痕跡がない（子ごとに「対象」見出し（例: ### 対象: issue-body-<n>.md）または対象表行での言及が必要。不足: ${missing.join(", ")}）`,
      ],
    };
  }
  return { status: "pass", reasons: [] };
}
