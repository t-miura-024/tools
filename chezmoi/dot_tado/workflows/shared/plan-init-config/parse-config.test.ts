import { describe, it, expect } from "bun:test";
import { parseConfig } from "./parse-config";
import { InitConfigError } from "./init-config-error";

describe("parseConfig", () => {
  it("不正な JSON はエラー", () => {
    expect(() => parseConfig("not json")).toThrowError(InitConfigError);
  });

  it("必須フィールドが欠けるとエラー", () => {
    expect(() => parseConfig('{"owner":"x"}')).toThrowError(/missing required field/);
  });

  it("statusOptions に必要な status が欠けるとエラー", () => {
    const incomplete = JSON.stringify({
      owner: "x",
      projectNumber: 1,
      projectId: "PVT",
      statusFieldId: "F",
      statusOptions: { draft: "d", refined: "r", done: "dn" },
    });

    expect(() => parseConfig(incomplete)).toThrowError(/statusOptions\.in-progress/);
  });
});
