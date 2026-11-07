vim9script
# Seqcall for Vim (FR-21): starts the Node sidecar (packages/stdio-host) in browser mode, sends it
# the caret, saved files and cursor moves, opens the diagram pages it names in the browser and jumps
# to the code when a diagram element is clicked. Protocol: newline-delimited JSON-RPC 2.0 on stdio,
# see docs/VIM-PLUGIN.md and docs/RIDER-PLUGIN.md.

const root = expand('<sfile>:p:h:h')
const MIN_NODE = 20

var sidecar: job = null_job
var next_id = 1
var pending: dict<string> = {}
var log_lines: list<string> = []
var stderr_tail: list<string> = []
var caret_timer = 0
var last_caret = ''
# FR-33.7 where the last :SeqcallInfo asked, and the entry points it found (for :SeqcallReach)
var last_info: dict<any> = {}

def Setting(name: string, default: any): any
  return get(g:, 'seqcall_' .. name, default)
enddef

def Running(): bool
  return sidecar != null_job && job_status(sidecar) == 'run'
enddef

def Log(level: string, text: string)
  add(log_lines, strftime('%H:%M:%S') .. ' ' .. level .. ' ' .. text)
  if len(log_lines) > 1000
    remove(log_lines, 0, 199)
  endif
  if level == 'error'
    echohl ErrorMsg
    echomsg 'Seqcall: ' .. text
    echohl None
  endif
enddef

# ───────────────────────────── Locating Node and the sidecar ─────────────────────────────

def VersionOf(path: string): number
  var m = matchlist(path, 'v\(\d\+\)\.\(\d\+\)')
  return empty(m) ? 0 : str2nr(m[1]) * 1000 + str2nr(m[2])
enddef

def NodeMajor(node: string): number
  if empty(node) || !executable(node)
    return 0
  endif
  var out = trim(system(shellescape(node) .. ' --version'))
  return v:shell_error != 0 ? 0 : str2nr(matchstr(out, '^v\zs\d\+'))
enddef

# Setting → $SEQCALL_NODE → PATH → newest nvm installation (a GUI Vim often has no nvm on its PATH).
# `:echo seqcall#Node()` shows the choice ('' and an error naming rejected versions when none fits).
export def Node(): string
  var nvm = glob('~/.nvm/versions/node/v*/bin/node', false, true)
  sort(nvm, (a, b) => VersionOf(b) - VersionOf(a))
  var rejected: list<string> = []
  for candidate in [Setting('node', ''), $SEQCALL_NODE, exepath('node')] + nvm
    var major = NodeMajor(candidate)
    if major >= MIN_NODE
      return candidate
    elseif major > 0
      add(rejected, candidate .. ' (v' .. major .. ')')
    endif
  endfor
  Log('error', 'Node.js ' .. MIN_NODE .. ' or newer not found' .. (empty(rejected) ? '' : '; too old: ' .. join(rejected, ', ')) .. '. Set g:seqcall_node.')
  return ''
enddef

# Plugin layout (node/stdio-host.cjs) or the repository (packages/stdio-host/dist).
def FindSidecar(): string
  var configured: string = Setting('sidecar', '')
  if !empty(configured)
    if filereadable(configured)
      return configured
    endif
    Log('error', 'g:seqcall_sidecar not found: ' .. configured)
    return ''
  endif
  for candidate in [root .. '/node/stdio-host.cjs', simplify(root .. '/../stdio-host/dist/stdio-host.cjs')]
    if !empty(candidate) && filereadable(candidate)
      return candidate
    endif
  endfor
  Log('error', 'sidecar stdio-host.cjs not found (build it: npm run build -w @seqcall/stdio-host, or set g:seqcall_sidecar)')
  return ''
enddef

# C#: the sidecar runs `dotnet` from the PATH or $SEQCALL_DOTNET. g:seqcall_dotnet, else a user-local
# ~/.dotnet install when there is none on the PATH (as in Rider: a desktop-started Vim often lacks it).
# `:echo seqcall#Dotnet()`: the dotnet passed to the sidecar ('' = the sidecar's own: PATH / $SEQCALL_DOTNET).
export def Dotnet(): string
  var dotnet: string = Setting('dotnet', '')
  if empty(dotnet) && empty($SEQCALL_DOTNET) && !executable('dotnet') && executable($HOME .. '/.dotnet/dotnet')
    dotnet = $HOME .. '/.dotnet/dotnet'
  endif
  return dotnet
enddef

def DotnetEnv(): dict<string>
  var dotnet = Dotnet()
  return empty(dotnet) ? {} : {SEQCALL_DOTNET: dotnet, DOTNET_ROOT: fnamemodify(dotnet, ':h')}
enddef

# ───────────────────────────── Sidecar process ─────────────────────────────

def Start(): bool
  if Running()
    return true
  endif
  var node = Node()
  var script = node == '' ? '' : FindSidecar()
  if script == ''
    return false
  endif
  var cmd = [node, script, '--browser', '--workspace', getcwd()]
  var csharp = Setting('csharp_sidecar', filereadable(root .. '/csharp/Seqcall.CSharp.dll') ? root .. '/csharp/Seqcall.CSharp.dll' : '')
  if !empty(csharp)
    extend(cmd, ['--csharp-sidecar', csharp])
  endif
  if Setting('port', 0) > 0
    extend(cmd, ['--port', string(Setting('port', 0))])
  endif
  stderr_tail = []
  sidecar = job_start(cmd, {mode: 'nl', out_cb: OnLine, err_cb: OnStderr, exit_cb: OnExit, stoponexit: 'term', env: DotnetEnv()})
  if job_status(sidecar) != 'run'
    Log('error', 'could not start ' .. join(cmd))
    return false
  endif
  Log('info', 'started ' .. join(cmd))
  Request('initialize', {workspace: getcwd()})
  return true
enddef

def Send(msg: dict<any>)
  ch_sendraw(job_getchannel(sidecar), json_encode(extend({jsonrpc: '2.0'}, msg)) .. "\n")
enddef

def Request(method: string, params: dict<any>)
  pending[string(next_id)] = method
  Send({id: next_id, method: method, params: params})
  next_id += 1
enddef

def Notify(method: string, params: dict<any>)
  Send({method: method, params: params})
enddef

def OnLine(_: channel, line: string)
  var msg: dict<any>
  try
    msg = json_decode(line)
  catch
    Log('error', 'unreadable sidecar output: ' .. line)
    return
  endtry
  if has_key(msg, 'id')
    var method = get(pending, string(msg.id), '')
    if has_key(pending, string(msg.id))
      remove(pending, string(msg.id))
    endif
    if has_key(msg, 'error')
      Log('error', method .. ': ' .. msg.error.message)
    elseif method == 'initialize'
      Log('info', 'sidecar ' .. msg.result.version .. ' on Node ' .. msg.result.node .. ', diagrams at ' .. msg.result.browser.sequence)
    elseif method == 'describeAt'
      ShowInfo(msg.result)
    elseif method == 'memory'
      ShowMemory(msg.result)
    elseif method == 'freeMemory'
      echomsg 'Seqcall: ' .. msg.result
    endif
    return
  endif
  var params: dict<any> = get(msg, 'params', {})
  if msg.method == 'openBrowser'
    OpenBrowser(params.url)
  elseif msg.method == 'navigate'
    Navigate(params.range)
  elseif msg.method == 'openDiff'
    OpenDiff(params)
  elseif msg.method == 'log'
    Log(params.level, params.message)
  elseif msg.method == 'progress'
    echo type(params.title) == v:t_none ? '' : 'Seqcall: ' .. params.title
  endif
enddef

def OnStderr(_: channel, line: string)
  add(stderr_tail, line)
  if len(stderr_tail) > 20
    remove(stderr_tail, 0)
  endif
  Log('info', '[sidecar] ' .. line)
enddef

var exit_status = 0

# exit_cb can come before the last stderr lines: report a crash a moment later, with its reason.
def OnExit(_: job, status: number)
  if status != 0
    exit_status = status
    timer_start(200, ReportExit)
  endif
enddef

def ReportExit(_: number)
  Log('error', 'the sidecar stopped (exit ' .. exit_status .. '): ' .. join(stderr_tail[-3 :], ' | '))
enddef

# ───────────────────────────── Editor actions ─────────────────────────────

# g:seqcall_browser: a command (string or list, the URL is appended); g:Seqcall_browser: a Funcref taking the URL.
def OpenBrowser(url: string)
  Log('info', 'open ' .. url)
  var browser: any = get(g:, 'Seqcall_browser', Setting('browser', ''))
  if type(browser) == v:t_func
    call(browser, [url])
    return
  endif
  var cmd: list<any> = type(browser) == v:t_list ? browser + [url]
    : !empty(browser) ? [browser, url]
    : has('mac') ? ['open', url] : ['xdg-open', url]
  if job_status(job_start(cmd, {stoponexit: '', in_io: 'null', out_io: 'null', err_io: 'null'})) == 'fail'
    Log('error', 'could not open the browser (' .. join(cmd) .. '); set g:seqcall_browser. The URL is in :SeqcallLog')
    return
  endif
  # Not the URL itself: a long message is cut at the window width, and a shortened URL has no valid token.
  echomsg 'Seqcall: diagram opened in the browser (:SeqcallOpen to reopen)'
enddef

# A click in the diagram: the file in a window (`:drop` reuses an open one), caret on the range start.
def Navigate(range: dict<any>)
  execute 'drop ' .. fnameescape(range.file)
  var lnum = range.start.line + 1
  var byte = byteidx(getline(lnum), range.start.character, true)
  cursor(lnum, byte < 0 ? 1 : byte + 1)
  normal! zv
  last_caret = Caret()
  redraw
enddef

# FR-24.7 a reviewed call side by side: the merge-base content in a scratch window left of the file, both in diff mode.
export def OpenDiff(t: dict<any>)
  for w in getwininfo()
    if getbufvar(w.bufnr, 'seqcall_base', 0)
      win_execute(w.winid, 'close')
    endif
  endfor
  execute 'drop ' .. fnameescape(t.file)
  diffoff
  var ft = &filetype
  var lines = split(t.baseText, "\n", true)
  if len(lines) > 1 && lines[-1] == ''
    remove(lines, -1)
  endif
  leftabove vertical new
  setline(1, lines)
  setlocal buftype=nofile bufhidden=wipe noswapfile nomodifiable
  b:seqcall_base = 1
  execute 'setlocal filetype=' .. ft
  silent! execute 'file ' .. fnameescape('[base] ' .. t.title)
  diffthis
  wincmd p
  diffthis
  cursor(t.line + 1, 1)
  normal! zvzz
  last_caret = Caret()
  redraw
enddef

# 0-based line, UTF-16 character (the protocol's Position).
def Position(): dict<number>
  return {line: line('.') - 1, character: max([0, utf16idx(getline('.'), col('.') - 1)])}
enddef

def Caret(): string
  var pos = Position()
  return expand('%:p') .. ':' .. pos.line .. ':' .. pos.character
enddef

# :SeqcallShow — the sequence diagram of the method at the caret (FR-1.1).
export def Show()
  var file = expand('%:p')
  if empty(file) || !filereadable(file)
    Log('error', 'save the file first: diagrams are drawn from the files on disk')
    return
  endif
  if &modified
    echomsg 'Seqcall: the buffer has unsaved changes; the diagram shows the saved file'
  endif
  if !Start()
    return
  endif
  last_caret = Caret()
  Request('openAt', {file: file, position: Position()})
enddef

# :SeqcallOpen / :SeqcallClass — (re)open a view's page. the sequence page also before any
# diagram (it offers ⌂ Entry points), starting the sidecar; the class page needs a flow.
export def ShowView(view: string)
  if !Running() && view != 'sequence'
    Log('error', 'no diagram yet: run :SeqcallShow in a method first')
    return
  endif
  if !Start()
    return
  endif
  Request('showView', {view: view})
enddef

# :SeqcallEntryPoints — where flows start (routes, commands, jobs, tests), in the sequence page.
export def EntryPoints()
  if !Start()
    return
  endif
  Request('showEntryPoints', {})
enddef

export def Stop()
  if Running()
    Request('shutdown', {})
  endif
enddef

# FR-13.1: a saved file refreshes the diagram.
export def OnWrite(file: string)
  if Running()
    Notify('filesChanged', {files: [file]})
  endif
enddef

# FR-2.4: the call at the caret is highlighted in the diagram (debounced).
export def OnCursorMoved()
  if !Running() || !Setting('follow_cursor', true)
    return
  endif
  timer_stop(caret_timer)
  caret_timer = timer_start(150, SendCaret)
enddef

def SendCaret(_: number)
  var file = expand('%:p')
  var caret = Caret()
  if empty(file) || caret == last_caret || !Running()
    return
  endif
  last_caret = caret
  Notify('caretMoved', {file: file, position: Position()})
enddef

# ───────────────────────────── Info at Caret (FR-33.6), memory (FR-34.4) ─────────────────────────────

# :SeqcallInfo — what Seqcall knows about the call or the method name at the caret (which implementation runs, the
# entry points that reach it, I/O), in a popup there.
export def Info()
  var file = expand('%:p')
  if empty(file) || !filereadable(file)
    Log('error', 'save the file first: Seqcall reads the files on disk')
    return
  endif
  if !Start()
    return
  endif
  last_info = {file: file, position: Position(), word: expand('<cword>'), routes: []}
  Request('describeAt', {file: file, position: last_info.position, word: last_info.word})
enddef

def ShowInfo(r: any)
  if type(r) != v:t_dict
    echo 'Seqcall: nothing to say about this'
    return
  endif
  last_info.routes = r.routes
  var lines = copy(r.plain)
  add(lines, '')
  add(lines, empty(r.routes) ? ':SeqcallShow opens the diagram' : ':SeqcallReach [n] opens a flow down to here · :SeqcallShow the diagram')
  InfoPopup(lines)
enddef

# The popup at the cursor, closed when the cursor moves (a function of its own: tests read the lines).
def InfoPopup(lines: list<string>)
  g:seqcall_last_popup = lines
  popup_atcursor(lines, {title: ' Seqcall ', border: [], padding: [0, 1, 0, 1], moved: 'any'})
enddef

# :SeqcallReach [n] — FR-33.7 entry point n of the last :SeqcallInfo opens its flow down to the method; without n
# a list of all of them, the last row its Paths to here.
export def Reach(arg: string)
  if empty(last_info) || empty(last_info.routes)
    Log('error', 'run :SeqcallInfo on a method name that entry points reach first')
    return
  endif
  if !Start()
    return
  endif
  var params = {file: last_info.file, position: last_info.position, word: last_info.word}
  var count = len(last_info.routes)
  var n = arg == '' ? ChooseRoute() : str2nr(arg)
  if n < 1 || n > count + 1 || (arg != '' && n > count)
    if arg != ''
      Log('error', 'no entry point ' .. arg .. ' (1 to ' .. count .. ')')
    endif
    return
  endif
  Request('openReach', n > count ? params : extend(params, {index: n - 1}))
enddef

def ChooseRoute(): number
  var rows = ['Seqcall: open the flow down to ' .. last_info.word .. ' of']
  rows += mapnew(last_info.routes, (i, label) => (i + 1) .. '. ' .. label)
  add(rows, (len(last_info.routes) + 1) .. '. Show all in Paths to here')
  return inputlist(rows)
enddef

# :SeqcallMemory — what Seqcall uses: its own process, the C# analysis of each loaded project (details in :SeqcallLog).
export def Memory()
  if !Running()
    echo 'Seqcall: not running (nothing loaded)'
    return
  endif
  Request('memory', {})
enddef

def ShowMemory(r: dict<any>)
  for line in r.lines
    Log('info', line)
  endfor
  echomsg 'Seqcall: ' .. r.summary .. ' (:SeqcallLog for each project, :SeqcallFreeMemory to free)'
enddef

# :SeqcallFreeMemory — drop the caches and stop the C# analysis (it loads again with the next diagram).
export def FreeMemory()
  if !Running()
    echo 'Seqcall: not running (nothing loaded)'
    return
  endif
  Request('freeMemory', {})
enddef

# ───────────────────────────── Update (FR-30.6) ─────────────────────────────

# :SeqcallUpdate: the sidecar replaces this plugin folder by the latest GitHub release; the new version runs after
# a restart.
export def Update()
  var node = Node()
  if node == ''
    return
  endif
  var script = root .. '/node/stdio-host.cjs'
  if !filereadable(script)
    Log('error', ':SeqcallUpdate updates an unpacked release package; ' .. root .. ' is not one (update it the way you installed it)')
    return
  endif
  Stop()
  echo 'Seqcall: checking for updates...'
  job_start([node, script, '--update', root], {mode: 'nl', out_cb: OnUpdateLine, err_cb: OnStderr, exit_cb: OnUpdateExit})
enddef

def OnUpdateLine(_: channel, line: string)
  Log('info', line)
  echomsg 'Seqcall: ' .. line
enddef

def OnUpdateExit(_: job, status: number)
  if status != 0
    Log('error', 'update failed (exit ' .. status .. '), see :SeqcallLog')
  endif
enddef

export def ShowLog()
  noswapfile new
  setlocal buftype=nofile bufhidden=wipe
  silent file Seqcall\ log
  setline(1, log_lines)
  setlocal nomodifiable
enddef
