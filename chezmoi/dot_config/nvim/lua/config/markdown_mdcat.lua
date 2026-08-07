local M = {}

local group = vim.api.nvim_create_augroup("MarkdownMdcat", { clear = true })
local previews = {}
local source_to_preview = {}

local function valid_buffer(buf)
  return buf and vim.api.nvim_buf_is_valid(buf)
end

local function valid_tabpage(tabpage)
  for _, tab in ipairs(vim.api.nvim_list_tabpages()) do
    if tab == tabpage then
      return true
    end
  end
  return false
end

local function source_path(buf)
  local path = vim.api.nvim_buf_get_name(buf)
  if path == "" or vim.fn.filereadable(path) ~= 1 then
    return nil
  end

  return vim.fn.fnamemodify(path, ":p")
end

local function stop_preview(preview_buf, delete_buffer)
  local state = previews[preview_buf]
  if not state then
    return
  end

  state.closing = true
  previews[preview_buf] = nil
  if source_to_preview[state.source_buf] == preview_buf then
    source_to_preview[state.source_buf] = nil
  end

  if valid_buffer(state.source_buf) then
    if vim.b[state.source_buf].mdcat_preview_buf == preview_buf then
      vim.b[state.source_buf].mdcat_preview_buf = nil
    end
    vim.bo[state.source_buf].bufhidden = state.source_bufhidden
  end

  if state.job_id then
    vim.fn.jobstop(state.job_id)
  end

  if delete_buffer and valid_buffer(preview_buf) then
    vim.api.nvim_buf_delete(preview_buf, { force = true })
  end
end

local function stop_preview_for_window(win)
  for preview_buf, state in pairs(previews) do
    if state.win == win then
      stop_preview(preview_buf, true)
    end
  end
end

local function enter_editor(preview_buf)
  local state = previews[preview_buf]
  if not state or not valid_buffer(state.source_buf) then
    vim.notify("Markdown source buffer is no longer available", vim.log.levels.ERROR)
    return
  end

  if state.edit_tab and valid_tabpage(state.edit_tab) then
    vim.api.nvim_set_current_tabpage(state.edit_tab)
    vim.cmd("startinsert")
    return
  end

  local preview_tab = vim.api.nvim_get_current_tabpage()
  vim.cmd("tabnew")

  local edit_tab = vim.api.nvim_get_current_tabpage()
  local edit_win = vim.api.nvim_get_current_win()
  local placeholder = vim.api.nvim_get_current_buf()

  vim.api.nvim_win_set_buf(edit_win, state.source_buf)
  if valid_buffer(placeholder) and placeholder ~= state.source_buf then
    vim.api.nvim_buf_delete(placeholder, { force = true })
  end

  state.preview_tab = preview_tab
  state.edit_tab = edit_tab

  vim.schedule(function()
    if valid_tabpage(edit_tab) then
      vim.api.nvim_set_current_tabpage(edit_tab)
      vim.cmd("startinsert")
    end
  end)
end

local function restore_source_after_exit(preview_buf, code)
  local state = previews[preview_buf]
  if not state or state.closing then
    return
  end

  local source_buf = state.source_buf
  local source_win
  for _, win in ipairs(vim.api.nvim_list_wins()) do
    if vim.api.nvim_win_get_buf(win) == preview_buf then
      source_win = win
      break
    end
  end

  stop_preview(preview_buf, false)

  if source_win and valid_buffer(source_buf) and vim.api.nvim_win_is_valid(source_win) then
    vim.api.nvim_win_set_buf(source_win, source_buf)
  end

  if code ~= 0 then
    vim.notify("mdcat exited unexpectedly; returned to the Markdown buffer", vim.log.levels.WARN)
  end
end

local function start_preview(source_buf)
  if not valid_buffer(source_buf) or vim.bo[source_buf].buftype ~= "" then
    return
  end
  if vim.b[source_buf].mdcat_preview_buf then
    return
  end

  local path = source_path(source_buf)
  if not path then
    return
  end

  local win = vim.api.nvim_get_current_win()
  stop_preview_for_window(win)

  if vim.fn.executable("mdcat") ~= 1 then
    vim.notify("mdcat is not installed; keeping the normal Markdown editor", vim.log.levels.WARN)
    return
  end

  local preview_buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_name(preview_buf, "mdcat://" .. path)
  vim.bo[preview_buf].bufhidden = "wipe"
  vim.bo[preview_buf].swapfile = false

  local state = {
    source_buf = source_buf,
    source_bufhidden = vim.bo[source_buf].bufhidden,
    preview_buf = preview_buf,
    win = win,
  }
  previews[preview_buf] = state
  source_to_preview[source_buf] = preview_buf
  vim.b[source_buf].mdcat_preview_buf = preview_buf
  vim.bo[source_buf].bufhidden = "hide"

  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    buffer = preview_buf,
    callback = function()
      stop_preview(preview_buf, false)
    end,
  })

  vim.api.nvim_create_autocmd("BufWipeout", {
    group = group,
    buffer = source_buf,
    callback = function()
      local current_preview = source_to_preview[source_buf]
      if current_preview then
        stop_preview(current_preview, true)
      end
    end,
  })

  vim.api.nvim_win_set_buf(win, preview_buf)

  local job_id = vim.fn.termopen({ "mdcat", "--local", "--no-pager", "--watch", path }, {
    on_exit = function(_, code, _)
      vim.schedule(function()
        restore_source_after_exit(preview_buf, code)
      end)
    end,
  })
  if job_id <= 0 then
    stop_preview(preview_buf, true)
    vim.api.nvim_win_set_buf(win, source_buf)
    vim.notify("Unable to start mdcat; keeping the normal Markdown editor", vim.log.levels.WARN)
    return
  end
  state.job_id = job_id

  local function edit()
    enter_editor(preview_buf)
  end
  vim.keymap.set({ "n", "t" }, "i", edit, {
    buffer = preview_buf,
    silent = true,
    nowait = true,
    desc = "Edit Markdown source",
  })

  vim.schedule(function()
    if vim.api.nvim_buf_is_valid(preview_buf) and vim.api.nvim_get_current_buf() == preview_buf then
      vim.cmd("startinsert")
    end
  end)
end

vim.api.nvim_create_autocmd("FileType", {
  group = group,
  pattern = "markdown",
  callback = function(args)
    vim.schedule(function()
      if vim.api.nvim_buf_is_valid(args.buf) and vim.api.nvim_get_current_buf() == args.buf then
        start_preview(args.buf)
      end
    end)
  end,
})

return M
