import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DifitReviewStateRead, DifitSelectionView } from "./types.ts";
import { isRecord } from "./is-record.ts";
import { parseDifitSelectionView } from "./parse-difit-selection-view.ts";
import { parseJson } from "./parse-json.ts";
import { resolveGitRepoRoot } from "./resolve-git-repo-root.ts";

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
