import type { Section } from "./types";
import { git } from "./git";
import { fail } from "./fail";
import { parseNameStatus } from "./parse-name-status";
import { parseNumstat } from "./parse-numstat";

/** 追跡済み変更（staged / unstaged）のセクションを組み立てる。 */
export function buildSection(gitArgs: string[]): Section {
  const ns = git("diff", ...gitArgs, "-z", "-M", "--name-status");
  if (ns.code !== 0) fail(`差分一覧を取得できません: ${ns.stderr.trim()}`);

  const numstat = git("diff", ...gitArgs, "--numstat", "-M");
  if (numstat.code !== 0) fail(`変更統計を取得できません: ${numstat.stderr.trim()}`);

  const diff = git("diff", ...gitArgs, "-M", "--no-ext-diff", "--full-index");
  if (diff.code !== 0) fail(`詳細内容を取得できません: ${diff.stderr.trim()}`);

  return {
    files: parseNameStatus(ns.stdout),
    stat: parseNumstat(numstat.stdout),
    diff: diff.stdout,
  };
}
