-- Seqcall for Neovim (FR-21.5): interactive sequence and class diagrams in a browser tab.
-- :help seqcall, :checkhealth seqcall. Logic in lua/seqcall/init.lua (loaded on first use).
if vim.g.loaded_seqcall or vim.fn.has('nvim-0.10') == 0 then
  return
end
vim.g.loaded_seqcall = 1

local function seqcall()
  return require('seqcall')
end

local commands = {
  SeqcallShow = { function() seqcall().show() end, 'Draw the sequence diagram of the method at the cursor' },
  SeqcallOpen = { function() seqcall().show_view('sequence') end, 'Open the sequence diagram page again' },
  SeqcallClass = { function() seqcall().show_view('class') end, 'Open the class diagram page' },
  SeqcallEntryPoints = { function() seqcall().entry_points() end, 'Show where flows start (routes, commands, jobs, tests)' },
  SeqcallStop = { function() seqcall().stop() end, 'Stop the Seqcall sidecar' },
  SeqcallLog = { function() seqcall().show_log() end, 'Show the Seqcall log' },
  SeqcallUpdate = { function() seqcall().update() end, 'Install the latest Seqcall release (restart to use it)' },
  SeqcallInfo = { function() seqcall().info() end, 'What Seqcall knows about the call or method at the cursor' },
  SeqcallMemory = { function() seqcall().memory() end, 'Show the memory Seqcall uses' },
  SeqcallFreeMemory = { function() seqcall().free_memory() end, 'Drop Seqcall\'s caches and stop the C# analysis' },
}
for name, def in pairs(commands) do
  vim.api.nvim_create_user_command(name, def[1], { desc = def[2] })
end
vim.api.nvim_create_user_command('SeqcallReach', function(o) seqcall().reach(o.args) end, { nargs = '?', desc = 'Open an entry point\'s flow down to the method of :SeqcallInfo' })
vim.keymap.set('n', '<Plug>(seqcall-show)', function() seqcall().show() end, { desc = 'Seqcall: show sequence diagram' })
vim.keymap.set('n', '<Plug>(seqcall-info)', function() seqcall().info() end, { desc = 'Seqcall: info at the cursor' })

local group = vim.api.nvim_create_augroup('seqcall', { clear = true })
-- Cheap until the sidecar runs: the module is required only once a diagram was requested.
local function started()
  return package.loaded['seqcall'] ~= nil
end
vim.api.nvim_create_autocmd('BufWritePost', {
  group = group,
  callback = function(args)
    if started() then
      seqcall().on_write(vim.fn.fnamemodify(args.file, ':p'))
    end
  end,
})
vim.api.nvim_create_autocmd('CursorMoved', {
  group = group,
  callback = function()
    if started() then
      seqcall().on_cursor_moved()
    end
  end,
})
vim.api.nvim_create_autocmd('VimLeavePre', {
  group = group,
  callback = function()
    if started() then
      seqcall().stop()
    end
  end,
})
