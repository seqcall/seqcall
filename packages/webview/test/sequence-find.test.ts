// @vitest-environment jsdom
import type { HostToSequenceView, SearchHit, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequenceFind, foldedMatches, messageMatches, objectsOfQuery } from '../src/sequence/find';
import { layoutSequence, type SequenceGeometry } from '../src/sequence/layout';
import { renderBody, renderHeader } from '../src/sequence/render';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, range } from '../dev/mock-data';
import { mount } from './helpers';

type Results = Extract<HostToSequenceView, { type: 'searchResults' }>;
const P = 'root/1:placeOrder';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** SequenceFind on a drawn mock diagram, the host recorded. */
function setup(d: SequenceDiagram | null = cloneSequence(), geometryOf: SequenceDiagram | null = d) {
  const root = mount();
  const g: SequenceGeometry | null = geometryOf ? layoutSequence(geometryOf, {}, {}, estimateTextWidth) : null;
  const header = document.createElement('div');
  const body = document.createElement('div');
  const scroll = document.createElement('div');
  if (g) {
    header.appendChild(renderHeader(g));
    body.appendChild(renderBody(g));
  }
  root.append(header, scroll, body);
  const posted: SequenceViewToHost[] = [];
  const highlighted: string[][] = [];
  const find = new SequenceFind({ root, body, header, scroll, diagram: () => d, geometry: () => g, zoom: () => 1, post: (m) => void posted.push(m), highlight: (ids) => void highlighted.push(ids) });
  const extra = () => find.bar.element.querySelector('.find-extra')!.textContent;
  const count = () => find.bar.element.querySelector('.find-count')!.textContent;
  const results = (r: Omit<Results, 'type' | 'query'>, query = find.bar.query.trim()) => find.onResults({ type: 'searchResults', query, ...r });
  return { find, root, posted, highlighted, extra, count, results, ticks: () => root.querySelectorAll('.find-tick').length };
}

const hit = (labels: string[]): SearchHit => ({ anchorId: P, steps: [], labels, hit: { label: 'Mailer.send', range: range('mail/mailer.ts', 9) } });

describe('FR-23 find in the sequence diagram: what matches', () => {
  it('FR-23.1 a plain function (no class) and a call to an object not in the diagram are found by name', () => {
    const d = cloneSequence();
    const m = { ...d.messages.find((x) => x.id === P)!, className: undefined, to: 'p-gone' };
    expect(messageMatches(m, d, 'placeOrder')).toBe(true);
    expect(messageMatches(m, d, 'OrderService.placeOrder')).toBe(false);
    expect(messageMatches(m, d, 'undefined')).toBe(false); // no made-up class name
  });

  it('FR-23.6 a folded function call (no class) matches by its name; a layer missing from the diagram is named by its id', () => {
    const d = cloneSequence();
    const m = d.messages.find((x) => x.id === P)!;
    m.folded = { count: 1, names: ['formatDate'], expandable: 0, calls: [{ id: `${P}/9:formatDate`, name: 'formatDate', participant: 'p-util' }] };
    m.to = 'layer:Gone';
    expect(foldedMatches(d, 'formatdate').map((f) => [f.name, f.layer])).toEqual([['formatDate', 'layer:Gone']]);
    m.folded.calls!.push({ id: `${P}/9:send`, name: 'Mailer.send', participant: 'p-mail' });
    expect(foldedMatches(d, 'mailer.send').map((f) => f.name)).toEqual(['Mailer.send']); // by Class.method
    expect(foldedMatches(d, 'send').map((f) => f.name)).toEqual(['Mailer.send']); // by the method
  });

  it('FR-23.5 @Interface names the implementation drawn for it (the code names the interface)', () => {
    const d = cloneSequence();
    const repo = d.participants.find((p) => p.id === 'p-repo1')!;
    repo.implementsInterface = { key: 'src/domain/customer-store.ts#CustomerStore', name: 'CustomerStore' };
    expect(objectsOfQuery(d, '@CustomerStore')).toEqual(new Set(['p-repo1']));
    expect(objectsOfQuery(d, '@:CustomerStore')).toEqual(new Set(['p-repo1']));
    expect(objectsOfQuery(d, '@CStore')).toEqual(new Set(['p-repo1'])); // word starts, as for class names
    expect(objectsOfQuery(d, '@primary:CustomerRepository')).toEqual(new Set(['p-repo1'])); // its label still wins
  });

  it('FR-23.5 "@" alone names no object', () => {
    expect(objectsOfQuery(cloneSequence(), '@ ')).toEqual(new Set());
  });
});

describe('FR-23 SequenceFind (the bar on a drawn diagram)', () => {
  it('FR-23.1 no diagram yet: no matches, no search below', () => {
    const s = setup(null, null);
    s.find.open('placeOrder');
    vi.runAllTimers();
    expect(s.count()).toBe('No matches');
    expect(s.posted).toEqual([]);
    s.find.bar.element.querySelector<HTMLElement>('button[title^="Next"]')!.click(); // nothing to step to
    expect(s.highlighted).toEqual([]);
    s.find.open('@OrderService'); // an object query before the diagram
    expect(s.count()).toBe('No matches');
  });

  it('FR-23.3 a highlight the find did not ask for, or of a message that is not a match, is not taken', () => {
    const s = setup();
    s.find.open('findById');
    expect(s.find.onHighlight(`${P}/0:findById`)).toBe(false); // nothing revealed yet
    s.results({ state: 'done', hits: [hit(['A.a'])] });
    (s.root.querySelector('.find-deep-item') as HTMLElement).click(); // reveal a hit below a collapsed call
    expect(s.posted.at(-1)).toMatchObject({ type: 'revealSearchHit' });
    expect(s.find.onHighlight(`${P}/2:total`)).toBe(false); // the host highlighted a message that is no match
  });

  it('FR-23.1 ticks only for matches the drawing has (the layout one render behind)', () => {
    const d = cloneSequence();
    const older = cloneSequence();
    older.messages = older.messages.filter((m) => !m.id.endsWith('1:findById'));
    const s = setup(d, older);
    s.find.open('findById');
    expect(s.count()).toBe('1 of 2');
    expect(s.ticks()).toBe(1);
  });

  it('FR-23.2 the search below collapsed calls: running without a count, then an error with or without a message', () => {
    const s = setup();
    s.find.open('send');
    s.results({ state: 'running' });
    expect(s.extra()).toBe('Searching the collapsed calls… 0 methods');
    s.results({ state: 'error' });
    expect(s.extra()).toBe('The search failed.');
    s.results({ state: 'error', error: 'sidecar gone' });
    expect(s.extra()).toBe('sidecar gone');
  });

  it('FR-23.2 cancelled: nothing below the query; done without hits: "not in the collapsed calls either"', () => {
    const s = setup();
    s.find.open('send');
    s.results({ state: 'cancelled' });
    expect(s.extra()).toBe('');
    s.results({ state: 'done' });
    expect(s.extra()).toBe('Not in the collapsed calls either');
    s.results({ state: 'done', truncated: true });
    expect(s.extra()).toBe('Not in the collapsed calls either (searched 0 methods)Search deeper');
    s.results({ state: 'done', truncated: true, deeper: true, methods: 80, hits: [] });
    expect(s.extra()).toBe('Not in the collapsed calls either (searched 80 methods)');
  });

  it('drawn matches and none in the collapsed calls: "no more", not "either"', () => {
    const s = setup();
    s.find.open('placeOrder');
    expect(s.count()).toMatch(/^1 of /);
    s.results({ state: 'done' });
    expect(s.extra()).toBe('No more in the collapsed calls');
  });

  it('FR-23.2 hits: a long path is shortened to its ends', () => {
    const s = setup();
    s.find.open('send');
    s.results({ state: 'done', hits: [hit(['A.a', 'B.b', 'C.c']), hit(['A.a', 'B.b'])], truncated: true, deeper: true });
    const via = [...s.root.querySelectorAll('.find-deep-via')].map((e) => e.textContent);
    expect(via).toEqual(['in A.a → … → C.c', 'in A.a → B.b']);
    expect(s.root.querySelector('.find-deep-status')!.textContent).toBe('In collapsed calls (2+)');
  });
});
