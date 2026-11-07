import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO, nvimOk, nvimPrelude, prelude, runVim, vimOk, type Editor } from './helpers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-vim-info-'));
// KEEP=1 keeps the scripts and their .err files (editor errors) for debugging.
afterAll(() => { if (!process.env.KEEP) fs.rmSync(tmp, { recursive: true, force: true }); });

const APP = `${REPO}/fixtures/sample-app`;
const REPORT = `${APP}/src/console/report.ts`;

interface Result {
  popup: string[];
  opened: number;
  messages: string;
}

/**
 * :SeqcallInfo on a method name the cli entry point reaches → the popup; :SeqcallReach 1 opens its flow (the page
 * opens); :SeqcallReach 9 says there is no such entry point; :SeqcallMemory and :SeqcallFreeMemory answer.
 * Neovim also picks *Show all in Paths to here* from :SeqcallReach's list (vim.ui.select answered by the script).
 */
const scripts: Record<Editor, (out: string) => string> = {
  vim: (out) => `${prelude()}
cd ${APP}
edit ${REPORT}
search('function report')
normal! w
SeqcallInfo
WaitFor(() => exists('g:seqcall_last_popup'))
SeqcallReach 1
WaitFor(() => !empty(g:opened))
SeqcallReach 9
SeqcallMemory
WaitFor(() => execute('messages') =~ 'Seqcall uses')
SeqcallFreeMemory
WaitFor(() => execute('messages') =~ 'dropped its caches')
writefile([json_encode({popup: g:seqcall_last_popup, opened: len(g:opened), messages: execute('messages')})], '${out}')
SeqcallStop
sleep 500m
qa!
`,
  nvim: (out) => `${nvimPrelude()}
vim.cmd('cd ${APP}')
vim.cmd('edit ${REPORT}')
vim.fn.search('function report')
vim.cmd('normal! w')
vim.cmd('SeqcallInfo')
wait_for(function() return require('seqcall').last_popup ~= nil end)
vim.cmd('SeqcallReach 1')
wait_for(function() return #opened > 0 end)
vim.cmd('SeqcallReach 9')
-- the list without a number: the last row is Paths to here
local asked
vim.ui.select = function(items, opts, choose) asked = items; choose(items[#items], #items) end
vim.cmd('SeqcallReach')
vim.cmd('SeqcallMemory')
wait_for(function() return messages():find('Seqcall uses') ~= nil end)
vim.cmd('SeqcallFreeMemory')
wait_for(function() return messages():find('dropped its caches') ~= nil end)
report('${out}', { popup = require('seqcall').last_popup, opened = #opened, messages = messages() .. '\\nasked: ' .. table.concat(asked or {}, ' | ') })
vim.cmd('SeqcallStop')
vim.wait(500)
vim.cmd('qa!')
`,
};

const editors: { editor: Editor; ok: boolean }[] = [
  { editor: 'vim', ok: vimOk },
  { editor: 'nvim', ok: nvimOk },
];

for (const { editor, ok } of editors) {
  describe.runIf(ok)(`${editor}: Info at Caret and memory (FR-33.6, FR-34.4)`, () => {
    it(`FR-33.6 / FR-33.7 / FR-34.4 :SeqcallInfo shows the numbered entry points; :SeqcallReach opens one; :SeqcallMemory / :SeqcallFreeMemory answer (${editor})`, async () => {
      const dir = `${tmp}/${editor}`;
      fs.mkdirSync(dir, { recursive: true });
      const out = `${dir}/out.json`;
      const r = await runVim<Result>(dir, scripts[editor](out), out, process.env, editor);
      expect(r.popup[0]).toBe('⌂ reached from 1 entry point');
      expect(r.popup[1]).toMatch(/^ {3}1\. \S/);
      expect(r.popup.at(-1)).toBe(':SeqcallReach [n] opens a flow down to here · :SeqcallShow the diagram');
      expect(r.opened).toBeGreaterThan(0);
      expect(r.messages).toContain('no entry point 9 (1 to 1)');
      expect(r.messages).toMatch(/Seqcall: Seqcall uses \d+ MB\./);
      expect(r.messages).toContain('Seqcall: Seqcall dropped its caches.');
      if (editor === 'nvim') expect(r.messages).toMatch(/asked: .+ \| Show all in Paths to here/);
    }, 90_000);
  });
}
