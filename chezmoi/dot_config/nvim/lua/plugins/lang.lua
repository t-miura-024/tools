-- LSP / Treesitter / Mason の拡張（Q6 決定: TS + Rust + Markdown を先行）
return {
  -- TypeScript (tsserver, basedpyright 相当の型チェック・補完)
  { import = "lazyvim.plugins.extras.lang.typescript" },
  -- Rust (rust-analyzer)
  { import = "lazyvim.plugins.extras.lang.rust" },
  -- Markdown (marksman + treesitter)
  { import = "lazyvim.plugins.extras.lang.markdown" },
}
