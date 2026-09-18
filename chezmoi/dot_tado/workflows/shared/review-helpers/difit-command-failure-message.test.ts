import { describe, test, expect } from "bun:test";
import { difitCommandFailureMessage } from "./difit-command-failure-message.ts";
import { DifitOutputTooLargeError } from "./difit-output-too-large-error.ts";
import { DifitSpawnError } from "./difit-spawn-error.ts";
import { DifitTimeoutError } from "./difit-timeout-error.ts";

describe("difitCommandFailureMessage (4 サイト共通の振り分け)", () => {
  test("difit の 3 エラー型は理由メッセージを返す（型ごとの原因を失わない）", () => {
    expect(
      difitCommandFailureMessage(new DifitOutputTooLargeError(["threads", "--json"])),
    ).toContain("maxBuffer");
    expect(difitCommandFailureMessage(new DifitTimeoutError(["done"]))).toContain("timeout");
    expect(
      difitCommandFailureMessage(new DifitSpawnError(["check", "--dry-run"], new Error("ENOENT"))),
    ).toContain("spawn 失敗");
  });

  test("対象外の例外は undefined を返す（呼び出し元が rethrow する契約）", () => {
    expect(difitCommandFailureMessage(new Error("unexpected"))).toBeUndefined();
    expect(difitCommandFailureMessage(undefined)).toBeUndefined();
    expect(difitCommandFailureMessage({ code: "ETIMEDOUT" })).toBeUndefined();
  });
});
