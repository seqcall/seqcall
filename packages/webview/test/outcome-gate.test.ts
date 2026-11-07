// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EntryPoint, FlowOutcome, HostToSequenceView, SequenceViewToHost, SourceRange } from '@seqcall/protocol';
import { messageCard, startSequenceView } from '../src/sequence/view';
import { entryKey, matchesFilter, methodQuery } from '../src/sequence/entry-points';
import { layoutSequence } from '../src/sequence/layout';
import { outcomeText } from '../src/side-effects';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

const at = (line: number): SourceRange => ({ file: '/p/src/order-repository.ts', start: { line, character: 0 }, end: { line, character: 9 } });
const route = (): EntryPoint => ({ kind: 'http', label: 'POST /orders', verb: 'POST', method: cloneSequence().root });
const outcome: FlowOutcome = {
  io: [
    { kind: 'db', via: [{ className: 'OrderRepository', classKey: 'src/order-repository.ts#OrderRepository', calls: [1, 2, 3, 4, 5].map((l) => ({ call: 'Db.query', at: at(l) })) }] },
    { kind: 'http', via: [{ className: 'InvoiceClient', calls: [{ call: 'fetch' }] }] },
  ],
  atLeast: true,
  why: '3 calls left folded',
  unresolved: 2,
};
const diagram = (o?: FlowOutcome, entry = true) => {
  const d = cloneSequence();
  if (entry) d.entryPoints = [route()];
  if (o) d.outcome = o;
  return d;
};

describe('FR-32.2 the outcome of an entry point at the gate', () => {
  it('its I/O kinds on the found message after the name, "+" when "at least", "no I/O" when none was found', () => {
    expect(outcomeText(outcome)).toBe('⇢ DB · HTTP+');
    expect(outcomeText({ io: [] })).toBe('⇢ no I/O');
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: diagram(outcome) });
    const found = view.body.querySelector('[data-msg-id="root"]')!;
    const text = found.querySelector('.seg-outcome')!;
    expect([text.textContent, text.classList.contains('at-least')]).toEqual(['⇢ DB · HTTP+', true]);
    const x = (sel: string) => Number(found.querySelector(sel)!.getAttribute('x'));
    expect(x('.seg-outcome')).toBeGreaterThan(x('.seg-name'));
    // only on the found message
    expect(view.body.querySelectorAll('.seg-outcome')).toHaveLength(1);
    bridge.send({ type: 'render', diagram: diagram({ io: [] }) });
    expect(view.body.querySelector('.seg-outcome')!.classList.contains('at-least')).toBe(false);
  });

  it('the label makes room for it (past the gate room it crosses the first lifeline, as other labels); none before the scan, nor without an entry point', () => {
    const width = (d: ReturnType<typeof diagram>) => layoutSequence(d).messages.find((m) => m.message.kind === 'found')!.label.width;
    expect(width(diagram(outcome))).toBeGreaterThan(width(diagram()) + estimateTextWidth('⇢ DB · HTTP+', 'args'));
    const kinds = (d: ReturnType<typeof diagram>) => layoutSequence(d).messages.find((m) => m.message.kind === 'found')!.label.segments.map((s) => s.kind);
    expect(kinds(diagram())).not.toContain('outcome');
    expect(kinds(diagram(outcome, false))).not.toContain('outcome');
  });

  it('its hover card: per kind the classes, their calls (3, the rest counted), why "at least", the calls not resolved', () => {
    const d = diagram(outcome);
    const texts = messageCard(d.messages[0], document, d).map((n) => n.textContent);
    expect(texts.slice(texts.indexOf('What the whole flow touches (I/O)'))).toEqual([
      'What the whole flow touches (I/O)',
      'DB · OrderRepository',
      'Db.query  order-repository.ts:2',
      'Db.query  order-repository.ts:3',
      'Db.query  order-repository.ts:4',
      '+2 more',
      'HTTP · InvoiceClient',
      'fetch',
      'At least — there may be more: 3 calls left folded',
      '2 calls not resolved: what they do is not known',
    ]);
    const none = diagram({ io: [], unresolved: 1 });
    const lines = messageCard(none.messages[0], document, none).map((n) => n.textContent);
    expect(lines.slice(lines.indexOf('What the whole flow touches (I/O)'))).toEqual(['What the whole flow touches (I/O)', 'no I/O found', '1 call not resolved: what they do is not known']);
    const clean = diagram({ io: [] });
    const rows = messageCard(clean.messages[0], document, clean).map((n) => n.textContent);
    expect(rows.slice(rows.indexOf('What the whole flow touches (I/O)'))).toEqual(['What the whole flow touches (I/O)', 'no I/O found']);
  });

  it('a call with its place opens it (FR-2); one known by name only is no link', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = diagram(outcome);
    bridge.send({ type: 'render', diagram: d });
    const card = view.hoverCard.element;
    card.append(...messageCard(d.messages[0], document, d));
    const calls = [...card.querySelectorAll<HTMLElement>('.hc-outcome-call')];
    expect(calls.map((c) => !!c.dataset.nav)).toEqual([true, true, true, false, false]);
    calls[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(bridge.last()).toEqual({ type: 'navigate', range: at(1) });
    expect(card.hidden).toBe(true);
  });
});

describe('FR-32.4 the outcomes in the ⌂ list', () => {
  const other: EntryPoint = { kind: 'http', label: 'GET /orders', verb: 'GET', method: { ...cloneSequence().root, key: 'src/c.ts#C.list', name: 'list' } };
  const job: EntryPoint = { kind: 'job', label: 'Sync.run', method: { ...cloneSequence().root, key: 'src/s.ts#Sync.run', name: 'run' } };

  it('`has:` a kind (its name or tag) or `has:io` matches a known outcome only; the methods are searched without the `has:` words', () => {
    const outcomes = { [entryKey(route())]: { kinds: ['queue' as const], atLeast: true as const } };
    expect(['has:mq', 'HAS:queue', 'has:io', 'orders has:mq', 'has:db', 'list has:mq'].map((f) => matchesFilter(route(), f, outcomes))).toEqual([true, true, true, true, false, false]);
    expect([matchesFilter(other, 'has:io', outcomes), matchesFilter(route(), 'has:io')]).toEqual([false, false]);
    expect([methodQuery('audit  has:db pers HAS:io'), methodQuery('has:http')]).toEqual(['audit pers', '']);
  });

  it('a pill per row once known — from an entry point opened (its gate) and from the project scan, which adds to it; `has:` filters the rows; the method search leaves out `has:`', () => {
    vi.useFakeTimers();
    try {
      const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
      const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
      bridge.send({ type: 'render', diagram: diagram(outcome) });
      bridge.send({ type: 'entryPoints', entryPoints: [route(), other, job], project: 'shop', show: true });
      const pills = () => [...view.root.querySelectorAll<HTMLElement>('.ep-item')].map((r) => r.querySelector('.ep-io')?.textContent ?? '-');
      expect(pills()).toEqual(['-', 'DB·HTTP+', '-']); // GET before POST
      // a diagram without entry points names no row
      const plain = diagram(outcome, false);
      bridge.send({ type: 'render', diagram: plain });
      bridge.send({ type: 'entryPoints', entryPoints: [route(), other, job], project: 'shop', show: true });
      expect(pills()).toEqual(['-', 'DB·HTTP+', '-']);
      expect(view.root.querySelector<HTMLElement>('.ep-io')!.title).toBe('I/O of its whole flow: DB, HTTP (at least: there may be more)');
      // the project scan: its outcomes join those of the flows opened; one without I/O has no pill
      bridge.send({ type: 'projectFindings', state: 'done', findings: [], outcomes: { [entryKey(other)]: { kinds: ['file'] }, [entryKey(job)]: { kinds: [] } } });
      bridge.send({ type: 'entryPoints', entryPoints: [route(), other, job], project: 'shop', show: true });
      expect(pills()).toEqual(['FILE', 'DB·HTTP+', '-']);
      const search = view.root.querySelector('.ep-search') as HTMLInputElement;
      search.value = 'has:file orders';
      fire(search, 'input');
      expect(pills()).toEqual(['FILE']);
      vi.advanceTimersByTime(400);
      expect(bridge.posted.filter((x) => x.type === 'searchMethods')).toEqual([{ type: 'searchMethods', query: 'orders' }]);
      // the host's answer is for the words without `has:`: shown
      bridge.send({ type: 'methodResults', query: 'orders', methods: [{ ...other.method }], more: 0 });
      expect(view.root.querySelectorAll('.ep-method-row')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
