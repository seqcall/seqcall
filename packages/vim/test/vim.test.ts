import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { events, intent } from '../../stdio-host/test/sse';
import { REPO, nvimOk, nvimPrelude, prelude, spawnVim, vimOk, waitForFile, type Editor } from './helpers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-vim-'));
// KEEP=1 keeps the scripts and their .err files (editor errors) for debugging.
afterAll(() => { if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); });

interface Files {
  app: string;
  urlFile: string;
  navFile: string;
  logFile: string;
  openedFile: string;
}

/**
 * The same session in both editors: show → page URL → (the test clicks) → cursor on the clicked call →
 * the cursor on the validate call, then back on the clicked call → save → class page, sequence page
 * again → log → stop. `:sleep` (Vim) / `vim.wait` (Neovim) run the channel and timer callbacks.
 */
const scripts: Record<Editor, (f: Files) => string> = {
  vim: (f) => `${prelude()}
cd ${f.app}
edit src/controllers/user-controller.ts
search('this.validate(id);')
const start = line('.')
SeqcallShow
WaitFor(() => !empty(g:opened))
writefile(g:opened, '${f.urlFile}')
WaitFor(() => line('.') != start)
const nav = [line('.'), col('.')]
writefile([expand('%:p'), string(nav[0]), string(nav[1])], '${f.navFile}')
cursor(start, 5)
doautocmd CursorMoved
sleep 500m
cursor(nav[0], nav[1])
doautocmd CursorMoved
sleep 500m
silent write
sleep 1500m
SeqcallClass
WaitFor(() => len(g:opened) >= 2, 50)
SeqcallOpen
WaitFor(() => len(g:opened) >= 3, 50)
writefile(g:opened, '${f.openedFile}')
SeqcallLog
writefile(getline(1, '$'), '${f.logFile}')
SeqcallStop
sleep 500m
qa!
`,
  nvim: (f) => `${nvimPrelude()}
vim.cmd('cd ${f.app}')
vim.cmd('edit src/controllers/user-controller.ts')
vim.fn.search('this.validate(id);')
local start = vim.fn.line('.')
vim.cmd('SeqcallShow')
wait_for(function() return #opened > 0 end)
vim.fn.writefile(opened, '${f.urlFile}')
wait_for(function() return vim.fn.line('.') ~= start end)
local nav = { vim.fn.line('.'), vim.fn.col('.') }
vim.fn.writefile({ vim.fn.expand('%:p'), tostring(nav[1]), tostring(nav[2]) }, '${f.navFile}')
vim.fn.cursor(start, 5)
vim.api.nvim_exec_autocmds('CursorMoved', {})
vim.wait(500)
vim.fn.cursor(nav[1], nav[2])
vim.api.nvim_exec_autocmds('CursorMoved', {})
vim.wait(500)
vim.cmd('silent write')
vim.wait(1500)
vim.cmd('SeqcallClass')
wait_for(function() return #opened >= 2 end, 5000)
vim.cmd('SeqcallOpen')
wait_for(function() return #opened >= 3 end, 5000)
vim.fn.writefile(opened, '${f.openedFile}')
vim.cmd('SeqcallLog')
vim.fn.writefile(vim.api.nvim_buf_get_lines(0, 0, -1, false), '${f.logFile}')
vim.cmd('SeqcallStop')
vim.wait(500)
vim.cmd('qa!')
`,
};

const editors: { editor: Editor; ok: boolean; fr: string }[] = [
  { editor: 'vim', ok: vimOk, fr: 'FR-21.2' },
  { editor: 'nvim', ok: nvimOk, fr: 'FR-21.5' },
];

for (const { editor, ok, fr } of editors) {
  describe.runIf(ok)(`${editor} plugin end to end (FR-21: the test plays the browser page)`, () => {
    it(`${fr} :SeqcallShow opens the diagram page; clicks jump in ${editor} (also after non-ASCII text); cursor and saves reach the diagram; :SeqcallClass / :SeqcallOpen open the pages`, async () => {
      // A copy of the sample app: the test saves a file. Non-ASCII before a call: the protocol counts
      // UTF-16 units ("😀" = 2), editor columns are bytes ("ä" = 2, "😀" = 4).
      const dir = `${tmp}/${editor}`;
      const f: Files = { app: `${dir}/app`, urlFile: `${dir}/url.txt`, navFile: `${dir}/nav.txt`, logFile: `${dir}/log.txt`, openedFile: `${dir}/opened.txt` };
      fs.cpSync(`${REPO}/fixtures/sample-app`, f.app, { recursive: true });
      const controller = `${f.app}/src/controllers/user-controller.ts`;
      const source = fs.readFileSync(controller, 'utf8');
      fs.writeFileSync(controller, source.replace('const user = await this.userService.findUser(id);', 'const user = /* ä😀 */ await this.userService.findUser(id);'));
      const { vim, exited } = spawnVim(dir, scripts[editor](f), process.env, editor);
      try {
        const url = (await waitForFile(f.urlFile)).trim();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sequence\?t=\w+$/);
        const seq = await events(url.replace('/sequence?', '/events/sequence?'));
        await intent(url, 'sequence', { type: 'ready' });
        const render = await seq.next((m) => m.type === 'render');
        expect(render.diagram.root.name).toBe('getUser');

        const findUser = render.diagram.messages.find((m: { methodName: string }) => m.methodName === 'findUser');
        await intent(url, 'sequence', { type: 'navigate', range: findUser.callSite });
        const [file, line, col] = (await waitForFile(f.navFile)).trim().split('\n');
        expect(file).toBe(controller);
        const { line: l, character: c } = findUser.callSite.start;
        expect(Number(line)).toBe(l + 1);
        const text = fs.readFileSync(controller, 'utf8').split('\n')[l];
        expect(text.slice(0, c)).toContain('ä😀'); // the click lands after the non-ASCII text
        expect(Number(col)).toBe(Buffer.byteLength(text.slice(0, c), 'utf8') + 1);

        const validate = render.diagram.messages.find((m: { methodName: string }) => m.methodName === 'validate');
        await seq.next((m) => m.type === 'highlight' && m.messageId === validate.id, 'highlight of validate');
        await seq.next((m) => m.type === 'highlight' && m.messageId === findUser.id, 'highlight of findUser'); // byte column → UTF-16 position
        await seq.next((m) => m.type === 'render' && m !== render, 'render after the save'); // FR-13.1 refresh on save

        expect(await exited).toBe(0);
        const opened = fs.readFileSync(f.openedFile, 'utf8').trim().split('\n');
        expect(opened).toEqual([url, url.replace('/sequence?', '/class?'), url]);
        expect(fs.readFileSync(f.logFile, 'utf8')).toMatch(/sidecar .* on Node v2\d/);
        seq.close();
      } finally {
        vim.kill();
      }
    }, 60_000);
  });
}

/** no file, no diagram: :SeqcallEntryPoints starts the sidecar, opens the page, which then lists where flows start. */
const entryScripts: Record<Editor, (app: string, urlFile: string, done: string) => string> = {
  vim: (app, urlFile, done) => `${prelude()}
cd ${app}
SeqcallEntryPoints
WaitFor(() => !empty(g:opened))
writefile(g:opened, '${urlFile}')
WaitFor(() => filereadable('${done}'), 600)
SeqcallStop
sleep 500m
qa!
`,
  nvim: (app, urlFile, done) => `${nvimPrelude()}
vim.cmd('cd ${app}')
vim.cmd('SeqcallEntryPoints')
wait_for(function() return #opened > 0 end)
vim.fn.writefile(opened, '${urlFile}')
wait_for(function() return vim.fn.filereadable('${done}') == 1 end, 60000)
vim.cmd('SeqcallStop')
vim.wait(500)
vim.cmd('qa!')
`,
};

for (const { editor, ok } of editors) {
  describe.runIf(ok)(`${editor} entry points without a diagram`, () => {
    it(`:SeqcallEntryPoints in ${editor} with no file open: the sidecar starts, the page opens and lists the entry points`, async () => {
      const dir = `${tmp}/${editor}-entry`;
      fs.mkdirSync(dir, { recursive: true });
      const urlFile = `${dir}/url.txt`;
      const done = `${dir}/done`;
      const { vim, exited } = spawnVim(dir, entryScripts[editor](`${REPO}/fixtures/sample-app`, urlFile, done), process.env, editor);
      try {
        const url = (await waitForFile(urlFile)).trim();
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/sequence\?t=\w+$/);
        const seq = await events(url.replace('/sequence?', '/events/sequence?'));
        await intent(url, 'sequence', { type: 'ready' });
        await seq.next((m) => m.type === 'empty', 'the empty page');
        const list = await seq.next((m) => m.type === 'entryPoints', 'the entry points');
        expect(list.show).toBe(true);
        expect(list.entryPoints.length).toBeGreaterThan(0);
        seq.close();
        fs.writeFileSync(done, '');
        expect(await exited).toBe(0);
      } finally {
        vim.kill();
      }
    }, 60_000);
  });
}
