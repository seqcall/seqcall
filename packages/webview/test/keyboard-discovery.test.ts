// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EntryPoint, Fragment, HostToSequenceView, SearchHit, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { KEYS } from '../src/sequence/legend';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, range } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// keys and things nobody found.

const P = 'root/1:placeOrder';

function opened(d: SequenceDiagram = cloneSequence()) {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: d });
  bridge.posted.length = 0;
  return { bridge, view, doc: view.root.ownerDocument };
}
const key = (target: EventTarget, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

describe('FR-14.8 keys for back / forward, and a list of every key', () => {
  it('Alt+← / Alt+→ go back / forward when there is somewhere to go; not while typing', () => {
    const { bridge, view, doc } = opened({ ...cloneSequence(), canGoBack: true, canGoForward: false });
    key(doc, { key: 'ArrowLeft', altKey: true });
    expect(bridge.last()).toEqual({ type: 'back' });
    bridge.posted.length = 0;
    // nothing ahead: nothing posted, and the browser does not go back / forward either (it would leave the page)
    expect(key(doc, { key: 'ArrowRight', altKey: true })).toBe(false);
    key(doc, { key: 'ArrowLeft', altKey: true, ctrlKey: true }); // another shortcut
    view.find.open();
    key(view.root.querySelector('.find-bar input')!, { key: 'ArrowLeft', altKey: true });
    expect(bridge.posted.filter((m) => m.type === 'back' || m.type === 'forward')).toEqual([]);
    view.find.bar.close();
    bridge.send({ type: 'render', diagram: { ...cloneSequence(), canGoBack: false, canGoForward: true } });
    bridge.posted.length = 0;
    key(doc, { key: 'ArrowRight', altKey: true });
    key(doc, { key: 'ArrowLeft', altKey: true }); // nothing behind
    expect(bridge.posted).toEqual([{ type: 'forward' }]);
  });

  it('"?" and View ▾ → Keyboard shortcuts… show every key; not over an open menu; Alt+? is not it', () => {
    const { view, doc } = opened();
    key(doc, { key: '?', altKey: true });
    expect(view.root.querySelector('.keys-card')).toBeNull();
    key(doc, { key: '?' });
    const card = view.root.querySelector('.popup-layer .keys-card')!;
    expect([...card.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(KEYS.map(([k]) => k));
    expect(card.textContent).toContain('Back / forward to the previous diagram');
    fire(card.querySelector('.gc-btn')!, 'click');
    expect(view.root.querySelector('.keys-card')).toBeNull();
    fire(view.toolbar.button('view'), 'click');
    key(doc, { key: '?' }); // the menu stays
    expect(view.root.querySelector('.keys-card')).toBeNull();
    const row = view.root.querySelector('.popup-layer [data-menu-id="view:keys"]') as HTMLElement;
    expect(row.querySelector('.menu-hint')!.textContent).toBe('?');
    row.click();
    expect(view.root.querySelector('.popup-layer .keys-card')).not.toBeNull();
  });
});

describe('FR-14.8 the ⌂ filter by keyboard', () => {
  const ep = (label: string, name: string): EntryPoint => ({ kind: 'http', label, method: { key: `src/c.ts#C.${name}`, name, owner: { key: 'src/c.ts#C', name: 'C', kind: 'class' }, isStatic: false, hasBody: true } });
  const EPS = [ep('GET /orders', 'list'), ep('GET /orders/:id', 'get'), ep('POST /payments', 'pay')];

  it('↓ from the filter to the rows, ↓ / ↑ between them, ↑ on the first back; Enter opens the only match', () => {
    const { bridge, view, doc } = opened();
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'shop', show: true });
    const search = view.root.querySelector('.ep-search') as HTMLInputElement;
    const rows = () => [...view.root.querySelectorAll<HTMLElement>('.ep-item')];
    search.focus();
    key(search, { key: 'ArrowDown' });
    expect(doc.activeElement).toBe(rows()[0]);
    key(doc.activeElement!, { key: 'ArrowDown' });
    expect(doc.activeElement).toBe(rows()[1]);
    key(doc.activeElement!, { key: 'ArrowUp' });
    key(doc.activeElement!, { key: 'ArrowUp' });
    expect(doc.activeElement).toBe(search);
    // the last row stays the last
    rows().at(-1)!.focus();
    key(doc.activeElement!, { key: 'ArrowDown' });
    expect(doc.activeElement).toBe(rows().at(-1));
    // no rows: ↓ stays in the field
    search.value = 'nothing like it';
    fire(search, 'input');
    search.focus();
    key(search, { key: 'ArrowDown' });
    expect(doc.activeElement).toBe(search);
    // several matches: Enter does nothing; one: it opens
    search.value = 'orders';
    fire(search, 'input');
    bridge.posted.length = 0;
    key(search, { key: 'Enter' });
    expect(bridge.posted.filter((m) => m.type === 'openMethod')).toEqual([]);
    search.value = 'payments';
    fire(search, 'input');
    key(search, { key: 'Enter' });
    expect(bridge.last()).toMatchObject({ type: 'openMethod', methodKey: 'src/c.ts#C.pay' });
  });

  it('other keys in the list are left alone (a row\'s Enter is its click)', () => {
    const { bridge, view } = opened();
    bridge.send({ type: 'entryPoints', entryPoints: EPS, project: 'shop', show: true });
    const list = view.root.querySelector('.ep-list') as HTMLElement;
    expect(key(list, { key: 'ArrowDown' })).toBe(true); // not from a row: not handled
    expect(key(view.root.querySelector('.ep-item')!, { key: 'Home' })).toBe(true);
  });
});

describe('FR-14.8 ↓ in Find reaches the matches in collapsed calls', () => {
  it('↓ from the find field goes to the first row under it', () => {
    vi.useFakeTimers();
    try {
      const { bridge, view, doc } = opened();
      view.find.open();
      const input = view.root.querySelector('.find-bar input') as HTMLInputElement;
      input.value = 'lookup';
      fire(input, 'input');
      vi.advanceTimersByTime(400);
      const hit: SearchHit = {
        anchorId: `${P}/2:total`,
        steps: [],
        labels: ['PriceCalculator.total'],
        hit: { label: 'TaxTable.lookup', range: { file: 'src/x.ts', start: { line: 9, character: 4 }, end: { line: 9, character: 30 } } },
      };
      bridge.send({ type: 'searchResults', query: 'lookup', state: 'done', hits: [hit, { ...hit, hit: { ...hit.hit, label: 'TaxTable.lookup2' } }], methods: 30 });
      key(input, { key: 'ArrowDown' });
      const rows = [...view.root.querySelectorAll('.find-deep-item')];
      expect(doc.activeElement).toBe(rows[0]);
      key(doc.activeElement!, { key: 'ArrowDown' });
      expect(doc.activeElement).toBe(rows[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('FR-14.8 the guard of an alternative says it can be followed', () => {
  const SRC = 'services/order-service.ts';
  const alt = (extra: Partial<Fragment> = {}): Fragment => ({
    id: `${P}#alt0@0`, kind: 'alt', ownerMessageId: P,
    operands: [
      { guard: 'customer', case: 0, range: range(SRC, 20, 8, 8), firstMessageId: `${P}/0:findById`, lastMessageId: `${P}/0:findById` },
      { guard: 'else', case: 1, firstMessageId: `${P}/1:findById`, lastMessageId: `${P}/1:findById` },
    ],
    ...extra,
  });
  const guardTips = (f: Fragment) => {
    const { view } = opened({ ...cloneSequence(), fragments: [f] });
    return [...view.body.querySelectorAll('.frag-guard > title')].map((t) => t.textContent);
  };

  it('two cases: "Right-click: Follow this case"; followed: "Show all cases"; one case or no case number: nothing', () => {
    expect(guardTips(alt())).toEqual([
      '[customer]\nThis case runs if customer is set (not empty, not false)\norder-service.ts:21 · click to go to the code\nRight-click: Follow this case (the other cases leave both diagrams)',
      '[else]\nThis case runs when no case above holds\nRight-click: Follow this case (the other cases leave both diagrams)',
    ]);
    expect(guardTips(alt({ followed: { otherCases: 1 }, operands: [alt().operands[0]] }))[0]).toMatch(/\nRight-click: Show all cases$/);
    expect(guardTips(alt({ operands: [alt().operands[0]] }))[0]).not.toContain('Right-click');
    expect(guardTips(alt({ operands: alt().operands.map(({ case: _, ...o }) => o) }))[0]).not.toContain('Right-click');
    expect(guardTips(alt({ kind: 'opt' }))[0]).not.toContain('Right-click');
  });

  it('an alt / opt guard says in words when it runs; a loop keeps its own words', () => {
    const op = (guard: string) => ({ ...alt().operands[0], guard });
    expect(guardTips(alt({ kind: 'opt', operands: [op('!id')] }))[0]!.split('\n')[1]).toBe('Runs only if id is empty, false or missing');
    expect(guardTips(alt({ operands: [op('user == null'), { ...op('order.items is not null'), case: 1 }] })).map((t) => t!.split('\n')[1])).toEqual([
      'This case runs if user is null',
      'This case runs if no case above holds and order.items is set (not null)',
    ]);
    const opt = (g: string) => guardTips(alt({ kind: 'opt', operands: [op(g)] }))[0]!.split('\n')[1];
    expect(['a > b && c', 'a + b == null', 'f(x) != null', '!(ready())'].map(opt)).toEqual([
      'Runs only if a > b && c',
      'Runs only if a + b == null',
      'Runs only if f(x) != null',
      'Runs only if ready() is empty, false or missing',
    ]);
    // every way of writing a null test, with and without spaces (read without a regex since Sonar S8786)
    expect(['x===null', 'x  ==  null', 'a.b is null', 'x!==null', 'x != null', 'x is not null', 'is null', 'xnull', 'x <= null'].map(opt)).toEqual([
      'Runs only if x is null',
      'Runs only if x is null',
      'Runs only if a.b is null',
      'Runs only if x is set (not null)',
      'Runs only if x is set (not null)',
      'Runs only if x is set (not null)',
      'Runs only if is null',
      'Runs only if xnull is set (not empty, not false)',
      'Runs only if x <= null',
    ]);
    expect(guardTips(alt({ kind: 'loop', operands: [op('item of items')] }))[0]!.split('\n')[1]).toBe('order-service.ts:21 · click to go to the code');
  });
});

describe('FR-14.8 review: reachable from the canvas, the base chosen first', () => {
  it('the first opening waits with the picker; after a review, opening again reviews against that base', () => {
    const { bridge, view } = opened();
    view.showReview();
    expect(bridge.posted).toEqual([{ type: 'requestGitRefs' }]);
    expect(view.root.querySelector('.review-panel [data-cmd="pick-base"]')).not.toBeNull();
    fire([...view.root.querySelectorAll<HTMLElement>('.review-panel .rv-btn.primary')].find((b) => b.textContent === 'Review')!, 'click');
    expect(bridge.last()).toEqual({ type: 'requestReview', base: 'develop', mode: 'split' });
    bridge.send({ type: 'review', state: 'cancelled' });
    bridge.posted.length = 0;
    view.showReview();
    expect(bridge.posted).toEqual([{ type: 'requestGitRefs' }, { type: 'requestReview', base: 'develop', mode: 'split' }]);
  });

  it('a base remembered from an earlier session (no mode saved): opening reviews against it, since the split', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    bridge.setState({ reviewBase: 'main' });
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.posted.length = 0;
    view.showReview();
    expect(bridge.posted).toEqual([{ type: 'requestGitRefs' }, { type: 'requestReview', base: 'main', mode: 'split' }]);
  });

  it('right-click on the empty canvas → Review changes… opens the panel', () => {
    const { bridge, view } = opened();
    fire(view.scroll, 'contextmenu', { clientX: 300, clientY: 400 });
    fire(view.root.querySelector('.popup-layer [data-menu-id="canvas:review"]')!, 'click');
    expect(view.root.querySelector('.review-panel')).not.toBeNull();
    expect(bridge.posted).toEqual([{ type: 'requestGitRefs' }]);
  });
});

describe('FR-14.8 a narrow toolbar keeps the names newcomers start from', () => {
  it('Overview and View keep their labels; the others go to the tooltips', () => {
    const { view } = opened();
    const keep = [...view.toolbar.element.querySelectorAll('.tb-btn.keep-label')].map((b) => b.getAttribute('data-cmd'));
    expect(keep).toEqual(['smartExpand', 'view', 'findings']);
  });
});

describe('FR-16.15 the ⌂ filter also finds methods by name', () => {
  const ep = (label: string, name: string): EntryPoint => ({ kind: 'http', label, method: { key: `src/c.ts#C.${name}`, name, owner: { key: 'src/c.ts#C', name: 'C', kind: 'class' }, isStatic: false, hasBody: true } });
  const m = (owner: string, name: string, kind: 'class' | 'module' = 'class') => ({ key: `src/${owner}.ts#${owner}.${name}`, name, owner: { key: `src/${owner}.ts#${owner}`, name: owner, kind }, isStatic: false, hasBody: true });

  it('after a pause the host is asked; "Searching…", then the methods under the entry points; a click opens one; Enter the only row', () => {
    vi.useFakeTimers();
    try {
      const { bridge, view, doc } = opened();
      bridge.send({ type: 'entryPoints', entryPoints: [ep('GET /orders', 'list')], project: 'shop', show: true });
      const search = view.root.querySelector('.ep-search') as HTMLInputElement;
      const typed = (q: string) => {
        search.value = q;
        fire(search, 'input');
      };
      typed('au'); // too short: not asked
      vi.advanceTimersByTime(400);
      expect(bridge.posted.filter((x) => x.type === 'searchMethods')).toEqual([]);
      typed('audit');
      vi.advanceTimersByTime(100);
      typed('audit pers'); // typing on: only the last is asked
      vi.advanceTimersByTime(400);
      expect(bridge.posted.filter((x) => x.type === 'searchMethods')).toEqual([{ type: 'searchMethods', query: 'audit pers' }]);
      expect(view.root.querySelector('.ep-methods-status')!.textContent).toBe('Searching the methods…');
      // an older answer is dropped
      bridge.send({ type: 'methodResults', query: 'audit', methods: [m('Audit', 'old')], more: 0 });
      expect(view.root.querySelector('.ep-method-row')).toBeNull();
      bridge.send({ type: 'methodResults', query: 'audit pers', methods: [m('AuditEntry', 'persist'), m('audit', 'persistAll', 'module')], more: 4 });
      const rows = [...view.root.querySelectorAll<HTMLElement>('.ep-method-row')];
      expect(rows.map((r) => r.textContent)).toEqual(['AuditEntry.persistAuditEntry.ts', 'persistAllaudit.ts']);
      expect(view.root.querySelector('.ep-methods-head')!.textContent).toBe('Methods 2+');
      expect(view.root.querySelector('.ep-more')!.textContent).toBe('+4 more — refine the filter');
      rows[1].click(); // a module function: its name alone in the placeholder
      expect(bridge.last()).toEqual({ type: 'openMethod', methodKey: 'src/audit.ts#audit.persistAll' });
      expect(view.placeholder.textContent).toContain('Building the diagram of persistAll…');
      // one method and no entry point: Enter opens it
      bridge.send({ type: 'render', diagram: cloneSequence() });
      fire(view.toolbar.button('entryPoints'), 'click');
      bridge.send({ type: 'entryPoints', entryPoints: [ep('GET /orders', 'list')], project: 'shop', show: true });
      const s2 = view.root.querySelector('.ep-search') as HTMLInputElement;
      s2.value = 'persist';
      fire(s2, 'input');
      vi.advanceTimersByTime(400);
      bridge.send({ type: 'methodResults', query: 'persist', methods: [m('AuditEntry', 'persist')], more: 0 });
      key(s2, { key: 'Enter' });
      expect(bridge.last()).toEqual({ type: 'openMethod', methodKey: 'src/AuditEntry.ts#AuditEntry.persist' });
      // no answer for a filter the panel no longer has open: nothing breaks
      bridge.send({ type: 'methodResults', query: 'persist', methods: [], more: 0 });
      expect(doc.querySelector('.ep-method-row')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('nothing found: no Methods group; the filter cleared: none either', () => {
    vi.useFakeTimers();
    try {
      const { bridge, view } = opened();
      bridge.send({ type: 'entryPoints', entryPoints: [ep('GET /orders', 'list')], project: 'shop', show: true });
      const search = view.root.querySelector('.ep-search') as HTMLInputElement;
      search.value = 'zzz';
      fire(search, 'input');
      vi.advanceTimersByTime(400);
      bridge.send({ type: 'methodResults', query: 'zzz', methods: [], more: 0 });
      expect(view.root.querySelector('.ep-methods-head')).toBeNull();
      expect(view.root.querySelector('.ep-list')!.textContent).toBe('No match');
      search.value = '';
      fire(search, 'input');
      expect(view.root.querySelector('.ep-method-row, .ep-methods-status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Find bar goes with Escape from anywhere, and with the flow', () => {
  it('Escape on the canvas closes it; another flow closes it; the same flow keeps it', () => {
    const { bridge, view } = opened();
    const bar = view.root.querySelector('.find-bar') as HTMLElement;
    bridge.send({ type: 'openFind', query: 'total' });
    expect(bar.hidden).toBe(false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(bar.hidden).toBe(true);
    bridge.send({ type: 'openFind', query: 'total' });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(bar.hidden).toBe(false);
    const other = cloneSequence();
    other.root = { ...other.root, key: 'other#X.y' };
    bridge.send({ type: 'render', diagram: other });
    expect(bar.hidden).toBe(true);
  });
});
