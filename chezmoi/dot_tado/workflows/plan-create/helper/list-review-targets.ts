import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isPathInside } from "tado/artifacts";

export interface ReviewTargetList {
  targets: string[];
  error?: string;
}

/// レビュー対象の body 一覧。親 body + 実在する子 body 全件。
/// symlink 差し替えによる任意ファイル流出を防ぐため、実ファイルのみ許容する。
export function listReviewTargets(sessionDir: string): ReviewTargetList {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return { targets: [], error: "セッションディレクトリの列挙に失敗したため検証不能" };
  }

  const targets = ["issue-body.md"];
  for (const target of targets) {
    const fullPath = resolve(join(sessionDir, target));
    try {
      if (lstatSync(fullPath).isSymbolicLink()) {
        return {
          targets: [],
          error: `${target}: symlink のため検証不能（body は実ファイルであること）`,
        };
      }
    } catch {
      return { targets: [], error: `${target} の存在確認に失敗したため検証不能` };
    }
    if (!isPathInside(sessionDir, fullPath)) {
      return { targets: [], error: `${target}: sessionDir 配下にないため検証不能` };
    }
  }

  for (const entry of entries.filter((value) => /^issue-body-\d+\.md$/.test(value)).sort()) {
    const fullPath = resolve(join(sessionDir, entry));
    try {
      if (lstatSync(fullPath).isSymbolicLink()) {
        return {
          targets: [],
          error: `${entry}: symlink のため検証不能（子 body は実ファイルであること）`,
        };
      }
    } catch {
      return { targets: [], error: "子body列挙に失敗したため検証不能" };
    }
    if (!isPathInside(sessionDir, fullPath)) {
      return { targets: [], error: `${entry}: sessionDir 配下にないため検証不能` };
    }
    targets.push(entry);
  }

  return { targets };
}
