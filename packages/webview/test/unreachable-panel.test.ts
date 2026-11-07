// @vitest-environment jsdom
import type { HostToSequenceView, MethodRef, SequenceViewToHost, UnreachableMethod, UnreachableScan } from '@seqcall/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unreachableMarkdown, unreachablePanel } from '../src/sequence/unreachable-panel';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge } from './helpers';

const noop = { open: () => {}, cancel: () => {}, rescan: () => {}, filter: () => {} };
const statuses = (p: HTMLElement) => [...p.querySelectorAll('.ep-status')].map((s) => s.textContent);
const method = (cls: string, name: string, line?: number, file = `/p/src/${cls}.php`): MethodRef => ({
  key: `src/${cls}.php#${cls}.${name}`,
  name,
  owner: { key: `src/${cls}.php#${cls}`, name: cls, kind: 'class' },
  isStatic: false,
  hasBody: true,
  ...(line === undefined ? {} : { declaration: { file, start: { line, character: 0 }, end: { line, character: 5 } } }),
});
const row = (m: MethodRef, extra: Partial<UnreachableMethod> = {}): UnreachableMethod => ({ method: m, reason: 'no-callers', callers: 0, ...extra });
const scan = (methods: UnreachableMethod[], extra: Partial<UnreachableScan> = {}): UnreachableScan => ({ methods, total: 40, reached: 30, entryPoints: 5, missed: 0, truncated: false, ...extra });

const close = row(method('Shop', 'close', 3));
const audit = row(method('Shop', 'audit', 9), { reason: 'unreached-callers', callers: 2 });
const trace = row(method('Shop', 'trace', 12), { reason: 'unreached-callers', callers: 1 });
const seed = row(method('Shop', 'seed', 20), { reason: 'tests-only', callers: 1 });
const total = row(method('Order', 'total', 4), { unresolved: 1 });
const sum = row(method('Order', 'sum', 8), { reason: 'unreached-callers', callers: 1, unresolved: 3, via: 'Order.total' });
const accessor = row(method('Order', 'getTotalAttribute', 14), { framework: 'extends Model' });
const quiet = row(method('Shop', 'quiet', 30), { reason: 'unreached-callers', callers: 0 });
const fn = row({ key: 'src/util.ts#<module>.slug', name: 'slug', owner: { key: 'src/util.ts#<module>', name: 'slug', kind: 'module' }, isStatic: false, hasBody: true });

describe('FR-31 the Unreachable code panel', () => {
  it('FR-31 running: walking (methods so far), then checking (n / total with a bar); Cancel', () => {
    const cancel = vi.fn();
    const walking = unreachablePanel({ state: 'running', phase: 'reach', done: 120 }, { ...noop, cancel });
    expect(statuses(walking)).toEqual(['Following the calls from the entry points… 120 methodsCancel']);
    expect(walking.querySelector('.di-bar')).toBeNull();
    (walking.querySelector('.di-progress button') as HTMLElement).click();
    expect(cancel).toHaveBeenCalled();
    expect(statuses(unreachablePanel({ state: 'running' }, noop))[0]).toBe('Following the calls from the entry points… 0 methodsCancel');
    const checking = unreachablePanel({ state: 'running', phase: 'check', done: 5, total: 20 }, noop);
    expect(statuses(checking)[0]).toBe('Checking what no entry point reaches… 5 / 20Cancel');
    expect((checking.querySelector('.di-bar-fill') as HTMLElement).style.width).toBe('25%');
    expect(statuses(unreachablePanel({ state: 'running', phase: 'check' }, noop))[0]).toBe('Checking what no entry point reaches… 0 / ?Cancel');
    const counted = unreachablePanel({ state: 'running', phase: 'check', total: 8 }, noop);
    expect((counted.querySelector('.di-bar-fill') as HTMLElement).style.width).toBe('0%');
  });

  it('FR-31 failed (with and without a reason), cancelled (Scan again), a library, nothing unreachable', () => {
    const rescan = vi.fn();
    expect(statuses(unreachablePanel({ state: 'error', error: 'sidecar gone' }, noop))).toEqual(['sidecar gone']);
    expect(statuses(unreachablePanel({ state: 'error' }, noop))).toEqual(['The scan failed.']);
    const cancelled = unreachablePanel({ state: 'cancelled' }, { ...noop, rescan });
    (cancelled.querySelector('button') as HTMLElement).click();
    expect(rescan).toHaveBeenCalled();
    expect(statuses(unreachablePanel({ state: 'done', result: scan([], { entryPoints: 0 }) }, noop))).toEqual(['No entry points (routes, commands, jobs, handlers) — e.g. a library: every method would be listed (40).']);
    expect(statuses(unreachablePanel({ state: 'done', result: scan([]) }, noop))).toEqual(['Every method of the project is reached from its 5 entry points.']);
  });

  it('FR-31 the result: dead-code candidates by reason, then maybe called and framework-called; a row opens its method; ↻ scans again', () => {
    const open = vi.fn();
    const rescan = vi.fn();
    const p = unreachablePanel({ state: 'done', project: 'shop', result: scan([close, audit, trace, seed, total, sum, accessor, fn], { missed: 2, ignored: 3, truncated: true }) }, { ...noop, open, rescan });
    expect(p.querySelector('.ep-title')!.textContent).toBe('∅ Unreachable code · shop↻');
    expect(statuses(p)).toEqual(['8 of 40 methods no entry point reaches (5 entry points, tests excluded) · 2 probably reached (not listed) · 3 ignored by the config', 'The walk hit its limit: some listed methods may be reached.']);
    expect([...p.querySelectorAll('.ep-group')].map((g) => g.textContent)).toEqual(['No callers 2', 'Called only from unreached code 2', 'Only tests call it 1', 'Maybe called 2', 'Probably called by the framework 1']);
    const items = [...p.querySelectorAll<HTMLElement>('.un-item')];
    expect(items.map((i) => `${i.querySelector('.di-title')!.textContent} | ${i.querySelector('.di-from')!.textContent}`)).toEqual([
      'Shop.close | Shop.php:4',
      'slug | ',
      'Shop.audit | Shop.php:10 · 2 callers',
      'Shop.trace | Shop.php:13 · 1 caller',
      'Shop.seed | Shop.php:21 · 1 caller',
      'Order.total | Order.php:5 · 1 unresolved call',
      'Order.sum | Order.php:9 · 3 unresolved calls · via Order.total',
      'Order.getTotalAttribute | Order.php:15 · extends Model',
    ]);
    expect(items[0].title).toBe('/p/src/Shop.php');
    expect(items[2].title).toBe('/p/src/Shop.php\n2 callers');
    items[2].click();
    expect(open).toHaveBeenCalledWith(audit);
    (p.querySelector('.di-rescan') as HTMLElement).click();
    expect(rescan).toHaveBeenCalled();
    // no copy action: no Copy button
    expect(p.querySelector('.paths-copy')).toBeNull();
  });

  it('FR-31 a list from a walk the code changed during says so (panel and Markdown)', () => {
    const s = { state: 'done' as const, result: scan([close], { changed: true }) };
    expect(statuses(unreachablePanel(s, noop))).toContain('The code changed while this ran: the list may mix old and new code. ↻ checks again.');
    // after the summary line, before the groups
    expect(unreachableMarkdown(s).split('\n')[2]).toBe('_The code changed while this ran: the list may mix old and new code. ↻ checks again._');
  });

  it('FR-31.1 a list kept across saves says the code changed since (panel and Markdown)', () => {
    const s = { state: 'done' as const, result: scan([close], { stale: true }) };
    const note = 'The code changed since this check: a method added, newly called or no longer called shows after ↻.';
    expect(statuses(unreachablePanel(s, noop))).toContain(note);
    expect(unreachableMarkdown(s)).toContain(`_${note}_`);
  });

  it('FR-31 the filter: words matching the method or its file; long groups are cut with a count', () => {
    const filter = vi.fn();
    const many = Array.from({ length: 205 }, (_, i) => row(method('Shop', `m${i}`, i)));
    const p = unreachablePanel({ state: 'done', result: scan([...many, total], { total: 300 }), filter: 'shop' }, { ...noop, filter });
    expect(p.querySelectorAll('.un-item')).toHaveLength(200);
    expect(statuses(p)).toContain('… 5 more (filter to narrow)');
    expect(statuses(p)[0]).toBe('205 of 300 methods no entry point reaches (5 entry points, tests excluded)');
    const box = p.querySelector('.ep-search') as HTMLInputElement;
    expect(box.value).toBe('shop');
    box.value = 'order tot';
    box.dispatchEvent(new Event('input'));
    expect(filter).toHaveBeenCalledWith('order tot');
    expect(unreachablePanel({ state: 'done', result: scan([close, total]), filter: 'order tot' }, noop).querySelectorAll('.un-item')).toHaveLength(1);
    // a caller count the scan did not give: no note
    expect(unreachablePanel({ state: 'done', result: scan([quiet]) }, noop).querySelector('.di-from')!.textContent).toBe('Shop.php:31');
  });

  it('FR-31 Copy as Markdown: the shown (filtered) list grouped as shown; Copied ✓ / Copy failed', async () => {
    const s = { state: 'done' as const, project: 'shop', result: scan([close, audit, fn, sum, accessor], { truncated: true }) };
    expect(unreachableMarkdown(s)).toBe(
      [
        '**Unreachable code · shop** — 5 of 40 methods no entry point reaches (5 entry points, tests excluded) (walk limit reached: some may be reached)',
        '',
        '### No callers (2)',
        '- `Shop.close` — /p/src/Shop.php:4',
        '- `slug`',
        '',
        '### Called only from unreached code (1)',
        '- `Shop.audit` — /p/src/Shop.php:10 (2 callers)',
        '',
        '### Maybe called (1)',
        '- `Order.sum` — /p/src/Order.php:9 (3 unresolved calls · via Order.total)',
        '',
        '### Probably called by the framework (1)',
        '- `Order.getTotalAttribute` — /p/src/Order.php:15 (extends Model)',
      ].join('\n'),
    );
    expect(unreachableMarkdown({ state: 'done', result: scan([close]), filter: 'nothing' })).toBe('**Unreachable code** — 0 of 40 methods no entry point reaches (5 entry points, tests excluded)');
    let ok = true;
    const copy = vi.fn(async () => ok);
    const p = unreachablePanel(s, { ...noop, copy });
    const button = p.querySelector('.paths-copy') as HTMLElement;
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe('Copied ✓'));
    expect(copy).toHaveBeenCalledWith(unreachableMarkdown(s));
    ok = false;
    button.click();
    await vi.waitFor(() => expect(button.textContent).toBe('Copy failed'));
  });
});

describe('FR-31 the sequence view and the Unreachable code panel', () => {
  afterEach(() => vi.restoreAllMocks());

  function setup() {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.posted.length = 0;
    const posted = () => bridge.posted.filter((m) => m.type !== 'log');
    return { bridge, view, posted };
  }

  it('FR-31 ∅ Unreachable in the entry-point list asks for the scan, shows its progress and result; a row navigates; the filter keeps typing; Copy as Markdown', async () => {
    const { bridge, view, posted } = setup();
    fire(view.root.querySelector('[data-cmd="entryPoints"]')!, 'click');
    bridge.send({ type: 'entryPoints', entryPoints: [], project: 'shop' });
    bridge.posted.length = 0;
    (view.root.querySelector('.ep-unreachable-btn') as HTMLElement).click();
    expect(posted()).toEqual([{ type: 'requestUnreachable' }]);
    expect(view.root.querySelector('.unreachable-panel .ep-project')!.textContent).toBe(' · shop');
    bridge.send({ type: 'unreachable', state: 'running', phase: 'check', done: 1, total: 4 });
    expect(view.root.querySelector('.unreachable-panel')!.textContent).toContain('1 / 4');
    (view.root.querySelector('.unreachable-panel .di-progress button') as HTMLElement).click();
    expect(posted().at(-1)).toEqual({ type: 'cancelUnreachable' });
    bridge.send({ type: 'unreachable', state: 'done', result: scan([close, total, fn]), project: 'shop' });
    const box = view.root.querySelector('.unreachable-panel .ep-search') as HTMLInputElement;
    box.value = 'shop';
    box.dispatchEvent(new Event('input'));
    const again = view.root.querySelector('.unreachable-panel .ep-search') as HTMLInputElement;
    expect(document.activeElement).toBe(again);
    expect(view.root.querySelectorAll('.un-item')).toHaveLength(1);
    // a later answer keeps the filter
    bridge.send({ type: 'unreachable', state: 'done', result: scan([close, total, fn]) });
    expect(view.root.querySelectorAll('.un-item')).toHaveLength(1);
    expect(view.root.querySelector('.unreachable-panel .ep-project')!.textContent).toBe(' · shop');
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    (view.root.querySelector('.unreachable-panel .paths-copy') as HTMLElement).click();
    await vi.waitFor(() => expect(writes[0]).toContain('**Unreachable code · shop**'));
    (view.root.querySelector('.un-item') as HTMLElement).click();
    expect(posted().at(-1)).toEqual({ type: 'navigate', range: close.method.declaration });
    expect(view.root.querySelector('.unreachable-panel')).toBeNull();
  });

  it('FR-31 a cached result shows at once (asked again, not scanned again); ↻ asks for a rescan; a method without a declaration does not navigate; closed: answers only update the state', () => {
    const { bridge, view, posted } = setup();
    bridge.send({ type: 'unreachable', state: 'done', result: scan([fn]) });
    expect(view.root.querySelector('.unreachable-panel')).toBeNull();
    view.showUnreachable();
    expect(posted()).toEqual([{ type: 'requestUnreachable' }]);
    expect(view.root.querySelectorAll('.un-item')).toHaveLength(1);
    (view.root.querySelector('.un-item') as HTMLElement).click();
    expect(posted()).toEqual([{ type: 'requestUnreachable' }]);
    view.showUnreachable();
    (view.root.querySelector('.unreachable-panel .di-rescan') as HTMLElement).click();
    expect(posted().at(-1)).toEqual({ type: 'requestUnreachable', rescan: true });
    expect(view.root.querySelector('.unreachable-panel')!.textContent).toContain('Following the calls');
    // shown by the host (a command)
    view.root.querySelector('.popup-layer')!.replaceChildren();
    bridge.send({ type: 'unreachable', state: 'running', phase: 'reach', done: 3, show: true });
    expect(view.root.querySelector('.unreachable-panel')).not.toBeNull();
  });
});
