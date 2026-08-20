import { describe, expect, test } from "bun:test";
import {
  buildGuidePath,
  extractPaths,
  isChezmoiSourceDir,
  isUnderHome,
  normalizePath,
} from "../plugins/agent-hooks/block-chezmoi-direct-edit";

const HOME = "/Users/mt";
const CWD = "/Users/mt/src/tools-wt-2";

describe("extractPaths", () => {
  test("opencode 形式 (tool/args)", () => {
    expect(extractPaths({ tool: "edit", args: { filePath: "~/.zshrc" } })).toEqual({
      toolName: "edit",
      path1: "~/.zshrc",
      path2: "",
    });
  });

  test("cursor 形式 (tool_name/tool_input)", () => {
    expect(
      extractPaths({
        tool_name: "Write",
        tool_input: { file_path: "~/.gitconfig", target_notebook: "/tmp/x" },
      }),
    ).toEqual({ toolName: "Write", path1: "~/.gitconfig", path2: "/tmp/x" });
  });

  test("null 入力は空を返す", () => {
    expect(extractPaths(null)).toEqual({ toolName: "", path1: "", path2: "" });
  });
});

describe("normalizePath", () => {
  test("~ は home に展開", () => {
    expect(normalizePath("~", HOME, CWD)).toBe(HOME);
    expect(normalizePath("~/.zshrc", HOME, CWD)).toBe(`${HOME}/.zshrc`);
  });

  test("絶対パスはそのまま", () => {
    expect(normalizePath("/tmp/x", HOME, CWD)).toBe("/tmp/x");
  });

  test("相対パスは cwd に結合", () => {
    expect(normalizePath("foo.txt", HOME, CWD)).toBe(`${CWD}/foo.txt`);
  });

  test("空文字は空文字", () => {
    expect(normalizePath("", HOME, CWD)).toBe("");
  });
});

describe("isUnderHome", () => {
  test("ホーム自身と配下は true", () => {
    expect(isUnderHome(HOME, HOME)).toBe(true);
    expect(isUnderHome(`${HOME}/.zshrc`, HOME)).toBe(true);
    expect(isUnderHome(`${HOME}/.config/nvim/x.lua`, HOME)).toBe(true);
  });

  test("ホーム外は false", () => {
    expect(isUnderHome("/tmp/x", HOME)).toBe(false);
    expect(isUnderHome("/Users/other/.zshrc", HOME)).toBe(false);
  });
});

describe("isChezmoiSourceDir", () => {
  test("chezmoi source の特徴ファイルがあれば true", () => {
    expect(isChezmoiSourceDir("/Users/mt/src/tools-wt-2/chezmoi")).toBe(true);
    expect(isChezmoiSourceDir("/Users/mt/src/tools/chezmoi")).toBe(true);
  });

  test("存在しない/違うディレクトリは false", () => {
    expect(isChezmoiSourceDir("/tmp")).toBe(false);
    expect(isChezmoiSourceDir("/nonexistent")).toBe(false);
  });
});

describe("buildGuidePath", () => {
  const SOURCE_DIR = "/Users/mt/src/tools/chezmoi";

  test("sourceDir 配下は guideRoot に置換", () => {
    expect(
      buildGuidePath(`${SOURCE_DIR}/dot_gitconfig`, SOURCE_DIR, "/Users/mt/src/tools-wt-2/chezmoi"),
    ).toBe("/Users/mt/src/tools-wt-2/chezmoi/dot_gitconfig");
  });

  test("sourceDir 外はそのまま返す", () => {
    expect(buildGuidePath("/tmp/foo", SOURCE_DIR, SOURCE_DIR)).toBe("/tmp/foo");
  });

  test("sourceDir が null ならそのまま返す", () => {
    expect(buildGuidePath(`${SOURCE_DIR}/dot_gitconfig`, null, SOURCE_DIR)).toBe(
      `${SOURCE_DIR}/dot_gitconfig`,
    );
  });
});
