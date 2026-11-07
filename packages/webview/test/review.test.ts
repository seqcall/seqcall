// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EntryPoint, HostToSequenceView, MethodRef, ReviewIssue, ReviewResult, SequenceViewToHost, StructureRow } from '@seqcall/protocol';
import { messageCard, startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { reviewMarkdown } from '../src/sequence/review-panel';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

const ref = (cls: string, name: string): MethodRef => ({ key: `src/${cls}.ts#${cls}.${name}`, name, owner: { key: `src/${cls}.ts#${cls}`, name: cls, kind: 'class' }, isStatic: false, hasBody: true }) as MethodRef;
const ep: EntryPoint = { kind: 'http', verb: 'POST', label: 'POST /orders/{id:long}', method: ref('OrdersController', 'store') };
const steps = [{ methodKey: ep.method.key, call: { range: { file: 'src/OrdersController.ts', start: { line: 9, character: 4 }, end: { line: 9, character: 20 } } } }, { methodKey: ref('Order', 'total').key }];
const issue: ReviewIssue = {
  finding: { id: 'lv', kind: 'layer-violation', title: 'Layer violation: Order → Db', detail: 'Domain → Infrastructure', messageIds: ['root/0:total/0:save'] },
  where: 'changed-lines',
  at: { file: 'src/domain/order.ts', line: 4 },
  entryPoint: ep,
};
const result: ReviewResult = {
  base: 'develop',
  resolvedBase: 'develop',
  branch: 'feature/total',
  files: [{ file: 'src/domain/order.ts', path: '/p/src/domain/order.ts', status: 'modified', added: 3, removed: 1 }],
  methods: [
    { method: ref('Order', 'total'), status: 'changed', lines: [4], reachedFrom: [{ entryPoint: ep, steps }], tests: 2 },
    { method: ref('Order', 'discount'), status: 'added', lines: [7, 8, 9], reachedFrom: [], tests: 0 },
  ],
  issues: [issue],
  scanned: 2,
  notScanned: 0,
  otherLines: 1,
};

describe('FR-24 review of a branch', () => {
  const setup = () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.posted.length = 0;
    return { bridge, view, panel: () => view.root.querySelector('.review-panel') as HTMLElement };
  };

  it('FR-24.3 ⌂ → Review changes: the first time the base picker waits, Review starts it against develop, shows progress, then the result grouped', () => {
    const { bridge, view, panel } = setup();
    fire(view.toolbar.button('entryPoints'), 'click');
    bridge.send({ type: 'entryPoints', entryPoints: [ep], project: 'shop' });
    fire(view.root.querySelector('.ep-review-btn')!, 'click');
    expect(bridge.posted.slice(-1)).toEqual([{ type: 'requestGitRefs' }]);
    expect(panel().querySelector('[data-cmd="pick-base"]')).not.toBeNull();
    fire([...panel().querySelectorAll<HTMLElement>('.rv-btn.primary')].find((b) => b.textContent === 'Review')!, 'click');
    expect(bridge.posted.slice(-1)).toEqual([{ type: 'requestReview', base: 'develop', mode: 'split' }]);
    bridge.send({ type: 'review', state: 'running', phase: 'Walking the callers up to the entry points', done: 3, total: 8 });
    expect(panel().textContent).toContain('Walking the callers up to the entry points… 3 / 8');
    bridge.send({ type: 'review', state: 'done', result });
    // the host redraws the diagram with the change marks: the panel stays
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(panel().querySelector('.ep-title')!.textContent).toContain('feature/total vs develop');
    expect(panel().querySelector('.rv-summary')!.textContent).toBe('2 methods changed in 1 file · 1 entry point affected · ⚠ 1 issue on changed lines · no test file changed');
    const groups = [...panel().querySelectorAll('.ep-group')].map((g) => g.textContent);
    expect(groups).toEqual(['Issues 1', 'Entry points affected 1', 'Changed, no static caller from an entry point 1 — called dynamically (container, untyped factory), by the framework, or not yet']);
    const rows = [...panel().querySelectorAll('.rv-item')].map((r) => r.textContent);
    expect(rows).toEqual([
      'Layer violation: Order → Dborder.ts:4 · ← POST /orders/{id}',
      'POST /orders/{id}',
      '▲Order.totalchanged · 1 line · called by 2 tests',
      '✚Order.discountadded',
    ]);
  });

  it('FR-24.3 rows open: the issue\'s flow, a changed method from its entry point, an unreached method; the base is remembered', () => {
    const { bridge, view, panel } = setup();
    view.showReview(false);
    bridge.send({ type: 'review', state: 'done', result, show: true });
    const item = (i: number) => panel().querySelectorAll('.rv-item')[i] as HTMLElement;
    fire(item(0), 'click');
    expect(bridge.last()).toEqual({ type: 'openReviewIssue', issue });
    view.showReview(false);
    fire(item(2), 'click');
    expect(bridge.last()).toEqual({ type: 'openPath', steps, entryPoint: ep });
    view.showReview(false);
    fire(item(3), 'click');
    expect(bridge.last()).toEqual({ type: 'openPath', steps: [{ methodKey: ref('Order', 'discount').key }] });
    // another base: typed into the picker (a name nothing in the lists matches: Enter uses it)
    view.showReview(false);
    fire(panel().querySelector('[data-cmd="pick-base"]')!, 'click');
    const input = panel().querySelector('.rv-filter') as HTMLInputElement;
    input.value = 'main';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(bridge.last()).toEqual({ type: 'requestReview', base: 'main', mode: 'split' });
    expect(bridge.getState<{ reviewBase?: string }>()?.reviewBase).toBe('main');
    // End review
    bridge.send({ type: 'review', state: 'done', result });
    fire([...panel().querySelectorAll('button')].find((b) => b.textContent === 'End review')!, 'click');
    expect(bridge.last()).toEqual({ type: 'endReview' });
  });

  // FR-29 Level 0: the structural delta on top of the panel
  const structureRows: StructureRow[] = [
    { kind: 'violation-added', title: 'Layer violation: Order → Db', detail: 'Domain must not depend on Infrastructure', level: 'layer', from: 'layer:Domain', to: 'layer:Infrastructure', pairs: [{ from: 'src/domain/order.ts#Order', fromName: 'Order', to: 'src/infrastructure/db.ts#Db', toName: 'Db' }], entryPoint: ep },
    { kind: 'edge-added', title: 'Domain → Infrastructure', detail: 'Order → Db', level: 'layer', from: 'layer:Domain', to: 'layer:Infrastructure', pairs: [{ from: 'src/domain/order.ts#Order', fromName: 'Order', to: 'src/infrastructure/db.ts#Db', toName: 'Db' }], entryPoint: ep },
    { kind: 'entry-added', title: 'DELETE /orders/{id:long}', detail: 'OrdersController.remove', entryPoint: { kind: 'http', verb: 'DELETE', label: 'DELETE /orders/{id:long}', method: ref('OrdersController', 'remove') } },
    { kind: 'edge-removed', title: 'orders → billing', detail: 'OrderService → InvoiceService', level: 'package', from: 'src/application/orders', to: 'src/application/billing', pairs: [{ from: 'a#OrderService', fromName: 'OrderService', to: 'b#InvoiceService', toName: 'InvoiceService' }], entryPoint: ep },
    { kind: 'entry-removed', title: 'GET /legacy/orders', detail: 'LegacyController.list', entryPoint: { kind: 'http', verb: 'GET', label: 'GET /legacy/orders', method: ref('LegacyController', 'list') } },
  ];
  const withStructure: ReviewResult = { ...result, structure: { rows: structureRows, compared: 2, copied: 5, notCompared: 1 } };

  it('FR-29.5 the Structure group comes first: what appeared and vanished, each row opening its flow; nothing to open for an entry point only the base has', () => {
    const { bridge, view, panel } = setup();
    view.showReview(false);
    bridge.send({ type: 'review', state: 'done', result: withStructure, show: true });
    const groups = [...panel().querySelectorAll('.ep-group')].map((g) => g.textContent);
    expect(groups[0]).toBe('Structure 5 — 1 affected entry point not compared (limit)');
    const rows = [...panel().querySelectorAll('.rv-struct')].map((r) => r.textContent);
    expect(rows).toEqual([
      '✚Layer violation: Order → Dbnew layer violation · Domain must not depend on Infrastructure · ← POST /orders/{id}',
      '✚Domain → Infrastructurenew dependency between layers · Order → Db · ← POST /orders/{id}',
      '✚DELETE /orders/{id}new entry point · OrdersController.remove',
      '−orders → billingdependency between packages removed · OrderService → InvoiceService · ← POST /orders/{id}',
      '−GET /legacy/ordersentry point removed · LegacyController.list',
    ]);
    const item = (i: number) => panel().querySelectorAll('.rv-struct')[i] as HTMLElement;
    fire(item(1), 'click');
    expect(bridge.last()).toEqual({ type: 'openReviewStructure', row: structureRows[1] });
    view.showReview(false);
    bridge.posted.length = 0;
    fire(item(4), 'click');
    expect(bridge.posted).toEqual([]);
    // no structural change: one quiet line instead of the group
    view.showReview(false);
    bridge.send({ type: 'review', state: 'done', result: { ...result, structure: { rows: [], compared: 1, copied: 6, notCompared: 0 } }, show: true });
    expect(panel().querySelector('.rv-shape-ok')!.textContent).toBe('No structural change: the same dependencies, cycles, I/O kinds and clients between layers and packages, layer violations, layers and roles of classes and entry points as the base.');
    expect([...panel().querySelectorAll('.ep-group')].map((g) => g.textContent)[1]).toBe('Issues 1');
  });

  it('FR-29.5 Copy as Markdown starts with the structure (or says it did not change)', () => {
    expect(reviewMarkdown(withStructure).split('\n').slice(2, 10)).toEqual([
      '**Structure**',
      '- ✚ Layer violation: Order → Db — new layer violation: Domain must not depend on Infrastructure (← `POST /orders/{id}`)',
      '- ✚ Domain → Infrastructure — new dependency between layers: Order → Db (← `POST /orders/{id}`)',
      '- ✚ DELETE /orders/{id} — new entry point: OrdersController.remove',
      '- − orders → billing — dependency between packages removed: OrderService → InvoiceService (← `POST /orders/{id}`)',
      '- − GET /legacy/orders — entry point removed: LegacyController.list',
      '- 1 affected entry points not compared (limit)',
      '',
    ]);
    expect(reviewMarkdown({ ...result, structure: { rows: [], compared: 1, copied: 6, notCompared: 0 } }).split('\n')[2]).toBe('No structural change: the same dependencies, cycles, I/O kinds and clients between layers and packages, layer violations, layers and roles of classes and entry points as the base.');
  });

  it('FR-29.7 … 28.11 I/O kinds and clients, cycles, layer and role changes in the panel and the Markdown', () => {
    const a2: StructureRow[] = [
      { kind: 'cycle-added', title: 'Cycle: Application → Infrastructure → Application', detail: 'OrderRepo → Clock', level: 'layer', members: ['layer:Application', 'layer:Infrastructure'], entryPoint: ep },
      { kind: 'io-added', title: 'Infrastructure: File', detail: 'ReportFile', level: 'layer', from: 'layer:Infrastructure', io: 'file', classKeys: ['r#ReportFile'], entryPoint: ep },
      { kind: 'layer-changed', title: 'TaxTable: Domain → Infrastructure', detail: 'moved from src/domain/tax-table.ts', level: 'layer', from: 'layer:Domain', to: 'layer:Infrastructure', classKeys: ['t#TaxTable'], entryPoint: ep },
      { kind: 'cycle-removed', title: 'Cycle: billing → orders → billing', detail: 'InvoiceService → Audit', level: 'package', members: ['b', 'o'], entryPoint: ep },
      { kind: 'io-removed', title: 'Domain: HTTP', detail: 'Order', level: 'layer', from: 'layer:Domain', io: 'http', entryPoint: ep },
      // FR-29.10 / 28.11
      { kind: 'client-added', title: 'Infrastructure: Confluent.Kafka (Queue)', detail: 'EventBus', level: 'layer', from: 'layer:Infrastructure', io: 'queue', client: 'Confluent.Kafka', entryPoint: ep },
      { kind: 'role-changed', title: 'OrderRepo: «repository» → «repository» «singleton»', detail: '«singleton» — it holds a static instance of itself', level: 'layer', entryPoint: ep },
    ];
    const { bridge, view, panel } = setup();
    view.showReview(false);
    bridge.send({ type: 'review', state: 'done', result: { ...result, structure: { rows: a2, compared: 1, copied: 0, notCompared: 0 } }, show: true });
    expect([...panel().querySelectorAll('.rv-struct')].map((r) => r.textContent)).toEqual([
      '✚Cycle: Application → Infrastructure → Applicationnew cycle between layers · OrderRepo → Clock · ← POST /orders/{id}',
      '✚Infrastructure: Filenew I/O kind in the layer · ReportFile · ← POST /orders/{id}',
      '↦TaxTable: Domain → Infrastructureclass changed layer · moved from src/domain/tax-table.ts · ← POST /orders/{id}',
      '−Cycle: billing → orders → billingcycle between packages removed · InvoiceService → Audit · ← POST /orders/{id}',
      '−Domain: HTTPI/O kind in the layer removed · Order · ← POST /orders/{id}',
      '✚Infrastructure: Confluent.Kafka (Queue)new I/O client in the layer · EventBus · ← POST /orders/{id}',
      '↦OrderRepo: «repository» → «repository» «singleton»class changed role · «singleton» — it holds a static instance of itself · ← POST /orders/{id}',
    ]);
    expect(panel().querySelectorAll('.rv-struct .rv-status')[2].className).toBe('rv-status changed');
    expect(reviewMarkdown({ ...result, structure: { rows: a2, compared: 1, copied: 0, notCompared: 0 } }).split('\n')[5]).toBe(
      '- ↦ TaxTable: Domain → Infrastructure — class changed layer: moved from src/domain/tax-table.ts (← `POST /orders/{id}`)',
    );
  });

  it('FR-24.5 Copy as Markdown: issues, entry points affected, unreached, untested, risks', () => {
    expect(reviewMarkdown(result)).toBe(
      [
        '**Seqcall review** — `feature/total` vs `develop`: 2 methods changed in 1 file',
        '',
        '**Issues**',
        '- ⚠ Layer violation: Order → Db — order.ts:4 (← `POST /orders/{id}`)',
        '',
        '**Entry points affected**',
        '- `POST /orders/{id}` — Order.total',
        '',
        '**No static caller from an entry point:** Order.discount',
        '',
        '**No test calls directly:** Order.discount',
        '',
        '**No test file changed.**',
      ].join('\n'),
    );
  });

  it('FR-24.2 methods past the walk limit: their own group, a note and a Markdown line, never "no static caller"', () => {
    const { bridge, view, panel } = setup();
    const more: ReviewResult = { ...result, methods: [...result.methods, { method: ref('Order', 'refund'), status: 'added', lines: [20], reachedFrom: [], tests: 0, notWalked: true }, { method: ref('Order', 'cancel'), status: 'changed', lines: [30], reachedFrom: [], tests: 0, notWalked: true }] };
    view.showReview(false);
    bridge.send({ type: 'review', state: 'done', result: more, show: true });
    const groups = [...panel().querySelectorAll('.ep-group')].map((g) => g.textContent);
    expect(groups.slice(2, 4)).toEqual([
      'Changed, no static caller from an entry point 1 — called dynamically (container, untyped factory), by the framework, or not yet',
      'Changed, callers not walked (limit) 2 — too many changed methods: who reaches these is unknown',
    ]);
    expect([...panel().querySelectorAll('.rv-item')].map((r) => r.textContent).slice(4, 6)).toEqual(['✚Order.refundadded · callers not walked', '▲Order.cancelchanged · callers not walked']);
    expect(panel().querySelector('.rv-legend')!.textContent).toContain('2 changed methods were not walked up to the entry points (limit).');
    const md = reviewMarkdown(more).split('\n');
    expect(md).toContain('**No static caller from an entry point:** Order.discount');
    expect(md).toContain('**Callers not walked (limit):** Order.refund, Order.cancel');
  });

  it('FR-24.4 the diagram marks calls on changed lines and methods added / changed', () => {
    const { bridge, view } = setup();
    const d = cloneSequence();
    d.messages[2].diff = { call: true };
    d.messages[3].diff = { method: 'added' };
    d.messages[4].diff = { call: true, method: 'changed' };
    bridge.send({ type: 'render', diagram: d });
    const el = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
    expect(el(d.messages[2].id).classList.contains('diff-call')).toBe(true);
    expect([...el(d.messages[3].id).classList]).toEqual(expect.arrayContaining(['diff-method', 'diff-added']));
    expect([...el(d.messages[4].id).classList]).toEqual(expect.arrayContaining(['diff-call', 'diff-method', 'diff-changed']));
  });

  it('FR-24.6 / FR-24.7 compared with the base: added, changed, removed (ghost) calls and participants; the hunk in the card; a click opens the diff', () => {
    const { bridge, view } = setup();
    const d = cloneSequence();
    const [a, b] = [d.messages[2], d.messages[3]];
    a.diff = { call: true, status: 'added', hunk: [{ kind: ' ', text: 'const x = 1;' }, { kind: '+', text: 'this.audit.log(x);', at: true }] };
    b.diff = { call: true, status: 'changed' };
    const ghostTo = { ...d.participants[d.participants.length - 1], id: 'gone|x', classKey: 'src/Gone.ts#Gone', className: 'Gone', label: ':Gone', diff: 'removed' as const };
    d.participants.push(ghostTo);
    const ghost = { ...a, id: `${a.parentId}/~9:notify`, methodName: 'notify', to: ghostTo.id, expandable: false, expanded: false, diff: { status: 'removed' as const, hunk: [{ kind: '-' as const, text: 'this.gone.notify();', at: true }] } };
    d.messages.splice(4, 0, ghost);
    bridge.send({ type: 'render', diagram: d });
    const el = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;
    expect(el(a.id).classList.contains('diff-st-added')).toBe(true);
    expect(el(b.id).classList.contains('diff-st-changed')).toBe(true);
    expect(el(ghost.id).classList.contains('diff-st-removed')).toBe(true);
    expect(el(ghost.id).querySelector('.msg-line')!.getAttribute('marker-end')).toBe('url(#seqcall-arrow-removed)');
    expect(view.root.querySelector(`.participant.diff-removed[data-participant-id="gone|x"]`)).not.toBeNull();
    // the card: what happened and the diff lines around the call
    const card = messageCard(a, document, d).map((n) => (n as HTMLElement).textContent);
    expect(card).toContain('New call on this branch');
    expect(card.find((t) => t?.includes('+ this.audit.log(x);'))).toBeDefined();
    expect(messageCard(ghost, document, d).map((n) => (n as HTMLElement).textContent)).toContain('Removed on this branch (the base version made this call)');
    expect(card).toContain('Click the call (or right-click → Show the change) to open its file side by side, base ↔ now');
    // the same line reaching another method: why it is marked although the line was not edited
    const retargeted = { ...b, diff: { status: 'changed' as const, before: 'ParcelApiClient.Join' }, polymorphic: { interfaceKey: 'k', interfaceName: 'IShippingApi', implementations: [{ key: 'a', name: 'ParcelApiClient' }, { key: 'b', name: 'SecondApiClient' }] } } as never;
    expect(messageCard(retargeted, document, d).map((n) => (n as HTMLElement).textContent)).toEqual(
      expect.arrayContaining(['Reaches another method than before: ParcelApiClient.Join', 'This line was not edited: IShippingApi now has 2 implementations, so the call is no longer resolved to one']),
    );
    // a click opens the change side by side; the ghost's menu offers only that
    fire(el(a.id).querySelector('.msg-hit')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openDiff', messageId: a.id });
    fire(el(ghost.id).querySelector('.msg-hit')!, 'contextmenu', { clientX: 20, clientY: 20 });
    const items = [...view.root.querySelectorAll('.popup-layer [data-menu-id]')].map((i) => i.getAttribute('data-menu-id'));
    expect(items).toEqual(['show-diff']);
    fire(view.root.querySelector('.popup-layer [data-menu-id="show-diff"]')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openDiff', messageId: ghost.id });
  });

  it('FR-24.8 a reused review says when it was computed; ↻ Re-run computes it again', () => {
    const { bridge, view, panel } = setup();
    view.showReview(false);
    const at = new Date(2026, 9, 7, 11, 42).toISOString();
    bridge.send({ type: 'review', state: 'done', result: { ...result, computedAt: at, reused: true }, show: true });
    expect(panel().querySelector('.rv-when')!.textContent).toBe('Computed at 11:42 — nothing changed since (same commits, edits and base)');
    const rerun = [...panel().querySelectorAll('.rv-base button')].find((b) => b.textContent === '↻ Re-run')!;
    fire(rerun, 'click');
    expect(bridge.last()).toEqual({ type: 'requestReview', base: 'develop', mode: 'split', force: true });
    // a fresh result: only the time
    bridge.send({ type: 'review', state: 'done', result: { ...result, computedAt: at }, show: true });
    expect(panel().querySelector('.rv-when')!.textContent).toBe('Computed at 11:42');
  });

  it('FR-24.11 an object whose class the branch changed shows Δn (new: NEW); clicking the tag opens the class side by side', () => {
    const { bridge, view } = setup();
    const d = cloneSequence();
    d.participants[1].change = { kind: 'changed', members: [{ kind: 'method', name: 'total', change: 'changed', text: 'total(): number' }, { kind: 'field', name: 'db', change: 'added', text: 'db: Db' }] };
    d.participants[2].change = { kind: 'new', members: [] };
    d.participants[3].diff = 'added';
    bridge.send({ type: 'render', diagram: d });
    const box = (i: number) => view.header.querySelector(`[data-participant-id="${d.participants[i].id}"]`)!;
    expect(box(1).querySelector('.change-tag')!.textContent).toContain('Δ2');
    expect(box(2).querySelector('.change-tag')!.textContent).toContain('NEW');
    expect(box(3).querySelector('.change-tag')).toBeNull();
    expect(box(3).querySelector(':scope > title')!.textContent).toContain('only this branch’s flow reaches it');
    fire(box(1).querySelector('.change-tag rect')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openDiff', classKey: d.participants[1].classKey });
  });
});

describe('FR-24.13 compare with: a searchable list of branches, tags and commits, and the mode', () => {
  const now = Date.now();
  const refs = {
    current: 'feature/SHOP-683',
    upstream: 'origin/feature/SHOP-683',
    target: 'develop',
    branches: [
      { name: 'develop', remote: false, date: now - 3600_000 * 26, hash: '1ada730', subject: 'Merge pull request #393' },
      { name: 'origin/develop', remote: true, date: now - 3600_000 * 26, hash: '1ada730', subject: 'Merge pull request #393' },
    ],
    tags: [{ name: 'v1.2.0', date: now - 86_400_000 * 30, hash: 'abc1234' }],
    commits: [
      { hash: 'a57b2ce', date: now - 3600_000 * 3, author: 'Alice', subject: 'Add CanIUse checks' },
      { hash: '5a4ddc7', date: now - 86_400_000 * 2, author: 'Bob', subject: 'Second provider client' },
    ],
  };
  const setup = () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    view.showReview(false);
    bridge.send({ type: 'gitRefs', refs });
    const panel = () => view.root.querySelector('.review-panel') as HTMLElement;
    const open = () => fire(panel().querySelector('[data-cmd="pick-base"]')!, 'click');
    const rows = () => [...panel().querySelectorAll('.rv-choice')].map((r) => r.querySelector('.fc-label')!.textContent);
    const filter = (q: string) => {
      const input = panel().querySelector('.rv-filter') as HTMLInputElement;
      input.value = q;
      input.dispatchEvent(new Event('input'));
    };
    return { bridge, view, panel, open, rows, filter };
  };

  it('FR-24.13 the list: quick choices, branches (most recent first), tags, commits; the filter matches names, messages and hashes', () => {
    const { panel, open, rows, filter } = setup();
    open();
    expect([...panel().querySelectorAll('.rv-pick-list .fc-sep')].map((s) => s.textContent)).toEqual(['Quick', 'Branches', 'Tags', 'Commits on feature/SHOP-683']);
    expect(rows().slice(0, 4)).toEqual(['Pull request into develop', 'Not pushed yet', 'Since the previous commit', 'Uncommitted changes only']);
    expect(rows()).toContain('a57b2ce Add CanIUse checks');
    filter('canIuse');
    expect(rows()).toEqual(['a57b2ce Add CanIUse checks']);
    filter('5a4d');
    expect(rows()).toEqual(['5a4ddc7 Second provider client']);
    filter('zzz');
    expect(panel().querySelector('.rv-pick-list')!.textContent).toContain('Enter: compare with "zzz"');
  });

  it('FR-24.13 picking runs the review: a quick choice with its mode, a commit, a typed ref; tip against tip', () => {
    const { bridge, panel, open, filter } = setup();
    open();
    const pick = (label: string) => fire([...panel().querySelectorAll('.rv-choice')].find((r) => r.querySelector('.fc-label')!.textContent === label)!, 'click');
    pick('Not pushed yet');
    expect(bridge.last()).toEqual({ type: 'requestReview', base: 'origin/feature/SHOP-683', mode: 'split' });
    bridge.send({ type: 'review', state: 'done', result, show: true });
    open();
    pick('a57b2ce Add CanIUse checks');
    expect(bridge.last()).toMatchObject({ type: 'requestReview', base: 'a57b2ce' });
    bridge.send({ type: 'review', state: 'done', result, show: true });
    open();
    filter('HEAD~3');
    (panel().querySelector('.rv-filter') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(bridge.last()).toMatchObject({ type: 'requestReview', base: 'HEAD~3' });
    bridge.send({ type: 'review', state: 'done', result, show: true });
    const direct = panel().querySelector('input[name="rv-mode"][value="direct"]') as HTMLInputElement;
    direct.checked = true;
    direct.dispatchEvent(new Event('change'));
    expect(bridge.last()).toEqual({ type: 'requestReview', base: 'HEAD~3', mode: 'direct' });
  });

  it('FR-24.13 the summary says what was compared; an empty review says why (changes only outside the project)', () => {
    const { bridge, panel } = setup();
    bridge.send({ type: 'review', state: 'done', show: true, result: { ...result, branch: 'develop', resolvedBase: 'feature/SHOP-683', files: [], methods: [], compare: { mode: 'split', point: '5a4ddc7a3', commits: 2, behind: 0, outside: ['.platform/hooks/prebuild/04_pgpool.sh'] } } });
    expect(panel().textContent).toContain('No changes in this project against feature/SHOP-683.');
    expect(panel().querySelector('.rv-compared')!.textContent).toBe('develop ↔ merge base 5a4ddc7a3 of feature/SHOP-683 · 2 commits · 0 files in this project (1 outside: .platform/hooks/prebuild/04_pgpool.sh)');
    bridge.send({ type: 'review', state: 'done', show: true, result: { ...result, branch: 'develop', resolvedBase: 'feature/SHOP-683', compare: { mode: 'direct', point: 'a57b2ceb8', commits: 2, behind: 13, outside: [] } } });
    expect(panel().querySelector('.rv-compared')!.textContent).toBe(`develop ↔ feature/SHOP-683 (a57b2ceb8) · 2 commits only here, 13 only in feature/SHOP-683 · ${result.files.length} file${result.files.length === 1 ? '' : 's'} in this project`);
  });
});
