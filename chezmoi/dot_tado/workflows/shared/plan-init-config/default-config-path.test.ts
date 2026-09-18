import { describe, it, expect } from "bun:test";
import * as path from "node:path";
import * as os from "node:os";
import { defaultConfigPath } from "./default-config-path";

describe("defaultConfigPath", () => {
  it("$HOME/.config/mt-plan/config.json を返す", () => {
    const expected = path.join(os.homedir(), ".config", "mt-plan", "config.json");

    expect(defaultConfigPath()).toBe(expected);
  });
});
