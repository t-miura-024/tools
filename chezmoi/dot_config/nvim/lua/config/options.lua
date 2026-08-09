-- Options are automatically loaded before lazy.nvim startup
-- Default options that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/options.lua
-- Add any additional options here

-- Keep LSP features such as navigation while disabling all diagnostics.
vim.diagnostic.enable(false)

-- LazyVim enables spell checking for Markdown, but the configured language is English.
vim.api.nvim_create_autocmd("FileType", {
  pattern = "markdown",
  callback = function(args)
    vim.schedule(function()
      for _, win in ipairs(vim.api.nvim_list_wins()) do
        if vim.api.nvim_win_get_buf(win) == args.buf then
          vim.wo[win].spell = false
        end
      end
    end)
  end,
})
