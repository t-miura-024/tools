/**
 * gh-issue-verify.ts — 副作用ステップ（GitHub 起票・更新・遷移）の check で使う
 * gh コマンド実照合ヘルパー。
 *
 * Issue 番号の形式検証（`^[0-9]+$`）はこのモジュール内で行う。
 * ネットワーク・認証の失敗は fail 理由として返す
 * （check はブロックする。リトライは onFail 戦略に従う）。
 */
import { execFileSync } from "node:child_process";

function isValidIssueNumber(number: string): boolean {
  return /^[0-9]+$/.test(number);
}

function invalidNumberReasons(number: string): string[] {
  return [`invalid issue number: ${number} (expected ^[0-9]+$)`];
}

function ghJson(args: string[]): unknown {
  const stdout = execFileSync("gh", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  return JSON.parse(stdout);
}

export interface GhIssueSnapshot {
  state?: string;
  labels?: { name?: string }[];
  body?: string;
}

/** 番号から Issue の実態を取得する。失敗時は例外（呼び出し側で fail 理由に変換）。 */
export function fetchIssue(number: string): GhIssueSnapshot {
  if (!isValidIssueNumber(number)) {
    throw new Error(`invalid issue number: ${number}`);
  }
  return ghJson(["issue", "view", number, "--json", "state,labels,body"]) as GhIssueSnapshot;
}

/** Issue が存在し state が OPEN であることの検証。違反理由の配列（空なら合格）。 */
export function verifyIssueOpen(number: string): string[] {
  if (!isValidIssueNumber(number)) return invalidNumberReasons(number);
  try {
    const issue = fetchIssue(number);
    if (issue.state !== "OPEN") {
      return [`gh: issue #${number} is not OPEN (state=${issue.state ?? "unknown"})`];
    }
    return [];
  } catch (e) {
    return [`gh: failed to fetch issue #${number} (${String(e)})`];
  }
}

/** Issue が存在し OPEN かつ指定 label を持つことの検証。 */
export function verifyIssueOpenLabeled(number: string, label: string): string[] {
  if (!isValidIssueNumber(number)) return invalidNumberReasons(number);
  try {
    const issue = fetchIssue(number);
    const reasons: string[] = [];
    if (issue.state !== "OPEN") {
      reasons.push(`gh: issue #${number} is not OPEN (state=${issue.state ?? "unknown"})`);
    }
    const names = (issue.labels ?? []).map((l) => l.name ?? "");
    if (!names.includes(label)) {
      reasons.push(`gh: issue #${number} is missing label "${label}"`);
    }
    return reasons;
  } catch (e) {
    return [`gh: failed to fetch issue #${number} (${String(e)})`];
  }
}

/** Issue が存在し state が CLOSED であることの検証（done 遷移の実照合）。 */
export function verifyIssueClosed(number: string): string[] {
  if (!isValidIssueNumber(number)) return invalidNumberReasons(number);
  try {
    const issue = fetchIssue(number);
    if (issue.state !== "CLOSED") {
      return [`gh: issue #${number} is not CLOSED (state=${issue.state ?? "unknown"})`];
    }
    return [];
  } catch (e) {
    return [`gh: failed to fetch issue #${number} (${String(e)})`];
  }
}

/** Issue body の本文照合用（例: `## 🐢 履歴` の遷移エントリ確認）。 */
export function fetchIssueBody(number: string): string {
  const issue = fetchIssue(number);
  return issue.body ?? "";
}
