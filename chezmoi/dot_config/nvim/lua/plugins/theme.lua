-- カラーテーマ（Q10 決定: Catppuccin Mocha に統一）
return {
  {
    "catppuccin/nvim",
    name = "catppuccin",
    lazy = true,
    priority = 1000,
    opts = {
      flavour = "mocha",
      transparent_background = true,
      integrations = {
        aerial = true,
        cmp = true,
        dap = true,
        dap_ui = true,
        dashboard = true,
        gitsigns = true,
        mason = true,
        native_lsp = {
          enabled = true,
        },
        notify = true,
        nvimtree = true,
        telescope = true,
        treesitter = true,
        which_key = true,
      },
    },
  },
  -- LazyVim の colorscheme として Catppuccin Mocha を指定
  {
    "LazyVim/LazyVim",
    opts = {
      colorscheme = "catppuccin-mocha",
    },
  },
}
