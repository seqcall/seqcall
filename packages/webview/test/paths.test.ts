// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { CallPathNode, EntryPoint, HostToSequenceView, MethodRef, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { pathsMarkdown, pathsSummary } from '../src/sequence/paths-panel';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';

let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;
const menuItem = (id: string) => view.root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
const msgEl = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
const panel = () => view.root.querySelector('.paths-panel') as HTMLElement | null;
const rows = () => [...panel()!.querySelectorAll('.paths-item')].map((r) => r.textContent);

const m = (cls: string, name: string, file = `src/${cls.toLowerCase()}.ts`): MethodRef =>
  ({ key: `${file}#${cls}.${name}`, name, owner: { key: `${file}#${cls}`, name: cls, kind: 'class' }, isStatic: false, hasBody: true }) as MethodRef;
const at = (file: string, line: number) => ({ range: { file, start: { line, character: 4 }, end: { line, character: 20 } }, preview: 'this.x()' });
const route: EntryPoint = { kind: 'http', verb: 'GET', label: 'GET /users/{id:long}', method: m('UserController', 'get') };
const test = (name: string): CallPathNode => ({ method: m('UserServiceTests', name, 'test/user.test.ts'), call: at('test/user.test.ts', 9), inTest: true, end: 'test' });
// repo ← service ← { controller (route), job (nothing calls it), 2 tests }
const tree: CallPathNode = {
  method: m('SqlRepo', 'find'),
  callers: [
    {
      method: m('UserService', 'load'),
      call: { ...at('src/userservice.ts', 11), count: 2 },
      callers: [
        { method: route.method, call: at('src/usercontroller.ts', 20), entryPoints: [route], end: 'entry' },
        { method: m('Nightly', 'run'), call: at('src/nightly.ts', 5), end: 'top' },
        test('loads'),
        test('fails'),
      ],
    },
  ],
};

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: cloneSequence() });
  bridge.posted.length = 0;
});

describe('FR-22 paths to here panel', () => {
  it('asked from a class method row (openPanel): the same requests and panels as from the message menu; an unknown call opens nothing', () => {
    const id = cloneSequence().messages.find((x) => x.kind === 'call')!.id;
    bridge.send({ type: 'openPanel', panel: 'paths', messageId: id });
    expect(bridge.last()).toEqual({ type: 'requestPaths', messageId: id });
    expect(panel()).not.toBeNull();
    bridge.send({ type: 'openPanel', panel: 'callers', messageId: id });
    expect(bridge.last()).toEqual({ type: 'requestCallers', messageId: id });
    expect(view.root.querySelector('.callers-panel')).not.toBeNull();
    bridge.posted.length = 0;
    bridge.send({ type: 'openPanel', panel: 'callers', messageId: 'root/99:gone' });
    expect(bridge.posted).toEqual([]);
  });

  it('FR-22.2 "Paths to here…" asks the host, shows progress with Cancel, then the reverse tree', () => {
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('paths-to-here')!, 'click');
    expect(bridge.last()).toEqual({ type: 'requestPaths', messageId: 'root' });
    bridge.send({ type: 'paths', messageId: 'root', state: 'running', methods: 7 });
    expect(panel()!.textContent).toContain('Walking the callers up to the entry points… 7 methods');
    fire([...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!, 'click');
    expect(bridge.last()).toEqual({ type: 'cancelPaths' });
    bridge.send({ type: 'paths', messageId: 'root', state: 'done', methods: 3, tree });
    expect(panel()!.querySelector('.paths-summary')!.textContent).toBe('Reached from 1 route · 1 top-level caller (no entry point) · 2 tests');
    // the path to the route is open; tests directly calling a method are one closed row
    expect(rows()).toEqual(['▾SqlRepo.find', '▾UserService.load×2userservice.ts:12', 'GET/users/{id}UserController.getusercontroller.ts:21', 'Nightly.runno callersnightly.ts:6', '▸2 tests']);
    fire(panel()!.querySelector('.paths-tests')!, 'click');
    expect(rows().slice(-2)).toEqual(['UserServiceTests.loadstestuser.test.ts:10', 'UserServiceTests.failstestuser.test.ts:10']);
  });

  it('FR-22.3 choosing a row opens that path top-down, with the entry point', () => {
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('paths-to-here')!, 'click');
    bridge.send({ type: 'paths', messageId: 'root', state: 'done', methods: 3, tree });
    const row = [...panel()!.querySelectorAll('.paths-item')].find((r) => r.textContent!.includes('UserController.get'))!;
    fire(row, 'click');
    expect(bridge.last()).toEqual({
      type: 'openPath',
      entryPoint: route,
      steps: [
        { methodKey: route.method.key, call: { range: at('src/usercontroller.ts', 20).range } },
        { methodKey: 'src/userservice.ts#UserService.load', call: { range: at('src/userservice.ts', 11).range } },
        { methodKey: 'src/sqlrepo.ts#SqlRepo.find' },
      ],
    });
    expect(panel()).toBeNull();
  });

  it('FR-22.2 a row toggle opens and closes its callers without opening the path', () => {
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('paths-to-here')!, 'click');
    bridge.send({ type: 'paths', messageId: 'root', state: 'done', methods: 3, tree });
    const n = bridge.posted.length;
    fire(panel()!.querySelectorAll('.paths-item')[1].querySelector('.paths-toggle')!, 'click');
    expect(rows()).toEqual(['▾SqlRepo.find', '▸UserService.load×2userservice.ts:12']);
    expect(bridge.posted.length).toBe(n);
  });

  it('FR-22.2 the callers panel leads to the paths; nothing calling the method is said plainly', () => {
    fire(msgEl('root').querySelector('.msg-hit')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(menuItem('show-callers')!, 'click');
    bridge.send({ type: 'callers', messageId: 'root', callers: [] });
    expect(view.root.querySelector('.callers-paths')).toBeNull(); // no callers: nothing to walk
    bridge.send({ type: 'callers', messageId: 'root', callers: [{ id: 'c1', enclosing: route.method, ...at('src/usercontroller.ts', 20) }] });
    fire(view.root.querySelector('.callers-paths')!, 'click');
    expect(bridge.last()).toEqual({ type: 'requestPaths', messageId: 'root' });
    expect(panel()).not.toBeNull();
    expect(pathsSummary({ method: m('A', 'b'), end: 'top' })).toBe('Nothing in the project calls it');
  });

  it('FR-22.4 Copy as Markdown lists each path from its start, tests grouped by class', () => {
    const md = pathsMarkdown({ messageId: 'root', title: 'SqlRepo.find', state: 'done', tree });
    expect(md).toBe(
      [
        '**Paths to `SqlRepo.find`** — Reached from 1 route · 1 top-level caller (no entry point) · 2 tests',
        '',
        '- `GET /users/{id}` UserController.get → UserService.load → SqlRepo.find',
        '- Nightly.run → UserService.load → SqlRepo.find _(nothing calls it)_',
        '- 2 tests in `UserServiceTests` → UserService.load → SqlRepo.find',
      ].join('\n'),
    );
  });
});
