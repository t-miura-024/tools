import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
}));

describe("createRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates repo successfully with description", async () => {
    const { execa } = await import("execa");
    vi.mocked(execa).mockResolvedValue({ stdout: "" } as never);

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { createRepo } = await import("./create-repo.js");
    await createRepo({
      name: "my-repo",
      placement: "src",
      visibility: "private",
      description: "My project",
    });

    expect(execa).toHaveBeenCalledWith("gh", ["auth", "status"]);
    expect(execa).toHaveBeenCalledWith(
      "git",
      ["init", "-b", "main"],
      expect.objectContaining({ cwd: expect.stringContaining("my-repo") }),
    );
    expect(execa).toHaveBeenCalledWith(
      "gh",
      ["repo", "create", "my-repo", "--private", "--source=.", "--push", "--description", "My project"],
      expect.objectContaining({ cwd: expect.stringContaining("my-repo") }),
    );
  });

  it("places in ~/doc when placement is doc", async () => {
    const { execa } = await import("execa");
    vi.mocked(execa).mockResolvedValue({ stdout: "" } as never);

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { createRepo } = await import("./create-repo.js");
    await createRepo({
      name: "docs-repo",
      placement: "doc",
      visibility: "public",
      description: "",
    });

    const { mkdir } = await import("node:fs/promises");
    expect(mkdir).toHaveBeenCalledWith(
      expect.stringContaining("/doc/docs-repo"),
      { recursive: true },
    );
  });

  it("skips --description when description is empty", async () => {
    const { execa } = await import("execa");
    vi.mocked(execa).mockResolvedValue({ stdout: "" } as never);

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { createRepo } = await import("./create-repo.js");
    await createRepo({
      name: "no-desc",
      placement: "src",
      visibility: "private",
      description: "",
    });

    const createCall = (vi.mocked(execa).mock.calls as [string, string[]][]).find(
      ([cmd, args]) => cmd === "gh" && args[0] === "repo",
    );
    expect(createCall).toBeDefined();
    expect(createCall![1]).not.toContain("--description");
  });

  it("stops if gh auth fails", async () => {
    const { execa } = await import("execa");
    vi.mocked(execa).mockRejectedValueOnce(new Error("not authenticated"));

    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(false);

    const { createRepo } = await import("./create-repo.js");
    await createRepo({
      name: "auth-fail",
      placement: "src",
      visibility: "private",
      description: "",
    });

    expect(execa).toHaveBeenCalledTimes(1);
    expect(execa).toHaveBeenCalledWith("gh", ["auth", "status"]);
  });

  it("stops if directory exists", async () => {
    const { existsSync } = await import("node:fs");
    vi.mocked(existsSync).mockReturnValue(true);

    const { createRepo } = await import("./create-repo.js");
    await createRepo({
      name: "dup",
      placement: "src",
      visibility: "private",
      description: "",
    });

    const { execa } = await import("execa");
    expect(execa).not.toHaveBeenCalled();
  });
});
