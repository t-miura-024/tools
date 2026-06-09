import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  transitionPlan,
  resolvePlanPath,
  TransitionPlanError,
} from "./transition-plan";

describe("mt-plan/transition-plan", () => {
  let tmp: string;
  let planRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-transition-"));
    planRoot = path.join(tmp, "project", "tmp", "plan");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writePlan(status: string, filename = "20260425-example.md"): string {
    const file = path.join(planRoot, status, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# Example\n");
    return file;
  }

  it("refined の計画を in-progress に移動する", () => {
    const source = writePlan("refined");

    const result = transitionPlan(source, "in-progress");

    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(result.to)).toBe(true);
    expect(result.sourceStatus).toBe("refined");
    expect(result.targetStatus).toBe("in-progress");
    expect(result.to).toBe(
      path.join(planRoot, "in-progress", "20260425-example.md"),
    );
  });

  it("移動先ディレクトリが存在しない場合は作成する", () => {
    const source = writePlan("draft");
    const targetDir = path.join(planRoot, "refined");

    expect(fs.existsSync(targetDir)).toBe(false);

    const result = transitionPlan(source, "refined");

    expect(fs.existsSync(targetDir)).toBe(true);
    expect(fs.existsSync(result.to)).toBe(true);
  });

  it("移動先に同名ファイルがある場合は上書きしない", () => {
    const source = writePlan("refined");
    const destination = writePlan("in-progress");

    expect(() => transitionPlan(source, "in-progress")).toThrowError(
      /Destination plan already exists/,
    );
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.readFileSync(destination, "utf8")).toBe("# Example\n");
  });

  it("存在しない計画ファイルはエラーにする", () => {
    const missing = path.join(planRoot, "refined", "missing.md");

    expect(() => transitionPlan(missing, "in-progress")).toThrowError(
      /Plan file does not exist/,
    );
  });

  it("未対応ステータスはエラーにする", () => {
    const source = writePlan("refined");

    expect(() => transitionPlan(source, "archived")).toThrowError(
      /Unsupported target status/,
    );
  });

  it("許可されていない遷移はエラーにする", () => {
    const source = writePlan("draft");

    expect(() => transitionPlan(source, "done")).toThrowError(
      /is not allowed/,
    );
  });

  it("tmp/plan/[status]/ 直下ではないパスはエラーにする", () => {
    const nested = path.join(planRoot, "refined", "nested", "example.md");
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.writeFileSync(nested, "# Nested\n");

    expect(() => resolvePlanPath(nested)).toThrowError(
      /direct child of tmp\/plan\/\[status\]/,
    );
  });

  it("専用エラー型で失敗内容を返す", () => {
    const source = writePlan("unknown");

    expect(() => transitionPlan(source, "done")).toThrowError(
      TransitionPlanError,
    );
  });
});
