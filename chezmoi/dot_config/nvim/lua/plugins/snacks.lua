-- 隠しファイル・gitignore ファイルをエクスプローラーとピッカーで常時表示
-- （grill rounds 決定: 対象=両方 / 方式=常時表示 / .git 除外 / grep は拡張しない）
return {
  {
    "folke/snacks.nvim",
    opts = {
      picker = {
        sources = {
          explorer = {
            hidden = true,
            ignored = true,
            exclude = { ".git", ".github" },
            include = { ".gitignore" },
          },
        },
      },
    },
    keys = {
      { "<leader>ff", LazyVim.pick("files", { hidden = true, ignored = true }), desc = "Find Files (Root Dir)" },
      { "<leader><space>", LazyVim.pick("files", { hidden = true, ignored = true }), desc = "Find Files (Root Dir)" },
    },
  },
}
