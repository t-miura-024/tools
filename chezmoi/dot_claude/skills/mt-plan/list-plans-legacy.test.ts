import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listPlans,
  formatListPlansResult,
  runCli,
  ListPlansError,
} from "./list-plans-legacy";

describe("mt-plan/list-plans", () => {
  let tmp: string;
  let projectRoot: string;
  let planRoot: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt-plan-list-"));
    projectRoot = path.join(tmp, "project");
    planRoot = path.join(projectRoot, "tmp", "plan");
    fs.mkdirSync(projectRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writePlan(status: string, filename: string): string {
    const file = path.join(planRoot, status, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# Example\n");
    return file;
  }

  it("tmp が gitignore 対象でもファイルシステムから計画を列挙する", () => {
    fs.writeFileSync(path.join(projectRoot, ".gitignore"), "tmp/\n");
    writePlan("refined", "20260427-example.md");
    writePlan("in-progress", "20260427-active.md");

    const result = listPlans({
      cwd: projectRoot,
      statuses: ["refined", "in-progress"],
    });

    expect(result.plans).toEqual([
      {
        status: "refined",
        path: path.join("tmp", "plan", "refined", "20260427-example.md"),
        absolutePath: path.join(
          planRoot,
          "refined",
          "20260427-example.md",
        ),
      },
      {
        status: "in-progress",
        path: path.join("tmp", "plan", "in-progress", "20260427-active.md"),
        absolutePath: path.join(
          planRoot,
          "in-progress",
          "20260427-active.md",
        ),
      },
    ]);
  });

  it("指定されたステータスだけを列挙する", () => {
    writePlan("draft", "20260427-draft.md");
    writePlan("refined", "20260427-refined.md");

    const result = listPlans({ cwd: projectRoot, statuses: ["draft"] });

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].status).toBe("draft");
    expect(result.plans[0].path).toBe(
      path.join("tmp", "plan", "draft", "20260427-draft.md"),
    );
  });

  it("計画がない場合は確認したディレクトリを出力する", () => {
    const result = listPlans({
      cwd: projectRoot,
      statuses: ["refined", "in-progress"],
    });

    expect(result.plans).toEqual([]);
    expect(formatListPlansResult(result)).toContain("plans: none");
    expect(formatListPlansResult(result)).toContain("checked directories:");
  });

  it("CLI で project root とステータスを指定できる", () => {
    writePlan("refined", "20260427-example.md");

    const output = runCli(["--cwd", projectRoot, "refined"]);

    expect(output).toContain("[refined] tmp/plan/refined/20260427-example.md");
  });

  it("未対応ステータスはエラーにする", () => {
    expect(() => runCli(["archived"])).toThrowError(ListPlansError);
  });
});
