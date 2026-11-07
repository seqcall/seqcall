-- Seqcall for Neovim (FR-21.5): the counterpart of autoload/seqcall.vim (Vim 9). Starts the Node
-- sidecar (packages/stdio-host) in browser mode, sends it the cursor, saved files and cursor moves,
-- opens the diagram pages it names in the browser and jumps to the code when a diagram element is
-- clicked. Protocol: newline-delimited JSON-RPC 2.0 on stdio, see docs/VIM-PLUGIN.md.
local M = {}

local MIN_NODE = 20
-- lua/seqcall/init.lua → the plugin directory.
local root = vim.fn.fnamemodify(debug.getinfo(1, 'S').source:sub(2), ':p:h:h:h')

local config = {}
local state = { job = nil, next_id = 1, pending = {}, partial = '', log = {}, stderr = {}, timer = nil, last_caret = '' }

--- `require('seqcall').setup{ node = …, browser = function(url) … end, … }`; unset keys fall back to
--- the g:seqcall_* variables shared with Vim (:help seqcall).
function M.setup(opts)
  config = vim.tbl_extend('force', config, opts or {})
end

local function setting(name, default)
  if config[name] ~= nil then
    return config[name]
  end
  local value = vim.g['seqcall_' .. name]
  if value == nil then
    return default
  end
  return value
end

local function log(level, text)
  table.insert(state.log, os.date('%H:%M:%S') .. ' ' .. level .. ' ' .. text)
  if #state.log > 1000 then
    state.log = vim.list_slice(state.log, 201)
  end
  if level == 'error' then
    vim.notify('Seqcall: ' .. text, vim.log.levels.ERROR)
  end
end

local function readable(path)
  return path ~= nil and path ~= '' and vim.fn.filereadable(path) == 1
end

-- ───────────────────────────── Locating Node, dotnet and the sidecar ─────────────────────────────

local function version_of(path)
  local major, minor = path:match('v(%d+)%.(%d+)')
  return major and tonumber(major) * 1000 + tonumber(minor) or 0
end

local function node_major(node)
  if node == nil or node == '' or vim.fn.executable(node) == 0 then
    return 0
  end
  local out = vim.fn.system({ node, '--version' })
  if vim.v.shell_error ~= 0 then
    return 0
  end
  return tonumber(out:match('^v(%d+)')) or 0
end

--- Setting → $SEQCALL_NODE → PATH → newest nvm installation (a GUI Neovim often has no nvm on its PATH).
--- '' and an error naming the rejected versions when none fits (`quiet`: no message, for :checkhealth).
function M.node(quiet)
  local nvm = vim.fn.glob((vim.env.HOME or '') .. '/.nvm/versions/node/v*/bin/node', false, true)
  table.sort(nvm, function(a, b)
    return version_of(a) > version_of(b)
  end)
  local candidates = { setting('node', ''), vim.env.SEQCALL_NODE or '', vim.fn.exepath('node') }
  vim.list_extend(candidates, nvm)
  local rejected = {}
  for _, candidate in ipairs(candidates) do
    local major = node_major(candidate)
    if major >= MIN_NODE then
      return candidate
    elseif major > 0 then
      table.insert(rejected, candidate .. ' (v' .. major .. ')')
    end
  end
  if not quiet then
    log('error', 'Node.js ' .. MIN_NODE .. ' or newer not found'
      .. (#rejected > 0 and '; too old: ' .. table.concat(rejected, ', ') or '') .. '. Set g:seqcall_node.')
  end
  return ''
end

--- Plugin layout (node/stdio-host.cjs) or the repository (packages/stdio-host/dist); an explicit
--- g:seqcall_sidecar must exist.
function M.sidecar(quiet)
  local configured = setting('sidecar', '')
  if configured ~= '' then
    if readable(configured) then
      return configured
    end
    if not quiet then
      log('error', 'g:seqcall_sidecar not found: ' .. configured)
    end
    return ''
  end
  for _, candidate in ipairs({ root .. '/node/stdio-host.cjs', vim.fs.normalize(root .. '/../stdio-host/dist/stdio-host.cjs') }) do
    if readable(candidate) then
      return candidate
    end
  end
  if not quiet then
    log('error', 'sidecar stdio-host.cjs not found (build it: npm run build -w @seqcall/stdio-host, or set g:seqcall_sidecar)')
  end
  return ''
end

function M.csharp_sidecar()
  local bundled = root .. '/csharp/Seqcall.CSharp.dll'
  return setting('csharp_sidecar', readable(bundled) and bundled or '')
end

--- C#: the sidecar runs `dotnet` from the PATH or $SEQCALL_DOTNET. g:seqcall_dotnet, else a user-local
--- ~/.dotnet install when there is none on the PATH (as in Rider and Vim).
function M.dotnet()
  local dotnet = setting('dotnet', '')
  local idotnet = (vim.env.HOME or '') .. '/.dotnet/dotnet'
  if dotnet == '' and (vim.env.SEQCALL_DOTNET or '') == '' and vim.fn.executable('dotnet') == 0 and vim.fn.executable(idotnet) == 1 then
    dotnet = idotnet
  end
  return dotnet
end

-- ───────────────────────────── Sidecar process ─────────────────────────────

local function running()
  return state.job ~= nil and vim.fn.jobwait({ state.job }, 0)[1] == -1
end

local function send(msg)
  msg.jsonrpc = '2.0'
  vim.fn.chansend(state.job, vim.json.encode(msg) .. '\n')
end

local function request(method, params)
  state.pending[state.next_id] = method
  send({ id = state.next_id, method = method, params = params })
  state.next_id = state.next_id + 1
end

local function notify(method, params)
  send({ method = method, params = params })
end

local function position()
  local col = vim.fn.utf16idx(vim.fn.getline('.'), vim.fn.col('.') - 1)
  return { line = vim.fn.line('.') - 1, character = math.max(0, col) }
end

local function caret()
  local pos = position()
  return vim.fn.expand('%:p') .. ':' .. pos.line .. ':' .. pos.character
end

--- g:seqcall_browser / setup{browser}: a command (string or list, the URL is appended) or a function
--- taking the URL (g:Seqcall_browser for a Vim Funcref); default vim.ui.open.
local function open_browser(url)
  log('info', 'open ' .. url)
  local browser = config.browser or vim.g.Seqcall_browser or vim.g.seqcall_browser
  if type(browser) == 'function' then
    browser(url)
    return
  end
  if type(browser) == 'table' then
    vim.fn.jobstart(vim.list_extend(vim.deepcopy(browser), { url }), { detach = true })
  elseif type(browser) == 'string' and browser ~= '' then
    vim.fn.jobstart({ browser, url }, { detach = true })
  else
    local _, err = vim.ui.open(url)
    if err then
      log('error', 'could not open the browser (' .. err .. '); set g:seqcall_browser. The URL is in :SeqcallLog')
      return
    end
  end
  -- Not the URL itself: a long message is cut at the window width, and a shortened URL has no valid token.
  vim.api.nvim_echo({ { 'Seqcall: diagram opened in the browser (:SeqcallOpen to reopen)' } }, true, {})
end

--- A click in the diagram: the file in a window (`:drop` reuses an open one), cursor on the range start.
local function navigate(range)
  vim.cmd('drop ' .. vim.fn.fnameescape(range.file))
  local lnum = range.start.line + 1
  local byte = vim.fn.byteidx(vim.fn.getline(lnum), range.start.character, true)
  vim.api.nvim_win_set_cursor(0, { lnum, byte < 0 and 0 or byte })
  vim.cmd('normal! zv')
  state.last_caret = caret()
end

--- FR-24.7 a reviewed call side by side: the merge-base content in a scratch window left of the file, both in diff mode.
function M.open_diff(t)
  for _, w in ipairs(vim.api.nvim_list_wins()) do
    if vim.b[vim.api.nvim_win_get_buf(w)].seqcall_base then
      pcall(vim.api.nvim_win_close, w, true)
    end
  end
  vim.cmd('drop ' .. vim.fn.fnameescape(t.file))
  vim.cmd('diffoff')
  local ft = vim.bo.filetype
  local lines = vim.split(t.baseText, '\n', { plain = true })
  if #lines > 1 and lines[#lines] == '' then
    table.remove(lines)
  end
  vim.cmd('leftabove vertical new')
  vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
  vim.bo.buftype, vim.bo.bufhidden, vim.bo.swapfile, vim.bo.modifiable = 'nofile', 'wipe', false, false
  vim.b.seqcall_base = true
  vim.bo.filetype = ft
  pcall(vim.cmd, 'file ' .. vim.fn.fnameescape('[base] ' .. t.title))
  vim.cmd('diffthis')
  vim.cmd('wincmd p')
  vim.cmd('diffthis')
  vim.api.nvim_win_set_cursor(0, { t.line + 1, 0 })
  vim.cmd('normal! zvzz')
  state.last_caret = caret()
end

local function on_line(line)
  local ok, msg = pcall(vim.json.decode, line, { luanil = { object = true, array = true } })
  if not ok or type(msg) ~= 'table' then
    log('error', 'unreadable sidecar output: ' .. line)
    return
  end
  if msg.id ~= nil then
    local method = state.pending[msg.id] or ''
    state.pending[msg.id] = nil
    if msg.error then
      log('error', method .. ': ' .. tostring(msg.error.message))
    elseif method == 'initialize' then
      log('info', 'sidecar ' .. msg.result.version .. ' on Node ' .. msg.result.node .. ', diagrams at ' .. msg.result.browser.sequence)
    elseif method == 'describeAt' then
      M.show_info(msg.result)
    elseif method == 'memory' then
      for _, line in ipairs(msg.result.lines) do
        log('info', line)
      end
      vim.api.nvim_echo({ { 'Seqcall: ' .. msg.result.summary .. ' (:SeqcallLog for each project, :SeqcallFreeMemory to free)' } }, true, {})
    elseif method == 'freeMemory' then
      vim.api.nvim_echo({ { 'Seqcall: ' .. msg.result } }, true, {})
    end
    return
  end
  local params = msg.params or {}
  if msg.method == 'openBrowser' then
    open_browser(params.url)
  elseif msg.method == 'navigate' then
    navigate(params.range)
  elseif msg.method == 'openDiff' then
    M.open_diff(params)
  elseif msg.method == 'log' then
    log(params.level, params.message)
  elseif msg.method == 'progress' then
    vim.api.nvim_echo({ { params.title and 'Seqcall: ' .. params.title or '' } }, false, {})
  end
end

local function start()
  if running() then
    return true
  end
  local node = M.node()
  local script = node ~= '' and M.sidecar() or ''
  if script == '' then
    return false
  end
  local cmd = { node, script, '--browser', '--workspace', vim.fn.getcwd() }
  local csharp = M.csharp_sidecar()
  if csharp ~= '' then
    vim.list_extend(cmd, { '--csharp-sidecar', csharp })
  end
  if setting('port', 0) > 0 then
    vim.list_extend(cmd, { '--port', tostring(setting('port', 0)) })
  end
  local dotnet = M.dotnet()
  state.partial, state.stderr, state.pending = '', {}, {}
  local job = vim.fn.jobstart(cmd, {
    env = dotnet ~= '' and { SEQCALL_DOTNET = dotnet, DOTNET_ROOT = vim.fn.fnamemodify(dotnet, ':h') } or nil,
    -- stdout arrives in chunks: the first item continues the last partial line, the last is partial.
    on_stdout = function(_, data)
      data[1] = state.partial .. data[1]
      state.partial = table.remove(data)
      for _, line in ipairs(data) do
        if line ~= '' then
          on_line(line)
        end
      end
    end,
    on_stderr = function(_, data)
      for _, line in ipairs(data) do
        if line ~= '' then
          table.insert(state.stderr, line)
          if #state.stderr > 20 then
            table.remove(state.stderr, 1)
          end
          log('info', '[sidecar] ' .. line)
        end
      end
    end,
    -- Neovim delivers the remaining output before on_exit: the reason is already in stderr.
    on_exit = function(_, code)
      if code ~= 0 and code ~= 143 then
        log('error', 'the sidecar stopped (exit ' .. code .. '): ' .. table.concat(vim.list_slice(state.stderr, #state.stderr - 2), ' | '))
      end
    end,
  })
  if job <= 0 then
    log('error', 'could not start ' .. table.concat(cmd, ' '))
    return false
  end
  state.job = job
  log('info', 'started ' .. table.concat(cmd, ' '))
  request('initialize', { workspace = vim.fn.getcwd() })
  return true
end

-- ───────────────────────────── Commands ─────────────────────────────

--- :SeqcallShow — the sequence diagram of the method at the cursor (FR-1.1).
function M.show()
  local file = vim.fn.expand('%:p')
  if not readable(file) then
    log('error', 'save the file first: diagrams are drawn from the files on disk')
    return
  end
  if vim.bo.modified then
    vim.api.nvim_echo({ { 'Seqcall: the buffer has unsaved changes; the diagram shows the saved file' } }, true, {})
  end
  if not start() then
    return
  end
  state.last_caret = caret()
  request('openAt', { file = file, position = position() })
end

--- :SeqcallOpen / :SeqcallClass — (re)open a view's page. the sequence page also before any
--- diagram (it offers ⌂ Entry points), starting the sidecar; the class page needs a flow.
function M.show_view(view)
  if not running() and view ~= 'sequence' then
    log('error', 'no diagram yet: run :SeqcallShow in a method first')
    return
  end
  if not start() then
    return
  end
  request('showView', { view = view })
end

--- :SeqcallEntryPoints — where flows start (routes, commands, jobs, tests), in the sequence page.
function M.entry_points()
  if not start() then
    return
  end
  request('showEntryPoints', vim.empty_dict())
end

function M.stop()
  if running() then
    request('shutdown', vim.empty_dict())
  end
end

-- ───────────────────────────── Info at Caret (FR-33.6), memory (FR-34.4) ─────────────────────────────

--- :SeqcallInfo — what Seqcall knows about the call or the method name at the cursor (which implementation runs,
--- the entry points that reach it, I/O), in a floating window there.
function M.info()
  local file = vim.fn.expand('%:p')
  if not readable(file) then
    log('error', 'save the file first: Seqcall reads the files on disk')
    return
  end
  if not start() then
    return
  end
  state.last_info = { file = file, position = position(), word = vim.fn.expand('<cword>'), routes = {} }
  request('describeAt', { file = file, position = state.last_info.position, word = state.last_info.word })
end

--- The answer to :SeqcallInfo: the numbered lines in a float at the cursor (closed when the cursor moves).
function M.show_info(r)
  if type(r) ~= 'table' then
    vim.api.nvim_echo({ { 'Seqcall: nothing to say about this' } }, false, {})
    return
  end
  state.last_info.routes = r.routes
  local lines = vim.list_extend({}, r.plain)
  table.insert(lines, '')
  table.insert(lines, #r.routes == 0 and ':SeqcallShow opens the diagram' or ':SeqcallReach [n] opens a flow down to here · :SeqcallShow the diagram')
  M.last_popup = lines
  vim.lsp.util.open_floating_preview(lines, 'text', { border = 'single', title = ' Seqcall ', focus_id = 'seqcall-info' })
end

--- :SeqcallReach [n] — FR-33.7 entry point n of the last :SeqcallInfo opens its flow down to the method; without n
--- a list of all of them, the last row its Paths to here.
function M.reach(arg)
  local info = state.last_info
  if not info or #info.routes == 0 then
    log('error', 'run :SeqcallInfo on a method name that entry points reach first')
    return
  end
  if not start() then
    return
  end
  local params = { file = info.file, position = info.position, word = info.word }
  local open = function(n)
    if n > #info.routes then
      request('openReach', params)
    else
      request('openReach', vim.tbl_extend('force', params, { index = n - 1 }))
    end
  end
  if arg and arg ~= '' then
    local n = tonumber(arg)
    if not n or n < 1 or n > #info.routes then
      log('error', 'no entry point ' .. arg .. ' (1 to ' .. #info.routes .. ')')
      return
    end
    return open(n)
  end
  local rows = vim.list_extend({}, info.routes)
  table.insert(rows, 'Show all in Paths to here')
  vim.ui.select(rows, { prompt = 'Seqcall: open the flow down to ' .. info.word .. ' of' }, function(_, n)
    if n then
      open(n)
    end
  end)
end

--- :SeqcallMemory — what Seqcall uses: its own process, the C# analysis of each loaded project (details in :SeqcallLog).
function M.memory()
  if not running() then
    vim.api.nvim_echo({ { 'Seqcall: not running (nothing loaded)' } }, false, {})
    return
  end
  request('memory', vim.empty_dict())
end

--- :SeqcallFreeMemory — drop the caches and stop the C# analysis (it loads again with the next diagram).
function M.free_memory()
  if not running() then
    vim.api.nvim_echo({ { 'Seqcall: not running (nothing loaded)' } }, false, {})
    return
  end
  request('freeMemory', vim.empty_dict())
end

--- FR-13.1: a saved file refreshes the diagram.
function M.on_write(file)
  if running() then
    notify('filesChanged', { files = { file } })
  end
end

--- FR-2.4: the call at the cursor is highlighted in the diagram (debounced).
function M.on_cursor_moved()
  if not running() or not setting('follow_cursor', true) or setting('follow_cursor', true) == 0 then
    return
  end
  if state.timer then
    vim.fn.timer_stop(state.timer)
  end
  state.timer = vim.fn.timer_start(150, function()
    state.timer = nil
    local file = vim.fn.expand('%:p')
    local now = caret()
    if file == '' or now == state.last_caret or not running() then
      return
    end
    state.last_caret = now
    notify('caretMoved', { file = file, position = position() })
  end)
end

--- FR-30.6 :SeqcallUpdate: the sidecar replaces this plugin folder by the latest GitHub release; the new version
--- runs after a restart.
function M.update()
  local node = M.node()
  if node == '' then
    return
  end
  local script = root .. '/node/stdio-host.cjs'
  if not readable(script) then
    log('error', ':SeqcallUpdate updates an unpacked release package; ' .. root .. ' is not one (update it the way you installed it)')
    return
  end
  M.stop()
  vim.notify('Seqcall: checking for updates...')
  vim.system({ node, script, '--update', root }, { text = true }, function(res)
    vim.schedule(function()
      for line in (res.stdout or ''):gmatch('[^\n]+') do
        log('info', line)
        vim.notify('Seqcall: ' .. line)
      end
      if res.code ~= 0 then
        log('error', 'update failed (exit ' .. res.code .. '), see :SeqcallLog')
      end
    end)
  end)
end

function M.show_log()
  vim.cmd('noswapfile new')
  vim.bo.buftype, vim.bo.bufhidden = 'nofile', 'wipe'
  vim.api.nvim_buf_set_name(0, 'Seqcall log')
  vim.api.nvim_buf_set_lines(0, 0, -1, false, state.log)
  vim.bo.modifiable = false
end

return M
