import { describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { normalizePrompt } from "./helper.ts";

describe("normalizePrompt", () => {
  test("リポジトリルートを <HOME> より先に <REPO> へ正規化する", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../../..");
    const sessionDir = "/tmp/prompt-snapshot-session";
    const prompt = [
      `session=${sessionDir}`,
      `repo=${repoRoot}`,
      `file=${path.join(repoRoot, "chezmoi/example.md")}`,
      `home=${os.homedir()}`,
    ].join("\n");

    expect(normalizePrompt(prompt, sessionDir)).toBe(
      ["session=<SESSION>", "repo=<REPO>", "file=<REPO>/chezmoi/example.md", "home=<HOME>"].join(
        "\n",
      ),
    );
  });
});
