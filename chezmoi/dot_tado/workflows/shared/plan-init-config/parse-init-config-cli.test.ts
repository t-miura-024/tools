import { describe, it, expect } from "bun:test";
import { parseInitConfigCli } from "./parse-init-config-cli";
import { InitConfigError } from "./init-config-error";

describe("parseInitConfigCli", () => {
  it("--config で config path を指定できる", () => {
    const options = parseInitConfigCli(["--config", "/tmp/config.json"]);

    expect(options.configPath).toBe("/tmp/config.json");
  });

  it("--help / -h で help フラグが立つ", () => {
    expect(parseInitConfigCli(["--help"]).help).toBe(true);
    expect(parseInitConfigCli(["-h"]).help).toBe(true);
  });

  it("未知の引数はエラー", () => {
    expect(() => parseInitConfigCli(["--unknown"])).toThrowError(InitConfigError);
  });

  it("--config に値がない場合はエラー", () => {
    expect(() => parseInitConfigCli(["--config"])).toThrowError(/--config requires/);
  });
});
