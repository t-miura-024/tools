import { describe, it, expect, vi } from "vitest";

vi.mock("execa", () => ({
  execa: vi.fn(),
}));

describe("getDefaultBranch", () => {
  it("works", async () => {
    const { execa } = await import("execa");
    vi.mocked(execa).mockResolvedValue({ stdout: "refs/remotes/origin/main" } as never);

    const { getDefaultBranch } = await import("./hello.js");
    const branch = await getDefaultBranch();

    expect(branch).toBe("main");
  });
});
