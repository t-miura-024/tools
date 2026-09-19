/**
 * gh-issue-verify — 副作用ステップ（GitHub 起票・更新・遷移）の check で使う
 * gh コマンド実照合ヘルパー。
 *
 * Issue 番号の形式検証（`^[0-9]+$`）はこのモジュール内で行う。
 * ネットワーク・認証の失敗は fail 理由として返す
 * （check はブロックする。リトライは onFail 戦略に従う）。
 */
import { execFileSync } from "node:child_process";
import type { GhIssueSnapshot } from "./types";
import { isValidIssueNumber } from "./is-valid-issue-number";

function ghJson(args: string[]): unknown {
  const stdout = execFileSync("gh", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  return JSON.parse(stdout);
}

/** 番号から Issue の実態を取得する。失敗時は例外（呼び出し側で fail 理由に変換）。 */
export function fetchIssue(number: string): GhIssueSnapshot {
  if (!isValidIssueNumber(number)) {
    throw new Error(`invalid issue number: ${number}`);
  }
  return ghJson(["issue", "view", number, "--json", "state,labels,body"]) as GhIssueSnapshot;
}
