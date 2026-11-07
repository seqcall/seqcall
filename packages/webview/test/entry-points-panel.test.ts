// @vitest-environment jsdom
import type { EntryPoint, EntryPointListNode } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { entryPointsPanel, entryKey, sortForDisplay, type EntryPointsState } from '../src/sequence/entry-points';

const ep = (kind: EntryPoint['kind'], label: string, name: string, extra: Partial<EntryPoint> = {}): EntryPoint => ({
  kind, label, method: { key: `src/A.ts#A.${name}`, name, owner: { key: 'src/A.ts#A', name: 'A', kind: 'class' }, isStatic: false, hasBody: true }, ...extra,
} as EntryPoint);

function setup(entryPoints: EntryPoint[], extra: Partial<EntryPointsState> = {}, withMap = true) {
  const state: EntryPointsState = { entryPoints, filter: '', open: {}, ...extra };
  const opened: string[] = [];
  const maps: (string[] | undefined)[] = [];
  const actions = { open: (e: EntryPoint) => opened.push(e.label), changed: () => {}, ...(withMap ? { appMap: (k?: string[]) => maps.push(k) } : {}) };
  const panel = entryPointsPanel(state, actions);
  document.body.replaceChildren(panel);
  const rows = () => [...panel.querySelectorAll('.ep-list > *')].map((r) => r.textContent!.trim());
  const click = (sel: string) => (panel.querySelector(sel) as HTMLElement).click();
  return { panel, state, rows, click, opened, maps };
}

describe('FR-16.2 the entry-point list, unusual cases', () => {
  it('FR-16.1 endpoints of one path: no verb first, then GET … DELETE, then verbs the order does not know', () => {
    const list = [ep('http', 'OPTIONS /a', 'o', { verb: 'OPTIONS' }), ep('http', 'GET /a', 'g', { verb: 'GET' }), ep('route', '/a', 'r')];
    expect(sortForDisplay(list).map((e) => e.label)).toEqual(['/a', 'GET /a', 'OPTIONS /a']);
  });

  it('FR-16.11 a host that can switch projects but sent no project name says "project"; without the extra lists only the filter shows', () => {
    const state: EntryPointsState = { entryPoints: [ep('job', 'Sync.run', 'run')], filter: '', open: {}, canSwitchProject: true };
    const panel = entryPointsPanel(state, { open: () => {}, changed: () => {}, switchProject: () => {} });
    expect(panel.querySelector('.ep-switch-project')!.textContent).toBe(' · project ▾');
    expect(panel.querySelectorAll('.ep-issues-btn')).toHaveLength(0);
    expect(panel.querySelector('.ep-search-row')).toBeNull();
    expect(panel.children[1].getAttribute('class')).toBe('ep-search');
  });

  it('FR-16.2 a group head folds and unfolds its group', () => {
    const s = setup([ep('job', 'Sync.run', 'run')], {}, false);
    expect(s.rows()).toEqual(['▾ Background jobs 1', 'Sync.runA.run']);
    s.click('[data-group="job"]');
    expect(s.rows()).toEqual(['▸ Background jobs 1']);
    expect(s.state.open.job).toBe(false);
  });

  it('FR-16.2 more than 150 rows: the rest is counted; a filter that matches nothing says so', () => {
    const many = Array.from({ length: 152 }, (_, i) => ep('job', `Job${String(i).padStart(3, '0')}.run`, `run${i}`));
    const s = setup(many, {}, false);
    expect(s.rows().at(-1)).toBe('+2 more — refine the filter');
    const none = setup(many, { filter: 'zzz' }, false);
    expect(none.rows()).toEqual(['No match']);
  });

  it('FR-26.8 ticking: a file of module-level calls has one box for all; unticking a ticked row removes it', () => {
    const file = 'src/boot.ts';
    const calls = [ep('cli', `${file}: start()`, 'start', { file }), ep('cli', `${file}: listen()`, 'listen', { file })];
    const s = setup(calls, { selecting: true });
    const fileBox = s.panel.querySelector('[data-file] .ep-check') as HTMLInputElement;
    fileBox.click();
    expect([...s.state.selected!].sort()).toEqual(calls.map(entryKey).sort());
    expect(s.panel.querySelector('.ep-appmap-btn')!.textContent).toBe('⛶ Map of selected (2)');
    (s.panel.querySelector('[data-file] .ep-check') as HTMLInputElement).click(); // all ticked: unticks all
    expect(s.state.selected!.size).toBe(0);
    expect(s.panel.querySelector('.ep-appmap-btn')!.textContent).toBe('⛶ Codebase map');
  });
});

describe('FR-16.4 the host\'s tree: the same projects, groups and folders as the VS Code sidebar', () => {
  const e = (i: number): EntryPointListNode => ({ type: 'entry', index: i });
  const list = [
    ep('http', 'GET /api/orders/{id:long}', 'get', { verb: 'GET' }),
    ep('http', 'DELETE /api/orders/{id:long}', 'del', { verb: 'DELETE' }),
    ep('http', 'GET /api/health', 'health', { verb: 'GET' }),
    ep('test', 'OrderTest.it', 'it'),
    ep('cli', 'src/boot.ts: start()', 'start', { file: 'src/boot.ts' }),
    ep('cli', 'src/boot.ts: listen()', 'listen', { file: 'src/boot.ts' }),
  ];
  const tree: EntryPointListNode[] = [
    { type: 'project', name: 'Shop.Web', children: [
      { type: 'group', kind: 'http', children: [{ type: 'folder', label: '/orders/{id:long}', path: '/api/orders/{id:long}', children: [e(0), e(1)] }, e(2)] },
      { type: 'group', kind: 'cli', children: [{ type: 'file', file: 'src/boot.ts', children: [e(4), e(5)] }] },
    ] },
    { type: 'project', name: 'Tests', tests: true, children: [{ type: 'project', name: 'Shop.UnitTests', children: [{ type: 'group', kind: 'test', children: [e(3)] }] }] },
  ];

  it('FR-16.8 projects closed at first; a project opens to its groups, a folder (route shortened) to its entries, each one level deeper', () => {
    const s = setup(list, { tree }, false);
    expect(s.rows()).toEqual(['▸ Shop.Web5', '▸ Tests1']);
    s.click('[data-project="Shop.Web"]');
    expect(s.rows()).toEqual(['▾ Shop.Web5', '▾ HTTP endpoints 3', '▸ /orders/{id}2', 'GET/api/healthA.health', '▾ Programs & scripts 2', '▸ src/boot.ts2 calls', '▸ Tests1']);
    expect(s.state.open['project:Shop.Web']).toBe(true);
    expect((s.panel.querySelector('[data-group="http"]') as HTMLElement).style.paddingLeft).toBe('34px');
    s.click('[data-folder="/api/orders/{id:long}"]');
    expect(s.state.open['folder:http:/api/orders/{id:long}']).toBe(true);
    const rows = [...s.panel.querySelectorAll<HTMLElement>('.ep-item.kind-http')];
    expect(rows.map((r) => [r.textContent, r.style.paddingLeft])).toEqual([['GET/api/orders/{id}A.get', '34px'], ['DELETE/api/orders/{id}A.del', '34px'], ['GET/api/healthA.health', '22px']]);
    // a group inside a project folds by its own key
    s.click('[data-group="http"]');
    expect(s.state.open['Shop.Web/http']).toBe(false);
    // the test projects held together: their projects below, then the group
    s.click('[data-project="Tests"]');
    s.click('[data-project="Shop.UnitTests"]');
    expect(s.rows().slice(-3)).toEqual(['▾ Tests1', '▾ Shop.UnitTests1', '▸ Tests 1']);
  });

  it('FR-16.9 a filter opens the projects and folders holding matches and hides the rest; ticking a folder ticks its entries', () => {
    const s = setup(list, { tree, filter: 'orders' }, false);
    expect(s.rows()).toEqual(['▾ Shop.Web2/5', '▾ HTTP endpoints 2/3', '▾ /orders/{id}2/2', 'GET/api/orders/{id}A.get', 'DELETE/api/orders/{id}A.del']);
    // a file of module-level calls shows only the calls that match
    expect(setup(list, { tree, filter: 'start' }, false).rows()).toEqual(['▾ Shop.Web1/5', '▾ Programs & scripts 1/2', '▾ src/boot.ts2 calls', 'start()A.start']);
    const t = setup(list, { tree, selecting: true, open: { 'project:Shop.Web': true } });
    (t.panel.querySelector('[data-folder] .ep-check') as HTMLInputElement).click();
    expect([...t.state.selected!].sort()).toEqual([list[0], list[1]].map(entryKey).sort());
    // a project of tests only has no box
    expect(t.panel.querySelector('[data-project="Tests"] .ep-check')).toBeNull();
    expect(t.panel.querySelector('[data-project="Shop.Web"] .ep-check')).not.toBeNull();
  });

  it('FR-16.2 the 150-row limit counts the rows of the group, also inside folders; closed folders past it are counted as more', () => {
    const many = Array.from({ length: 160 }, (_, i) => ep('job', `Job${String(i).padStart(3, '0')}.run`, `run${i}`));
    const folder = (from: number, to: number, name: string): EntryPointListNode => ({ type: 'folder', label: name, path: name, children: Array.from({ length: to - from }, (_, i) => e(from + i)) });
    const t: EntryPointListNode[] = [{ type: 'group', kind: 'job', children: [folder(0, 140, 'a'), folder(140, 155, 'b'), folder(155, 160, 'c')] }];
    const s = setup(many, { tree: t, open: { 'folder:job:a': true, 'folder:job:b': true } }, false);
    expect(s.rows().filter((r) => r.startsWith('Job'))).toHaveLength(150);
    expect(s.rows().at(-1)).toBe('+10 more — refine the filter');
  });
});
