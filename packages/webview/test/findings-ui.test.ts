// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassViewToHost, HostToClassView, HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

describe('FR-19 findings in the views', () => {
  it('FR-19.7 the sequence toolbar shows ⚠ N for every flow (muted at 0, says so); picking one highlights its evidence', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    expect(view.toolbar.button('findings').hidden).toBe(true); // no flow yet
    bridge.send({ type: 'render', diagram: cloneSequence() });
    const zero = view.toolbar.button('findings');
    expect(zero.hidden).toBe(false);
    expect(zero.classList.contains('tb-zero')).toBe(true);
    expect(zero.title).toMatch(/^No design issues or layer violations in the shown calls/);
    fire(zero, 'click');
    expect(view.root.querySelector('.popup-layer [data-menu-id="no-issues"]')!.classList.contains('disabled')).toBe(true);
    const d = cloneSequence();
    const id = d.messages[2].id;
    d.findings = [{ id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', detail: 'N+1', messageIds: [id] }];
    bridge.send({ type: 'render', diagram: d });
    const btn = view.toolbar.button('findings');
    expect(btn.hidden).toBe(false);
    expect(btn.classList.contains('tb-zero')).toBe(false);
    expect(btn.querySelector('.tb-badge')!.textContent).toBe('1');
    fire(btn, 'click');
    const row = view.root.querySelector('.popup-layer [data-menu-id="finding:f1"]') as HTMLElement;
    expect(row.textContent).toContain('I/O in a loop: Repo.find (DB)');
    expect(row.title).toBe('N+1');
    fire(row, 'click');
    expect(view.body.querySelector(`[data-msg-id="${id}"]`)!.classList.contains('highlighted')).toBe(true);
  });

  it('issues inside folded calls: ⚠ shows +n (not muted), names them, one click expands all', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: { ...cloneSequence(), issuesBelow: { count: 2, titles: ['I/O in a loop: Repo.find (DB)', 'Layer violation: A → B'] } } });
    const btn = view.toolbar.button('findings');
    expect(btn.classList.contains('tb-zero')).toBe(false);
    expect(btn.querySelector('.tb-badge')!.textContent).toBe('');
    expect(btn.querySelector('.tb-more')!.textContent).toBe('+2');
    // the folded ones first: no "No design issues" beside +2
    expect(btn.title).toBe('2 inside folded calls, none in the shown calls — Expand all shows them');
    fire(btn, 'click');
    const row = view.root.querySelector('.popup-layer [data-menu-id="issues-below"]') as HTMLElement;
    expect(row.title).toBe('I/O in a loop: Repo.find (DB)\nLayer violation: A → B');
    expect(view.root.querySelector('.popup-layer [data-menu-id="no-issues"]')).toBeNull();
    fire(row, 'click');
    expect(bridge.last()).toEqual({ type: 'expandAll' });
  });

  it('FR-19.17 the sequence diagram lists the class issues and the layer violations too: violating calls red, the violation card', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const call = d.messages[2];
    const [from, to] = [d.participants.find((p) => p.id === call.from)!, d.participants.find((p) => p.id === call.to)!];
    d.findings = [
      { id: 'g1', kind: 'god-class', title: 'God class: OrderService (28 methods, 900 lines)', classKeys: [to.classKey] },
      {
        id: 'layer-violation:r1',
        kind: 'layer-violation',
        title: `Layer violation: ${from.className} → ${to.className}`,
        detail: 'Domain → Infrastructure: an inner layer depends on an outer layer',
        messageIds: [call.id],
        classKeys: [from.classKey, to.classKey],
        relationIds: ['r1'],
        evidence: [`${from.className} → ${to.className}: x calls y (a.ts:3)`],
      },
    ];
    bridge.send({ type: 'render', diagram: d });
    expect(view.toolbar.button('findings').querySelector('.tb-badge')!.textContent).toBe('2');
    // the violating call is red, as its relation in the class diagram
    expect(view.body.querySelector(`[data-msg-id="${call.id}"]`)!.classList.contains('violates')).toBe(true);
    expect(view.body.querySelectorAll('.message.violates')).toHaveLength(1);
    fire(view.toolbar.button('findings'), 'click');
    const rows = [...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.textContent);
    expect(rows[0]).toContain('◉ God class: OrderService');
    expect(rows[1]).toContain('⚠ 1 layer violation');
    expect(rows[2]).toContain(`${from.className} → ${to.className}`);
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:layer-violation:r1"]')!, 'click');
    const card = view.root.querySelector('.guide-card')!;
    expect(card.querySelector('.gc-title')!.textContent).toContain('⚠ Layer violation:');
    expect([...card.querySelectorAll('.gc-evidence li')].map((l) => l.textContent)).toEqual([`${from.className} → ${to.className}: x calls y (a.ts:3)`]);
    fire([...card.querySelectorAll('.gc-btn')].find((b) => b.textContent === 'Adjust the rule')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openDependencyRule' });
  });

  it('FR-19.17 the class view has the same ⚠ N as the sequence view: design findings, then the layer violations; the violation card has the evidence', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    bridge.send({
      type: 'render',
      diagram: {
        classes: [node('A'), node('B')],
        relations: [{ id: 'r1', kind: 'dependency', from: 'A', to: 'B', violation: 'Domain → Infrastructure' }],
        findings: [
          { id: 'p1', kind: 'io-in-loop', title: 'I/O in a loop: B.find (DB)', classKeys: ['B'] },
          { id: 'layer-violation:r1', kind: 'layer-violation', title: 'Layer violation: A → B', detail: 'Domain → Infrastructure', classKeys: ['A', 'B'], relationIds: ['r1'], evidence: ['A → B: run calls find'] },
        ],
      },
    });
    const btn = view.root.querySelector('[data-cmd="findings"]') as HTMLElement;
    expect(btn.querySelector('.tb-badge')!.textContent).toBe('2');
    expect(btn.title).toBe('1 design issue, 1 layer violation in the shown calls — click for the list');
    // no legend chips for them any more: the legend is the layers'
    expect(view.root.querySelector('.layer-legend .layer-violations, .layer-legend .class-findings')).toBeNull();
    fire(btn, 'click');
    expect([...view.root.querySelectorAll('.popup-layer .menu-item')].map((r) => r.textContent)).toEqual(['⟳ I/O in a loop: B.find (DB)', '⚠ 1 layer violation', 'A → BDomain → Infrastructure']);
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:layer-violation:r1"]')!, 'click');
    expect([...view.root.querySelectorAll('.guide-card .gc-evidence li')].map((l) => l.textContent)).toEqual(['A → B: run calls find']);
  });

  it('FR-19.21 the sequence diagram marks each design issue at its evidence: after its first call, or on the participants of a class-only issue; hover = title, click = card', async () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const call = d.messages[2];
    const part = d.participants.find((p) => p.id === call.to)!;
    d.findings = [
      { id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', messageIds: [call.id], classKeys: [part.classKey] },
      { id: 'f2', kind: 'god-class', title: 'God class: Repo', classKeys: [part.classKey] },
      { id: 'v1', kind: 'layer-violation', title: 'Layer violation', messageIds: [call.id], classKeys: [part.classKey] },
    ];
    bridge.send({ type: 'render', diagram: d });
    const onCall = view.body.querySelector(`[data-msg-id="${call.id}"] .finding-mark`)!;
    expect([onCall.textContent!.slice(0, 1), onCall.getAttribute('data-finding-id')]).toEqual(['⟳', 'f1']);
    expect(onCall.querySelector('title')!.textContent).toBe('I/O in a loop: Repo.find (DB) — click for why and how to fix');
    // a class-only issue: on the box; a layer violation: never (it is the red call)
    const onBox = [...view.header.querySelectorAll(`[data-participant-id="${part.id}"] .finding-mark`)].map((e) => e.getAttribute('data-finding-id'));
    expect(onBox).toEqual(['f2']);
    expect(view.root.querySelector('[data-finding-id="v1"]')).toBeNull();
    fire(onCall, 'click');
    expect(view.body.querySelector(`[data-msg-id="${call.id}"]`)!.classList.contains('highlighted')).toBe(true);
    expect(view.root.querySelector('.guide-card')!.textContent).toContain('I/O in a loop: Repo.find (DB)');
    // a mark keeps its own title: no message card over it
    onCall.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400)); // the card's delay
    expect((view.root.querySelector('.hover-card') as HTMLElement).hidden).toBe(true);
    expect(Number(view.header.querySelector(`[data-participant-id="${part.id}"] .finding-mark`)!.getAttribute('x'))).toBe(5);
  });

  it('FR-19.21 the class diagram marks each design issue on its classes, else on the class sending its first relation; a click opens its card', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    bridge.send({
      type: 'render',
      diagram: {
        classes: [node('A'), node('B'), node('C')],
        relations: [{ id: 'r1', kind: 'dependency', from: 'A', to: 'B' }],
        findings: [
          { id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: B.find (DB)', relationIds: ['r1'] },
          { id: 'f2', kind: 'god-class', title: 'God class: C', classKeys: ['C'] },
          { id: 'f3', kind: 'io-in-domain', title: 'I/O in Domain: nowhere' },
          { id: 'v1', kind: 'layer-violation', title: 'Layer violation', classKeys: ['A', 'B'], relationIds: ['r1'] },
        ],
      },
    });
    const marks = (key: string) => [...view.canvas.querySelectorAll(`.class-node[data-class-key="${key}"] .finding-mark`)].map((e) => e.getAttribute('data-finding-id'));
    expect([marks('A'), marks('B'), marks('C')]).toEqual([['f1'], [], ['f2']]);
    expect(Number(view.canvas.querySelector('[data-finding-id="f2"]')!.getAttribute('x'))).toBe(9);
    expect(Number(view.canvas.querySelector('[data-finding-id="f1"]')!.getAttribute('x'))).toBe(9);
    fire(view.canvas.querySelector('[data-finding-id="f2"]')!, 'click');
    expect(view.root.querySelector('.guide-card')!.textContent).toContain('God class: C');
  });

  it('FR-19.8 the class legend has a ⚠ chip; picking a finding outlines its classes and relations', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    const diagram: ClassDiagram = {
      classes: [node('A'), node('B')],
      relations: [{ id: 'r1', kind: 'dependency', from: 'A', to: 'B' }, { id: 'r2', kind: 'dependency', from: 'B', to: 'A' }],
      findings: [{ id: 'c1', kind: 'dependency-cycle', title: 'Dependency cycle: A → B → A', classKeys: ['A', 'B'], relationIds: ['r1', 'r2'] }],
    };
    bridge.send({ type: 'render', diagram });
    const chip = view.root.querySelector('[data-cmd="findings"]') as HTMLElement;
    expect(chip.querySelector('.tb-badge')!.textContent).toBe('1');
    fire(chip, 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:c1"]')!, 'click');
    expect(view.canvas.querySelectorAll('.class-node.finding-hl')).toHaveLength(2);
    expect(view.canvas.querySelectorAll('.relation.finding-hl')).toHaveLength(2);
  });

  it('FR-19.8 picking a class finding moves the class diagram to it', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    bridge.send({ type: 'render', diagram: { classes: [node('A'), node('B')], relations: [], findings: [{ id: 'c1', kind: 'too-many-dependencies', title: 'Too many dependencies: B (9 injected)', classKeys: ['B'] }] } });
    // jsdom has no layout: place the viewport at 0..800 x 0..400 and class B far right / below it
    const scroll = view.root.querySelector('.class-scroll') as HTMLElement;
    Object.defineProperty(scroll, 'clientWidth', { value: 800 });
    Object.defineProperty(scroll, 'clientHeight', { value: 400 });
    scroll.getBoundingClientRect = () => new DOMRect(0, 0, 800, 400);
    const b = view.canvas.querySelector('[data-class-key="B"]')!;
    b.getBoundingClientRect = () => new DOMRect(2000, 1500, 200, 100);
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:c1"]')!, 'click');
    // centred: 2000 - (800 - 200) / 2 = 1700; 1500 - (400 - 100) / 2 = 1350
    expect([scroll.scrollLeft, scroll.scrollTop]).toEqual([1700, 1350]);
  });

  it('FR-19.8 evidence wider than the view zooms out until it fits, not below the minimum zoom', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    const findings = [
      { id: 'w', kind: 'dependency-cycle' as const, title: 'wide', classKeys: ['A', 'B'] },
      { id: 'x', kind: 'dependency-cycle' as const, title: 'very wide', classKeys: ['A', 'C'] },
    ];
    bridge.send({ type: 'render', diagram: { classes: [node('A'), node('B'), node('C')], relations: [], findings } });
    const scroll = view.root.querySelector('.class-scroll') as HTMLElement;
    let viewH = 400;
    Object.defineProperty(scroll, 'clientWidth', { value: 800 });
    Object.defineProperty(scroll, 'clientHeight', { get: () => viewH });
    scroll.getBoundingClientRect = () => new DOMRect(0, 0, 800, viewH);
    const at = (key: string, x: number) => (view.canvas.querySelector(`[data-class-key="${key}"]`)!.getBoundingClientRect = () => new DOMRect(x, 100, 100, 100));
    at('A', 0);
    at('B', 1268); // union 1368 wide: (800 - 64) / 1368 → 54%
    at('C', 4000);
    const pick = (id: string) => {
      fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
      fire(view.root.querySelector(`.popup-layer [data-menu-id="finding:${id}"]`)!, 'click');
    };
    pick('w');
    expect(view.zoom).toBe(0.54);
    view.setZoom(1);
    pick('x');
    expect(view.zoom).toBe(0.25);
    // a view shorter than the 2 × 32 px margins: the margin shrinks, the zoom does not collapse to the floor
    view.setZoom(1);
    viewH = 60;
    at('B', 300);
    pick('w');
    expect(view.zoom).toBe(0.45); // (60 - 2 × 7.5) / 100
  });

  it('FR-19.7 a sequence finding with only classes as evidence outlines and scrolls to the participant', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const p = d.participants[d.participants.length - 1];
    d.findings = [{ id: 'f2', kind: 'io-in-domain', title: `I/O in Domain: ${p.className} (DB)`, classKeys: [p.classKey] }];
    bridge.send({ type: 'render', diagram: d });
    Object.defineProperty(view.scroll, 'clientWidth', { value: 600 });
    Object.defineProperty(view.scroll, 'clientHeight', { value: 400 });
    view.scroll.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
    const box = view.header.querySelector(`[data-participant-id="${p.id}"]`)!;
    box.getBoundingClientRect = () => new DOMRect(1400, 10, 120, 50);
    fire(view.toolbar.button('findings'), 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:f2"]')!, 'click');
    expect(box.classList.contains('finding-hl')).toBe(true);
    expect(view.scroll.scrollLeft).toBe(1400 - (600 - 120) / 2);
  });

  it('FR-19.7 a cyclic collaboration shows both the objects and the messages of the cooperation (also when opened by the host)', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const m = d.messages.find((x) => x.from && x.from !== x.to)!;
    const from = d.participants.find((p) => p.id === m.from)!;
    const to = d.participants.find((p) => p.id === m.to)!;
    const finding = { id: 'c1', kind: 'cyclic-collaboration' as const, title: 'Cyclic collaboration', messageIds: [m.id], classKeys: [from.classKey, to.classKey] };
    d.findings = [finding];
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'highlight', messageId: m.id, messageIds: [m.id], finding });
    expect(view.body.querySelector(`[data-msg-id="${m.id}"]`)!.classList.contains('highlighted')).toBe(true);
    const outlined = [...view.header.querySelectorAll('.finding-hl')].map((e) => e.getAttribute('data-participant-id'));
    expect(outlined.sort()).toEqual([from.id, to.id].sort());
  });

  it('FR-19.10 picking a finding shows its card (why, consequences, how to fix, when OK); Ignore posts the pattern; a cycle has no Ignore', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const id = d.messages[2].id;
    d.findings = [
      { id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', detail: 'Runs once per iteration', messageIds: [id], ignoreKey: 'Repo.find' },
      { id: 'f2', kind: 'cyclic-collaboration', title: 'Cyclic collaboration: A → B → A', messageIds: [id] },
    ];
    bridge.send({ type: 'render', diagram: d });
    const pick = (fid: string) => {
      fire(view.toolbar.button('findings'), 'click');
      fire(view.root.querySelector(`.popup-layer [data-menu-id="finding:${fid}"]`)!, 'click');
      return view.root.querySelector('.popup-layer .guide-card') as HTMLElement;
    };
    const card = pick('f1');
    expect(card.querySelector('.gc-title')!.textContent).toBe('⚠ I/O in a loop: Repo.find (DB)');
    expect(card.querySelector('.gc-detail')!.textContent).toBe('Runs once per iteration');
    expect([...card.querySelectorAll('.gc-label')].map((l) => l.textContent)).toEqual(['Why flagged', 'Consequences', 'How to fix', "When it's OK"]);
    expect(card.querySelectorAll('.gc-fixes li').length).toBeGreaterThan(2);
    expect(view.body.querySelector(`[data-msg-id="${id}"]`)!.classList.contains('highlighted')).toBe(true); // revealed as before
    const buttons = () => [...view.root.querySelectorAll('.popup-layer .gc-btn')] as HTMLElement[];
    expect(buttons().map((b) => b.textContent)).toEqual(['Show in diagram', 'Ignore Repo.find', 'Copy as Markdown', 'Ask AI', 'Close']);
    fire(buttons()[1], 'click');
    expect(bridge.last()).toEqual({ type: 'ignoreFinding', pattern: 'Repo.find' });
    expect(view.root.querySelector('.guide-card')).toBeNull();
    pick('f2');
    expect(buttons().map((b) => b.textContent)).toEqual(['Show in diagram', 'Copy as Markdown', 'Ask AI', 'Close']);
    expect(view.root.querySelector('.guide-card')!.textContent).toContain('"disable": ["cyclic-collaboration"]');
  });

  it('FR-19.20 while a finding\'s card is open the rest is dimmed: its calls, the calls leading there and their objects stay', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const P = 'root/1:placeOrder';
    const id = `${P}/0:findById`;
    d.findings = [{ id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', messageIds: [id] }];
    bridge.send({ type: 'render', diagram: d });
    fire(view.toolbar.button('findings'), 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:f1"]')!, 'click');
    const kept = (sel: string) => view.root.querySelector(sel)!.classList.contains('evidence-keep');
    expect(view.root.classList.contains('evidence-dimmed')).toBe(true);
    expect(kept(`[data-msg-id="${id}"]`)).toBe(true);
    expect(kept(`[data-msg-id="${P}"]`)).toBe(true); // the call leading to it
    expect(kept('[data-msg-id="root"]')).toBe(true);
    expect(kept(`[data-msg-id="${P}/4:charge"]`)).toBe(false);
    expect(kept('.participant[data-participant-id="p-repo1"]')).toBe(true);
    expect(kept('.participant[data-participant-id="p-gw"]')).toBe(false);
    // a re-render (background I/O scan) keeps it
    bridge.send({ type: 'render', diagram: d });
    expect(view.root.classList.contains('evidence-dimmed')).toBe(true);
    expect(kept(`[data-msg-id="${id}"]`)).toBe(true);
    // Show in diagram keeps it; closing the card ends it
    const button = (label: string) => [...view.root.querySelectorAll<HTMLElement>('.popup-layer .gc-btn')].find((b) => b.textContent === label)!;
    fire(button('Show in diagram'), 'click');
    expect(view.root.classList.contains('evidence-dimmed')).toBe(true);
    fire(button('Close'), 'click');
    expect(view.root.classList.contains('evidence-dimmed')).toBe(false);
    expect(view.root.querySelector('.evidence-keep')).toBeNull();
  });

  it('FR-19.20 the class diagram dims what a finding is not about while its card is open (nothing to outline: nothing dimmed)', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    const findings = [
      { id: 'c1', kind: 'too-many-dependencies' as const, title: 'Too many dependencies: Svc (9 injected)', classKeys: ['Svc'] },
      { id: 'c2', kind: 'io-in-loop' as const, title: 'I/O in a loop: Repo.find (DB)' },
    ];
    bridge.send({ type: 'render', diagram: { classes: [node('Svc'), node('Other')], relations: [], findings } });
    const pick = (id: string) => {
      fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
      fire(view.root.querySelector(`.popup-layer [data-menu-id="finding:${id}"]`)!, 'click');
    };
    pick('c1');
    expect(view.root.classList.contains('evidence-dimmed')).toBe(true);
    expect(view.root.querySelector('[data-class-key="Svc"]')!.classList.contains('finding-hl')).toBe(true);
    fire([...view.root.querySelectorAll<HTMLElement>('.popup-layer .gc-btn')].find((b) => b.textContent === 'Close')!, 'click');
    expect(view.root.classList.contains('evidence-dimmed')).toBe(false);
    pick('c2');
    expect(view.root.classList.contains('evidence-dimmed')).toBe(false);
  });

  it('FR-19.10 the class legend finding shows its card too', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    bridge.send({ type: 'render', diagram: { classes: [node('Svc')], relations: [], findings: [{ id: 'c1', kind: 'too-many-dependencies', title: 'Too many dependencies: Svc (9 injected)', classKeys: ['Svc'], ignoreKey: 'Svc' }] } });
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:c1"]')!, 'click');
    const card = view.root.querySelector('.popup-layer .guide-card') as HTMLElement;
    expect(card.textContent).toContain('"maxDependencies": 8');
    fire([...card.querySelectorAll('.gc-btn')].find((b) => b.textContent === 'Ignore Svc')!, 'click');
    expect(bridge.last()).toEqual({ type: 'ignoreFinding', pattern: 'Svc' });
  });

  it('FR-19.22 Stop ignoring from the ⚠ menu of either view posts the pattern and its list', () => {
    const seqBridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const seq = startSequenceView(mount(), seqBridge, { measureText: estimateTextWidth });
    seqBridge.send({ type: 'render', diagram: { ...cloneSequence(), ignored: { findings: ['Repo.find'], layerHints: ['src/util/**'] } } });
    fire(seq.toolbar.button('findings'), 'click');
    fire(seq.root.querySelector('.popup-layer [data-menu-id="unignore:layerHints:src/util/**"]')!, 'click');
    expect(seqBridge.last()).toEqual({ type: 'unignoreLayerHint', pattern: 'src/util/**' });
    fire(seq.toolbar.button('findings'), 'click');
    fire(seq.root.querySelector('.popup-layer [data-menu-id="unignore:findings:Repo.find"]')!, 'click');
    expect(seqBridge.last()).toEqual({ type: 'unignoreFinding', pattern: 'Repo.find' });
    const clsBridge = testBridge<HostToClassView, ClassViewToHost>();
    const cls = startClassView(mount(), clsBridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    clsBridge.send({ type: 'render', diagram: { classes: [node('Svc')], relations: [], ignored: { findings: ['Svc'], layerHints: ['src/x/**'] } } });
    fire(cls.root.querySelector('[data-cmd="findings"]')!, 'click');
    fire(cls.root.querySelector('.popup-layer [data-menu-id="unignore:findings:Svc"]')!, 'click');
    expect(clsBridge.last()).toEqual({ type: 'unignoreFinding', pattern: 'Svc' });
    fire(cls.root.querySelector('[data-cmd="findings"]')!, 'click');
    fire(cls.root.querySelector('.popup-layer [data-menu-id="unignore:layerHints:src/x/**"]')!, 'click');
    expect(clsBridge.last()).toEqual({ type: 'unignoreLayerHint', pattern: 'src/x/**' });
  });

  it('FR-19.10 the card stays open while the view scrolls / re-renders (revealing the evidence scrolls right after); menus still close', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const id = d.messages[2].id;
    d.findings = [{ id: 'f1', kind: 'cyclic-collaboration', title: 'Cyclic collaboration: A → B → A', messageIds: [id] }];
    bridge.send({ type: 'render', diagram: d });
    fire(view.toolbar.button('findings'), 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:f1"]')!, 'click');
    const card = () => view.root.querySelector('.popup-layer .guide-card');
    expect(card()).not.toBeNull();
    // the browser fires the scroll event of revealElements asynchronously, after the card is open
    view.scroll.dispatchEvent(new Event('scroll'));
    expect(card()).not.toBeNull();
    // a background re-render (new I/O badges after the scan) keeps it too
    bridge.send({ type: 'render', diagram: d });
    expect(card()).not.toBeNull();
    // opened by the host (project-wide Design issues)
    fire(card()!.querySelector('.gc-actions button:last-child') ?? [...card()!.querySelectorAll('button')].find((b) => b.textContent === 'Close')!, 'click');
    bridge.send({ type: 'highlight', messageId: id, messageIds: [id], finding: d.findings[0] });
    view.scroll.dispatchEvent(new Event('scroll'));
    expect(card()).not.toBeNull();
    // a menu still closes on scroll
    fire(view.toolbar.button('view'), 'click');
    expect(view.root.querySelector('.popup-layer .menu')).not.toBeNull();
    view.scroll.dispatchEvent(new Event('scroll'));
    expect(view.root.querySelector('.popup-layer .menu')).toBeNull();
  });

  it('FR-19.10 the class view card stays open while the view scrolls; menus still close', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    bridge.send({ type: 'render', diagram: { classes: [node('A'), node('B')], relations: [], findings: [{ id: 'c1', kind: 'dependency-cycle', title: 'Dependency cycle: A → B → A', classKeys: ['A', 'B'] }] } });
    const scroll = view.root.querySelector('.class-scroll') as HTMLElement;
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:c1"]')!, 'click');
    scroll.dispatchEvent(new Event('scroll'));
    expect(view.root.querySelector('.popup-layer .guide-card')).not.toBeNull();
    fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
    expect(view.root.querySelector('.popup-layer .menu')).not.toBeNull();
    scroll.dispatchEvent(new Event('scroll'));
    expect(view.root.querySelector('.popup-layer .menu')).toBeNull();
  });

  it('FR-19.10 the card folds to its title line (▸ Why? / ▾ / ✕) and the next one opens as the reader left the last', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const id = d.messages[2].id;
    d.findings = [
      { id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', messageIds: [id] },
      { id: 'f2', kind: 'cyclic-collaboration', title: 'Cyclic collaboration: A → B → A', messageIds: [id] },
    ];
    bridge.send({ type: 'render', diagram: d });
    const pick = (fid: string) => {
      fire(view.toolbar.button('findings'), 'click');
      fire(view.root.querySelector(`.popup-layer [data-menu-id="finding:${fid}"]`)!, 'click');
      return view.root.querySelector('.popup-layer .guide-card') as HTMLElement;
    };
    // first time: unfolded, so the card is discovered
    let card = pick('f1');
    expect(card.classList.contains('folded')).toBe(false);
    expect(card.querySelector('.gc-fold')!.textContent).toBe('▾');
    fire(card.querySelector('.gc-fold')!, 'click');
    expect(card.classList.contains('folded')).toBe(true);
    expect(card.querySelector('.gc-fold')!.textContent).toBe('▸ Why?');
    expect(bridge.getState<{ findingCardFolded?: boolean }>()?.findingCardFolded).toBe(true);
    // the evidence stays highlighted while the strip shows which finding it is
    expect(view.body.querySelector(`[data-msg-id="${id}"]`)!.classList.contains('highlighted')).toBe(true);
    // the next finding opens folded; ▸ Why? (or the title) unfolds it, and that is remembered too
    card = pick('f2');
    expect(card.classList.contains('folded')).toBe(true);
    expect(card.querySelector('.gc-title')!.textContent).toBe('⚠ Cyclic collaboration: A → B → A');
    fire(card.querySelector('.gc-title')!, 'click');
    expect(card.classList.contains('folded')).toBe(false);
    expect(bridge.getState<{ findingCardFolded?: boolean }>()?.findingCardFolded).toBeUndefined();
    fire(card.querySelector('.gc-close')!, 'click');
    expect(view.root.querySelector('.popup-layer .guide-card')).toBeNull();
    // a reloaded view keeps the choice
    fire(pick('f1').querySelector('.gc-fold')!, 'click');
    const again = testBridge<HostToSequenceView, SequenceViewToHost>();
    again.setState(bridge.getState());
    const view2 = startSequenceView(mount(), again, { measureText: estimateTextWidth });
    again.send({ type: 'render', diagram: d });
    fire(view2.toolbar.button('findings'), 'click');
    fire(view2.root.querySelector('.popup-layer [data-menu-id="finding:f1"]')!, 'click');
    expect(view2.root.querySelector('.popup-layer .guide-card')!.classList.contains('folded')).toBe(true);
  });

  it('FR-19.10 the class view card folds and remembers too', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [] });
    bridge.send({ type: 'render', diagram: { classes: [node('A'), node('B')], relations: [], findings: [{ id: 'c1', kind: 'dependency-cycle', title: 'Dependency cycle: A → B → A', classKeys: ['A', 'B'] }] } });
    const pick = () => {
      fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
      fire(view.root.querySelector('.popup-layer [data-menu-id="finding:c1"]')!, 'click');
      return view.root.querySelector('.popup-layer .guide-card') as HTMLElement;
    };
    const card = pick();
    expect(card.classList.contains('folded')).toBe(false);
    fire(card.querySelector('.gc-fold')!, 'click');
    expect(pick().classList.contains('folded')).toBe(true);
    expect(bridge.getState<{ findingCardFolded?: boolean }>()?.findingCardFolded).toBe(true);
  });
});


describe('the ⚠ tooltip with issues inside folded calls', () => {
  const title = (d: SequenceDiagram) => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: d });
    return view.toolbar.button('findings').title;
  };
  it('one folded issue: "it"; shown issues too: their count first, the folded ones below', () => {
    expect(title({ ...cloneSequence(), issuesBelow: { count: 1, titles: ['x'] } })).toBe('1 inside folded calls, none in the shown calls — Expand all shows it');
    const d = cloneSequence();
    d.findings = [{ id: 'f', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', messageIds: [d.messages[1].id] }];
    expect(title({ ...d, issuesBelow: { count: 1, titles: ['x'] } })).toBe('1 design issue in the shown calls — click for the list\n+ 1 more inside folded calls — Expand all shows it');
  });
});
