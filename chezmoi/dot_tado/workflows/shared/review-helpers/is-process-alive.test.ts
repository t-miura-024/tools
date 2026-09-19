import { describe, test, expect } from "bun:test";
import { isProcessAlive } from "./is-process-alive.ts";

describe("isProcessAlive (ESRCH のみ死亡・それ以外は生存)", () => {
  test("存在しない pid は false（ESRCH）", () => {
    expect(isProcessAlive(2147483647)).toBe(false);
  });

  test("EPERM（プロセスは存在するが権限がない）は true（孤児を見逃さない fail-closed）", () => {
    const original = process.kill;
    (process as unknown as { kill: unknown }).kill = () => {
      const error = new Error("kill EPERM") as Error & { code: string };
      error.code = "EPERM";
      throw error;
    };
    try {
      expect(isProcessAlive(1)).toBe(true);
    } finally {
      (process as unknown as { kill: unknown }).kill = original;
    }
  });
});
