import { execFileSync, spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { events, intent } from '../../stdio-host/test/sse';
import { PLUGIN, REPO, nvimOk, nvimPrelude, prelude, runVim, spawnVim, vimOk, waitForFile, type Editor } from './helpers';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-vim-pkg-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const pkg = `${tmp}/pkg/seqcall-vim`;
const { version } = JSON.parse(fs.readFileSync(`${PLUGIN}/package.json`, 'utf8'));

// What build.mjs bundles for C#: the published sidecar, else the Release build.
const csharpSource = [`${REPO}/packages/vscode/dist/csharp`, `${REPO}/packages/csharp/src/Seqcall.CSharp/bin/Release/net10.0`].find((d) =>
  fs.existsSync(`${d}/Seqcall.CSharp.dll`),
);
const localDotnet = `${os.homedir()}/.dotnet/dotnet`;
const dotnetOk = fs.existsSync(localDotnet) || spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;

interface Session {
  project: string;
  file: string;
  needle: string;
  urlFile: string;
  logFile: string;
  doneFile: string;
}

/** Open the file at `needle` from the installed package, report the URL, wait until the test is done, write the log. */
const sessionScripts: Record<Editor, (s: Session) => string> = {
  vim: (s) => `${prelude(pkg)}
cd ${s.project}
edit ${s.file}
search('${s.needle}')
SeqcallShow
WaitFor(() => !empty(g:opened))
writefile(g:opened, '${s.urlFile}')
WaitFor(() => filereadable('${s.doneFile}'), 600)
SeqcallLog
writefile(getline(1, '$'), '${s.logFile}')
SeqcallStop
sleep 500m
qa!
`,
  nvim: (s) => `${nvimPrelude(pkg)}
vim.cmd('cd ${s.project}')
vim.cmd('edit ${s.file}')
vim.fn.search('${s.needle}')
vim.cmd('SeqcallShow')
wait_for(function() return #opened > 0 end)
vim.fn.writefile(opened, '${s.urlFile}')
wait_for(function() return vim.fn.filereadable('${s.doneFile}') == 1 end, 60000)
vim.cmd('SeqcallLog')
vim.fn.writefile(vim.api.nvim_buf_get_lines(0, 0, -1, false), '${s.logFile}')
vim.cmd('SeqcallStop')
vim.wait(500)
vim.cmd('qa!')
`,
};

/** Play the page for a session; return its first model (render, error or empty) and the plugin's log. */
async function renderFromPackage(editor: Editor, fixture: string, file: string, needle: string, env?: NodeJS.ProcessEnv) {
  const dir = `${tmp}/${editor}-${path.basename(fixture)}`;
  const s: Session = { project: `${dir}/project`, file, needle, urlFile: `${dir}/url.txt`, logFile: `${dir}/log.txt`, doneFile: `${dir}/done.txt` };
  fs.cpSync(fixture, s.project, { recursive: true });
  const { vim, exited } = spawnVim(dir, sessionScripts[editor](s), env, editor);
  try {
    const url = (await waitForFile(s.urlFile, 60_000)).trim();
    const seq = await events(url.replace('/sequence?', '/events/sequence?'));
    await intent(url, 'sequence', { type: 'ready' });
    // A failed open leaves no diagram: the page then gets `empty` (the reason is in the log).
    const first = await seq.next((m) => m.type === 'render' || m.type === 'error' || m.type === 'empty');
    seq.close();
    fs.writeFileSync(s.doneFile, 'done');
    expect(await exited).toBe(0);
    return { first, log: fs.readFileSync(s.logFile, 'utf8') };
  } finally {
    vim.kill();
  }
}


/**
 * A fake GitHub (FR-30.6): the latest release v99.0.0 with `archive` as its Vim package; the asset answers 302 to a
 * "storage" url, as GitHub's does.
 */
async function fakeGitHub(archive: string): Promise<{ base: string; requests: string[]; close: () => void }> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.url} ${req.headers.authorization ? 'auth' : 'no-auth'}`);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (req.url === '/repos/seqcall/seqcall/releases/latest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: '', assets: [{ name: 'seqcall-vim-99.0.0.tar.gz', url: `${base}/assets/1` }] }));
    } else if (req.url === '/assets/1') {
      res.writeHead(302, { location: `${base}/storage/vim.tar.gz` }).end();
    } else if (req.url === '/storage/vim.tar.gz' && !req.headers.authorization) {
      res.end(fs.readFileSync(archive));
    } else res.writeHead(400).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, close: () => server.close() };
}

/** :SeqcallUpdate in the editor, on the installed copy `dir`; reports the messages when the folder was replaced. */
const updateScripts: Record<Editor, (dir: string, out: string) => string> = {
  vim: (dir, out) => `${prelude(dir)}
SeqcallUpdate
WaitFor(() => filereadable('${dir}/UPDATED') && execute('messages') =~ 'Restart the editor')
writefile([json_encode({messages: execute('messages')})], '${out}')
qa!
`,
  nvim: (dir, out) => `${nvimPrelude(dir)}
vim.cmd('SeqcallUpdate')
wait_for(function() return vim.fn.filereadable('${dir}/UPDATED') == 1 and messages():find('Restart the editor') ~= nil end)
report('${out}', { messages = messages() })
vim.cmd('qa!')
`,
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe.runIf(vimOk || nvimOk)('Vim / Neovim plugin package (FR-21.4)', () => {
  beforeAll(() => {
    // The bundles exist (global setup); package them into a temp directory, with the tarball next to it.
    execFileSync(process.execPath, [`${PLUGIN}/build.mjs`, '--out', pkg, '--no-build'], { stdio: 'ignore', cwd: REPO });
  });

  it('FR-21.4 contains both plugins, help, the sidecar with its TypeScript libs and webview, and the C# sidecar when built; the tarball has it all', () => {
    for (const f of [
      'plugin/seqcall.vim',
      'plugin/seqcall.lua',
      'vim9/commands.vim',
      'autoload/seqcall.vim',
      'lua/seqcall/init.lua',
      'lua/seqcall/health.lua',
      'doc/seqcall.txt',
      'node/stdio-host.cjs',
      'node/lib.es5.d.ts',
      'node/webview/sequence.js',
      'node/webview/class.js',
      'node/webview/styles.css',
    ])
      expect(fs.existsSync(`${pkg}/${f}`), f).toBe(true);
    if (vimOk) expect(fs.readFileSync(`${pkg}/doc/tags`, 'utf8')).toContain(':SeqcallShow');
    expect(fs.existsSync(`${pkg}/csharp/Seqcall.CSharp.dll`)).toBe(!!csharpSource);
    const listing = execFileSync('tar', ['-tzf', `${tmp}/pkg/seqcall-vim-${version}.tar.gz`], { encoding: 'utf8' });
    for (const f of ['seqcall-vim/plugin/seqcall.vim', 'seqcall-vim/lua/seqcall/init.lua', 'seqcall-vim/node/stdio-host.cjs', 'seqcall-vim/node/webview/class.js'])
      expect(listing).toContain(f);
  });

  for (const { editor, ok } of [
    { editor: 'vim' as const, ok: vimOk },
    { editor: 'nvim' as const, ok: nvimOk },
  ]) {
    it.runIf(ok)(`FR-21.4 the installed package runs in ${editor} on its own sidecar and webview (TypeScript)`, async () => {
      const { first, log } = await renderFromPackage(editor, `${REPO}/fixtures/sample-app`, 'src/controllers/user-controller.ts', 'this.validate(id);');
      expect(first.type).toBe('render');
      expect(first.diagram.root.name).toBe('getUser');
      expect(log).toMatch(new RegExp(`started \\S+ ${escape(pkg)}/node/stdio-host\\.cjs --browser`));
      // The bundled C# sidecar is passed by both plugins (one real C# run below is enough: the rest is the sidecar's).
      if (csharpSource) expect(log).toContain(`--csharp-sidecar ${pkg}/csharp/Seqcall.CSharp.dll`);
    });

    it.runIf(ok)(`FR-30.6 :SeqcallUpdate in ${editor} replaces the installed package by the latest release`, async () => {
      // the installed copy, and a "newer" archive: the same package with a marker file
      const dir = `${tmp}/${editor}-update/start/seqcall-vim`;
      fs.cpSync(pkg, dir, { recursive: true });
      const next = `${tmp}/${editor}-update/next`;
      fs.cpSync(pkg, `${next}/seqcall-vim`, { recursive: true });
      fs.writeFileSync(`${next}/seqcall-vim/UPDATED`, '99.0.0');
      execFileSync('tar', ['-czf', `${next}/vim.tar.gz`, 'seqcall-vim'], { cwd: next });
      const gh = await fakeGitHub(`${next}/vim.tar.gz`);
      try {
        const env = { ...process.env, SEQCALL_UPDATE_API: gh.base };
        const { messages } = await runVim<{ messages: string }>(`${tmp}/${editor}-update`, updateScripts[editor](dir, `${tmp}/${editor}-update/out.json`), `${tmp}/${editor}-update/out.json`, env, editor);
        expect(messages).toContain(`Seqcall 99.0.0 is installed (was ${version}).`);
        expect(messages).toContain('Restart the editor to use it.');
        expect(fs.readdirSync(`${tmp}/${editor}-update/start`)).toEqual(['seqcall-vim']); // no work folder left
        expect(gh.requests).toEqual(['/repos/seqcall/seqcall/releases/latest no-auth', '/assets/1 no-auth', '/storage/vim.tar.gz no-auth']);
      } finally {
        gh.close();
      }
    });

    // One real Roslyn load (seconds, many cores) instead of one per editor; the dotnet lookup of each plugin is tested in vim-host.test.ts.
    it.runIf(ok && editor === 'vim' && !!csharpSource && dotnetOk)(
      `FR-21.4 C# from the package in ${editor}: its own C# sidecar, and ~/.dotnet found when dotnet is not on the PATH`,
      async () => {
        // A desktop-started editor often has no ~/.dotnet on its PATH: the plugin must find it itself.
        const env = fs.existsSync(localDotnet)
          ? { ...process.env, PATH: (process.env.PATH ?? '').split(':').filter((p) => !p.includes('.dotnet')).join(':') }
          : process.env;
        const { first, log } = await renderFromPackage(editor, `${REPO}/fixtures/sample-cs`, 'src/Sample.Web/Controllers/UsersController.cs', 'GetUserDtoAsync', env);
        expect(first.type, log.split('\n').filter((l) => / error /.test(l)).join('\n')).toBe('render');
        expect(first.diagram.root.name).toBe('Get');
        expect(first.diagram.messages.map((m: { methodName: string }) => m.methodName)).toContain('GetUserDtoAsync');
        expect(log).toContain(`--csharp-sidecar ${pkg}/csharp/Seqcall.CSharp.dll`);
      },
      90_000,
    );
  }
});
