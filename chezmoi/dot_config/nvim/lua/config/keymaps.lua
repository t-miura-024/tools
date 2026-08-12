-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here

vim.api.nvim_create_user_command("Copy", function()
  local src = vim.fn.expand("%:p")
  if src == "" then
    vim.notify("No file name", vim.log.levels.WARN)
    return
  end
  local base = vim.fn.fnamemodify(src, ":t:r")
  local ext = vim.fn.fnamemodify(src, ":e")
  local default = ext == "" and (base .. " copy") or (base .. " copy." .. ext)
  vim.ui.input({ prompt = "Copy to: ", default = default }, function(input)
    if not input or input == "" then
      return
    end
    vim.cmd("saveas " .. vim.fn.fnameescape(vim.fn.fnamemodify(vim.fn.expand("%:h") .. "/" .. input, ":.")))
  end)
end, { desc = "Copy file to new name and switch buffer" })
