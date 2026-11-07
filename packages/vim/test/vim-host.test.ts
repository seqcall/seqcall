import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO, nvimOk, nvimPrelude, prelude, runVim, spawnVim, vimOk, waitForFile, type Editor } from './helpers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-vim-host-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake `node` that only answers `--version`. */
function fakeNode(dir: string, version: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = `${dir}/node`;
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  return file;
}

const CONTROLLER = `${REPO}/fixtures/sample-app/src/controllers/user-controller.ts`;

/** Node installations for the lookup test, per editor (own directories). */
function nodes(base: string) {
  const home = `${base}/home`;
  fakeNode(`${home}/.nvm/versions/node/v18.0.0/bin`, 'v18.0.0');
  fakeNode(`${home}/.nvm/versions/node/v20.9.0/bin`, 'v20.9.0');
  return {
    base,
    home,
    old: fakeNode(`${base}/path`, 'v16.20.0'), // `node` on PATH, too old
    node22: fakeNode(`${base}/n22`, 'v22.3.0'),
    node24: fakeNode(`${base}/n24`, 'v24.1.0'),
    nvm20: fakeNode(`${home}/.nvm/versions/node/v20.10.0/bin`, 'v20.10.0'), // newer than v20.9.0 (numeric, not string order)
  };
}
type Nodes = ReturnType<typeof nodes>;

const lookupScripts: Record<Editor, (n: Nodes, out: string) => string> = {
  vim: (n, out) => `${prelude()}
$HOME = '${n.home}'
$PATH = '${n.base}/path:/usr/bin:/bin'
$SEQCALL_NODE = ''
var r = {}
r.nvm = seqcall#Node()
$SEQCALL_NODE = '${n.node22}'
r.env = seqcall#Node()
g:seqcall_node = '${n.node24}'
r.setting = seqcall#Node()
g:seqcall_node = '${n.old}'
r.oldSetting = seqcall#Node()
unlet g:seqcall_node
$SEQCALL_NODE = ''
$HOME = '${n.base}/empty-home'
messages clear
r.none = seqcall#Node()
r.messages = execute('messages')
writefile([json_encode(r)], '${out}')
qa!
`,
  nvim: (n, out) => `${nvimPrelude()}
local cs = require('seqcall')
vim.env.HOME = '${n.home}'
vim.env.PATH = '${n.base}/path:/usr/bin:/bin'
vim.env.SEQCALL_NODE = nil
local r = {}
r.nvm = cs.node()
vim.env.SEQCALL_NODE = '${n.node22}'
r.env = cs.node()
vim.g.seqcall_node = '${n.node24}'
r.setting = cs.node()
vim.g.seqcall_node = '${n.old}'
r.oldSetting = cs.node()
vim.g.seqcall_node = nil
vim.env.SEQCALL_NODE = nil
vim.env.HOME = '${n.base}/empty-home'
notes = {}
r.none = cs.node()
r.messages = messages()
report('${out}', r)
vim.cmd('qa!')
`,
};

/** dotnet for C#: setting, else nothing when dotnet is on the PATH or $SEQCALL_DOTNET is set, else ~/.dotnet/dotnet. */
const dotnetScripts: Record<Editor, (base: string, out: string) => string> = {
  vim: (base, out) => `${prelude()}
$HOME = '${base}/home'
$PATH = '${base}/empty'
$SEQCALL_DOTNET = ''
var r = {}
r.local = seqcall#Dotnet()
$PATH = '${base}/bin'
r.onPath = seqcall#Dotnet()
$PATH = '${base}/empty'
$SEQCALL_DOTNET = '/opt/dotnet/dotnet'
r.env = seqcall#Dotnet()
g:seqcall_dotnet = '/custom/dotnet'
r.setting = seqcall#Dotnet()
writefile([json_encode(r)], '${out}')
qa!
`,
  nvim: (base, out) => `${nvimPrelude()}
local cs = require('seqcall')
vim.env.HOME = '${base}/home'
vim.env.PATH = '${base}/empty'
vim.env.SEQCALL_DOTNET = nil
local r = {}
r['local'] = cs.dotnet()
vim.env.PATH = '${base}/bin'
r.onPath = cs.dotnet()
vim.env.PATH = '${base}/empty'
vim.env.SEQCALL_DOTNET = '/opt/dotnet/dotnet'
r.env = cs.dotnet()
vim.g.seqcall_dotnet = '/custom/dotnet'
r.setting = cs.dotnet()
report('${out}', r)
vim.cmd('qa!')
`,
};

const errorScripts: Record<Editor, (crash: string, out: string) => string> = {
  vim: (crash, out) => `${prelude()}
g:seqcall_node = '${process.execPath}'
var r = {}
enew
messages clear
SeqcallShow
r.noFile = execute('messages')
SeqcallClass
r.noDiagram = execute('messages')
edit ${CONTROLLER}
setline(1, getline(1))
set modified
g:seqcall_sidecar = '/nonexistent/stdio-host.cjs'
messages clear
SeqcallShow
r.wrongSidecar = execute('messages')
set nomodified
g:seqcall_sidecar = '${crash}'
messages clear
SeqcallShow
WaitFor(() => execute('messages') =~ 'stopped', 100)
r.crash = execute('messages')
SeqcallLog
r.log = join(getline(1, '$'), "\\n")
writefile([json_encode(r)], '${out}')
qa!
`,
  nvim: (crash, out) => `${nvimPrelude()}
vim.g.seqcall_node = '${process.execPath}'
local r = {}
vim.cmd('enew')
vim.cmd('SeqcallShow')
r.noFile = messages()
vim.cmd('SeqcallClass')
r.noDiagram = messages()
vim.cmd('edit ${CONTROLLER}')
vim.bo.modified = true
vim.g.seqcall_sidecar = '/nonexistent/stdio-host.cjs'
notes = {}
vim.cmd('messages clear')
vim.cmd('SeqcallShow')
r.wrongSidecar = messages()
vim.bo.modified = false
vim.g.seqcall_sidecar = '${crash}'
notes = {}
vim.cmd('messages clear')
vim.cmd('SeqcallShow')
wait_for(function() return messages():find('stopped') ~= nil end, 10000)
r.crash = messages()
vim.cmd('SeqcallLog')
r.log = table.concat(vim.api.nvim_buf_get_lines(0, 0, -1, false), '\\n')
report('${out}', r)
vim.cmd('qa!')
`,
};

/**
 * The default browser (no setting): a fake xdg-open on the PATH records its arguments. The editor waits
 * until the sidecar reports the test's shortened URL, then writes its messages.
 */
const defaultBrowserScripts: Record<Editor, (app: string, out: string) => string> = {
  vim: (app, out) => `${prelude()}
unlet g:Seqcall_browser
cd ${app}
edit src/controllers/user-controller.ts
search('this.validate(id);')
messages clear
SeqcallShow
WaitFor(() => execute('messages') =~ 'without the current token', 200)
writefile([json_encode({messages: execute('messages')})], '${out}')
SeqcallStop
sleep 500m
qa!
`,
  nvim: (app, out) => `${nvimPrelude()}
require('seqcall').setup({ browser = false })
vim.cmd('cd ${app}')
vim.cmd('edit src/controllers/user-controller.ts')
vim.fn.search('this.validate(id);')
vim.cmd('messages clear')
vim.cmd('SeqcallShow')
wait_for(function() return messages():find('without the current token') ~= nil end, 20000)
report('${out}', { messages = messages() })
vim.cmd('SeqcallStop')
vim.wait(500)
vim.cmd('qa!')
`,
};

/** FR-24.7 openDiff: the base content in a scratch window left of the file, both in diff mode, the cursor on the call. */
const diffScripts: Record<Editor, (file: string, out: string) => string> = {
  vim: (file, out) => `${prelude()}
writefile(['one', 'two', 'three'], '${file}')
seqcall#OpenDiff({file: '${file}', line: 2, baseText: "one\\nold\\n", title: 'a.ts (develop ↔ x)'})
const base = filter(getwininfo(), (_, w) => getbufvar(w.bufnr, 'seqcall_base', 0))
writefile([json_encode({wins: winnr('$'), file: expand('%:p'), line: line('.'), diff: &diff, base: getbufline(base[0].bufnr, 1, '$'), baseDiff: getwinvar(base[0].winid, '&diff'), name: bufname(base[0].bufnr)})], '${out}')
qa!
`,
  nvim: (file, out) => `${nvimPrelude()}
vim.fn.writefile({ 'one', 'two', 'three' }, '${file}')
require('seqcall').open_diff({ file = '${file}', line = 2, baseText = 'one\\nold\\n', title = 'a.ts (develop ↔ x)' })
local base
for _, w in ipairs(vim.api.nvim_list_wins()) do
  if vim.b[vim.api.nvim_win_get_buf(w)].seqcall_base then base = w end
end
local b = vim.api.nvim_win_get_buf(base)
report('${out}', { wins = vim.fn.winnr('$'), file = vim.fn.expand('%:p'), line = vim.fn.line('.'), diff = vim.wo.diff and 1 or 0, base = vim.api.nvim_buf_get_lines(b, 0, -1, false), baseDiff = vim.wo[base].diff and 1 or 0, name = vim.api.nvim_buf_get_name(b) })
vim.cmd('qa!')
`,
};

const editors: { editor: Editor; ok: boolean; fr: (n: number) => string }[] = [
  { editor: 'vim', ok: vimOk, fr: (n) => `FR-21.${n}` },
  { editor: 'nvim', ok: nvimOk, fr: (n) => `FR-21.5 / FR-21.${n}` },
];

for (const { editor, ok, fr } of editors) {
  describe.runIf(ok)(`${editor} plugin host logic (FR-21)`, () => {
    it(`FR-24.7 ${editor}: a reviewed call side by side — the base version in a scratch diff window, the cursor on the call`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `seqcall-diff-${editor}-`));
      const file = `${dir}/a.ts`;
      const out = `${dir}/out.json`;
      const r = await runVim<Record<string, unknown>>(dir, diffScripts[editor](file, out), out, undefined, editor);
      expect({ ...r, diff: Number(r.diff), baseDiff: Number(r.baseDiff) }).toMatchObject({ wins: 2, file, line: 3, diff: 1, base: ['one', 'old'], baseDiff: 1 });
      expect(String(r.name)).toContain('[base] a.ts');
    });

    it(`${fr(3)} Node lookup: setting, then $SEQCALL_NODE, then PATH, then the newest nvm installation; old versions are skipped and named`, async () => {
      const n = nodes(`${tmp}/${editor}`);
      const out = `${n.base}/node.json`;
      const r = await runVim<Record<string, string>>(n.base, lookupScripts[editor](n, out), out, undefined, editor);
      expect(r.nvm).toBe(n.nvm20);
      expect(r.env).toBe(n.node22);
      expect(r.setting).toBe(n.node24);
      expect(r.oldSetting).toBe(n.node22); // a too-old setting is skipped, the next candidate wins
      expect(r.none).toBe('');
      expect(r.messages).toContain('Node.js 20 or newer not found');
      expect(r.messages).toContain(`${n.old} (v16)`);
    });

    it(`${fr(3)} dotnet for C#: the setting, else the PATH / $SEQCALL_DOTNET, else ~/.dotnet (a desktop-started editor often lacks it on the PATH)`, async () => {
      const base = `${tmp}/${editor}-dotnet`;
      fs.mkdirSync(`${base}/home/.dotnet`, { recursive: true });
      fs.mkdirSync(`${base}/bin`, { recursive: true });
      // PATH without dotnet: an empty directory, not /usr/bin (CI images install dotnet there).
      fs.mkdirSync(`${base}/empty`, { recursive: true });
      fs.writeFileSync(`${base}/home/.dotnet/dotnet`, '#!/bin/sh\n', { mode: 0o755 });
      fs.writeFileSync(`${base}/bin/dotnet`, '#!/bin/sh\n', { mode: 0o755 });
      const out = `${base}/dotnet.json`;
      const r = await runVim<Record<string, string>>(base, dotnetScripts[editor](base, out), out, undefined, editor);
      expect(r).toEqual({ local: `${base}/home/.dotnet/dotnet`, onPath: '', env: '', setting: '/custom/dotnet' });
    });

    it(`${fr(2)} errors are reported, not thrown: no file, unsaved changes, wrong sidecar path, a crashing sidecar, :SeqcallClass before a diagram`, async () => {
      const dir = `${tmp}/${editor}-errors`;
      fs.mkdirSync(dir, { recursive: true });
      const crash = `${dir}/crash.js`;
      fs.writeFileSync(crash, "console.error('boom: cannot start'); process.exit(3);\n");
      const out = `${dir}/errors.json`;
      const r = await runVim<Record<string, string>>(dir, errorScripts[editor](crash, out), out, undefined, editor);
      expect(r.noFile).toContain('save the file first');
      expect(r.noDiagram).toContain('no diagram yet');
      expect(r.wrongSidecar).toContain('unsaved changes');
      expect(r.wrongSidecar).toContain('g:seqcall_sidecar not found: /nonexistent/stdio-host.cjs');
      expect(r.crash).toMatch(/the sidecar stopped \(exit 3\): .*boom: cannot start/);
      // Only the crashing sidecar was started: no process for the missing file / wrong path.
      expect(r.log.match(/ started /g)).toHaveLength(1);
    });

    it(`${fr(2)} the default browser gets the full URL; the message line does not show it (it would be cut at the window width); a shortened URL is reported`, async () => {
      const dir = `${tmp}/${editor}-browser`;
      fs.mkdirSync(`${dir}/bin`, { recursive: true });
      fs.cpSync(`${REPO}/fixtures/sample-app`, `${dir}/app`, { recursive: true });
      const opened = `${dir}/xdg-open.txt`;
      fs.writeFileSync(`${dir}/bin/xdg-open`, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${opened}\n`, { mode: 0o755 });
      const out = `${dir}/browser.json`;
      const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` };
      const { vim, exited } = spawnVim(dir, defaultBrowserScripts[editor](`${dir}/app`, out), env, editor);
      try {
        const url = (await waitForFile(opened)).trim();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sequence\?t=[0-9a-f]{32}$/); // one argument, the whole token
        // What a copy from an 80-column message line gave: the token cut to 24 characters.
        expect((await fetch(url.slice(0, -8))).status).toBe(403);
        expect(await exited).toBe(0);
        const { messages } = JSON.parse(fs.readFileSync(out, 'utf8'));
        expect(messages).toContain('Seqcall: diagram opened in the browser (:SeqcallOpen to reopen)');
        expect(messages).not.toContain('?t=');
        expect(messages).toMatch(/without the current token .*use :SeqcallOpen/);
      } finally {
        vim.kill();
      }
    });
  });
}

describe.runIf(nvimOk)('Neovim health check (FR-21.5)', () => {
  it('FR-21.5 :checkhealth seqcall reports Node, the sidecar and C#', async () => {
    const dir = `${tmp}/health`;
    fs.mkdirSync(dir, { recursive: true });
    const out = `${dir}/health.json`;
    const r = await runVim<{ lines: string[] }>(
      dir,
      `${nvimPrelude()}
vim.g.seqcall_node = '${process.execPath}'
vim.cmd('checkhealth seqcall')
report('${out}', { lines = vim.api.nvim_buf_get_lines(0, 0, -1, false) })
vim.cmd('qa!')
`,
      out,
      undefined,
      'nvim',
    );
    const text = r.lines.join('\n');
    expect(text).toMatch(/OK Node\.js: .*node \(v2\d/);
    expect(text).toMatch(/OK Sidecar: .*stdio-host\.cjs/);
    expect(text).toMatch(/C# sidecar/); // OK with the bundled one, a warning without
    expect(text).not.toMatch(/ERROR/);
  });
});
