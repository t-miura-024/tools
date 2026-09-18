import { describe, it, expect } from "bun:test";
import { parseTransitionPlanCli } from "./parse-transition-plan-cli";
import { TransitionPlanError } from "./transition-plan-error";

describe("parseTransitionPlanCli", () => {
  it("number と target status を positional で受け取る", () => {
    const options = parseTransitionPlanCli(["7", "in-progress"]);
    expect(options.number).toBe(7);
    expect(options.targetStatus).toBe("in-progress");
  });

  it("--config で config path を指定できる", () => {
    const options = parseTransitionPlanCli(["7", "in-progress", "--config", "/tmp/c.json"]);
    expect(options.configPath).toBe("/tmp/c.json");
  });

  it("--help / -h", () => {
    expect(parseTransitionPlanCli(["--help"]).help).toBe(true);
    expect(parseTransitionPlanCli(["-h"]).help).toBe(true);
  });

  it("number が数値以外ならエラー", () => {
    expect(() => parseTransitionPlanCli(["abc", "in-progress"])).toThrowError(TransitionPlanError);
  });

  it("未対応 status はエラー", () => {
    expect(() => parseTransitionPlanCli(["7", "archived"])).toThrowError(TransitionPlanError);
  });

  it("引数が多すぎる場合はエラー", () => {
    expect(() => parseTransitionPlanCli(["7", "in-progress", "extra"])).toThrowError(
      TransitionPlanError,
    );
  });
});
