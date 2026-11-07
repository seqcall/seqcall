import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Position } from '@seqcall/protocol';

/** Shared by the Vim plugin tests (FR-21): headless Vim (`vim -es`; `:sleep` runs channel and timer callbacks). */
export const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
export const PLUGIN = `${REPO}/packages/vim`;
export const BUNDLE = `${REPO}/packages/stdio-host/dist/stdio-host.cjs`;
export const WEBVIEW = `${REPO}/packages/webview/dist/sequence.js`;

// -n: no swap files. Tests open the repository fixture; a copy made meanwhile would get the swap file and open read-only.
const VIM_ARGS = ['-N', '-u', 'NONE', '-i', 'NONE', '-n', '--not-a-term', '-es'];
const NVIM_ARGS = ['--headless', '-u', 'NONE', '-i', 'NONE', '-n'];
export type Editor = 'vim' | 'nvim';

/** Vim ≥ 9.0.1485 (utf16idx, byteidx with UTF-16) on PATH. */
export const vimOk = (() => {
  const r = spawnSync('vim', [...VIM_ARGS, '-c', "if has('patch-9.0.1485') | qa! | else | cq | endif"], { timeout: 10_000 });
  return r.status === 0;
})();

/** Neovim ≥ 0.10 on PATH (FR-21.5). */
export const nvimOk = (() => {
  const r = spawnSync('nvim', [...NVIM_ARGS, '-c', "if has('nvim-0.10') | qa! | else | cq | endif"], { timeout: 10_000 });
  return r.status === 0;
})();

/**
 * Lua header for Neovim: the plugin at `rtp`, a browser that only records URLs (`opened`), messages
 * from vim.notify in `notes`, `wait_for(cond)` (vim.wait runs the job and timer callbacks), `messages()`.
 */
export const nvimPrelude = (rtp = PLUGIN) => `vim.opt.rtp:prepend('${rtp}')
vim.o.hidden = true
vim.cmd('runtime plugin/seqcall.lua')
opened, notes = {}, {}
vim.notify = function(msg) table.insert(notes, msg) end
require('seqcall').setup({ browser = function(url) table.insert(opened, url) end })
function wait_for(cond, ms) vim.wait(ms or 30000, cond, 50) end
function messages() return table.concat(notes, '\\n') .. '\\n' .. vim.api.nvim_exec2('messages', { output = true }).output end
function report(file, value) vim.fn.writefile({ vim.json.encode(value) }, file) end
`;

/** `vim9script` header for Vim: the plugin at `rtp` (repository or a built package), a browser that only records URLs. */
export const prelude = (rtp = PLUGIN) => `vim9script
set rtp^=${rtp}
set hidden
runtime plugin/seqcall.vim
g:opened = []
g:Seqcall_browser = (url) => add(g:opened, url)
def WaitFor(Cond: func(): bool, steps = 300)
  for i in range(steps)
    if Cond()
      return
    endif
    sleep 100m
  endfor
enddef
`;

/** Start headless Vim (Vim9 script) or Neovim (Lua script) on a script written into `dir`. */
export function spawnVim(dir: string, script: string, env: NodeJS.ProcessEnv = process.env, editor: Editor = 'vim'): { vim: ChildProcess; exited: Promise<number | null> } {
  const file = `${dir}/test-${Date.now()}-${Math.random().toString(36).slice(2)}.${editor === 'vim' ? 'vim' : 'lua'}`;
  fs.writeFileSync(file, script);
  // The editor's own errors (a broken script) land next to the script.
  const vim = spawn(editor, [...(editor === 'vim' ? VIM_ARGS : NVIM_ARGS), '-S', file], { stdio: ['ignore', 'ignore', fs.openSync(`${file}.err`, 'w')], env });
  return { vim, exited: new Promise((r) => vim.on('exit', r)) };
}

/** Run a script to the end; it reports by writing JSON to `out`. */
export async function runVim<T>(dir: string, script: string, out: string, env?: NodeJS.ProcessEnv, editor: Editor = 'vim'): Promise<T> {
  const { vim, exited } = spawnVim(dir, script, env, editor);
  const timer = setTimeout(() => vim.kill(), 60_000);
  const code = await exited;
  clearTimeout(timer);
  if (!fs.existsSync(out)) throw new Error(`vim exited with ${code} without writing ${out}`);
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

export async function waitForFile(file: string, ms = 30_000): Promise<string> {
  for (let t = 0; t < ms; t += 100) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${file}`);
}

export function positionOf(file: string, needle: string): Position {
  const text = fs.readFileSync(file, 'utf8');
  const before = text.slice(0, text.indexOf(needle)).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}
