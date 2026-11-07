/**
 * FR-23 find in the sequence diagram: matches among the drawn messages (outlined, the current one
 * highlighted and scrolled into view, ticks on the right edge, optional dimming) and — searched by the
 * host — calls below the collapsed messages, listed under the query; choosing one expands only its path.
 */
import type { HostToSequenceView, Message, SearchHit, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { html } from '../dom';
import { FindBar } from '../find-bar';
import { nameMatches } from '../find-match';
import { formatLocation } from './labels';
import type { SequenceGeometry } from './layout';

type Results = Extract<HostToSequenceView, { type: 'searchResults' }>;

export interface SequenceFindHost {
  root: HTMLElement;
  body: HTMLElement;
  header: HTMLElement;
  scroll: HTMLElement;
  diagram(): SequenceDiagram | null;
  geometry(): SequenceGeometry | null;
  zoom(): number;
  post(msg: SequenceViewToHost): void;
  /** Highlights and scrolls to the current match (the view's highlight). */
  highlight(ids: string[]): void;
}

/** Wait after typing before the host searches the collapsed calls. */
const DEEP_DELAY_MS = 350;

/** Texts a message is found by: its method, `Class.method` (declared and receiving class) and the receiver's name. */
export function messageMatches(m: Message, d: SequenceDiagram, query: string): boolean {
  const to = d.participants.find((p) => p.id === m.to);
  return nameMatches(query, m.methodName, m.className ? `${m.className}.${m.methodName}` : undefined, to ? `${to.className}.${m.methodName}` : undefined, m.viaParameter);
}

/** FR-23.6 a call folded into a layer lifeline that matches the query. */
export interface FoldedMatch {
  id: string;
  name: string;
  /** The object the folded call goes to (pulled out by `setLayerOpen`). */
  participant: string;
  /** The drawn call it is folded into. */
  into: Message;
  /** The layer it is folded into (the drawn call's receiver). */
  layer: string;
}

/** FR-23.6 the calls folded into the drawn ones (layer zoom) that match the query, in diagram order. */
export function foldedMatches(d: SequenceDiagram, query: string): FoldedMatch[] {
  const out: FoldedMatch[] = [];
  for (const m of d.messages) {
    for (const c of m.folded?.calls ?? []) {
      // `Class.method` also matches by the method alone (a substring; its words are among the name's)
      if (nameMatches(query, c.name)) out.push({ id: c.id, name: c.name, participant: c.participant, into: m, layer: d.participants.find((p) => p.id === m.to)?.label ?? m.to });
    }
  }
  return out;
}

/**
 * FR-23.5 `@object`: the participants a query names — the one whose label is the text (`@repo:UserRepository`,
 * `@:Launcher`), else those whose label or class name matches it — or the interface it was drawn for (an implementation
 * chosen for `UserRepository`: the code names the interface); undefined when the query is not `@…`.
 */
export function objectsOfQuery(d: SequenceDiagram, query: string): Set<string> | undefined {
  const q = query.trim();
  if (!q.startsWith('@')) return undefined;
  const name = q.slice(1).trim();
  if (!name) return new Set();
  const exact = d.participants.filter((p) => p.label.toLowerCase() === name.toLowerCase());
  const ps = exact.length ? exact : d.participants.filter((p) => nameMatches(name.replace(/^:/, ''), p.className, p.label, p.implementsInterface?.name));
  return new Set(ps.map((p) => p.id));
}

export class SequenceFind {
  readonly bar: FindBar;
  private hits: string[] = [];
  private index = -1;
  /** FR-23.5 the participants of an `@object` query (undefined for a call query). */
  private objects: Set<string> | undefined;
  /** FR-23.5 the lifeline a Shift+click named: its query finds that one, not every lifeline with its label (two `:Order`). */
  private pinned: { id: string; query: string } | undefined;
  private deep: Results | null = null;
  /** FR-23.6 matches folded into the drawn calls (layer zoom). */
  private folded: FoldedMatch[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly ticks: HTMLElement;
  /** A revealed hit: becomes the current match when its render arrives. */
  private revealing = false;

  constructor(private readonly host: SequenceFindHost) {
    this.bar = new FindBar(
      {
        change: () => this.search(true),
        next: () => this.step(1),
        previous: () => this.step(-1),
        dim: () => this.apply(false),
        close: () => {
          clearTimeout(this.timer);
          this.hits = [];
          this.index = -1;
          this.deep = null;
          this.pinned = undefined;
          this.host.post({ type: 'cancelSearch' });
          this.apply(false);
          this.host.highlight([]);
        },
      },
      'Find a call or class · @object',
      'Find a call or class by name. @ and an object (or Shift+click a lifeline): the messages it sends and receives.',
    );
    this.ticks = html('div', { class: 'find-ticks', 'aria-hidden': 'true' });
    host.root.append(this.bar.element, this.ticks);
  }

  open(query?: string): void {
    this.bar.open(query);
  }

  /** FR-23.5 the messages a participant sends or receives, one after the other (Enter / Shift+Enter). */
  openObject(participant: { id: string; label: string }): void {
    this.pinned = { id: participant.id, query: `@${participant.label}` };
    this.bar.open(this.pinned.query);
  }

  /** After every render (also zoom, drag): the drawn matches marked again, the current one kept by id. */
  onRender(): void {
    if (!this.bar.isOpen) return;
    this.search(false, false);
  }

  /** A new diagram from the host: what is collapsed changed, so the collapsed calls are searched again. */
  onDiagram(): void {
    if (!this.bar.isOpen) return;
    this.search(false, true);
  }

  /** The host's answer for the collapsed calls (ignored when the query changed since). */
  onResults(msg: Results): void {
    if (!this.bar.isOpen || msg.query !== this.bar.query.trim()) return;
    this.deep = msg;
    this.bar.setCount(this.index, this.hits.length, this.emptyText());
    this.renderDeep();
  }

  /** The host highlighted a message (a revealed hit): it becomes the current match. */
  onHighlight(messageId: string | null): boolean {
    if (!this.revealing || !messageId) return false;
    this.revealing = false;
    const i = this.hits.indexOf(messageId);
    if (i >= 0) {
      this.index = i;
      this.apply(true);
      return true;
    }
    return false;
  }

  private search(queryChanged: boolean, deep = true): void {
    const d = this.host.diagram();
    const q = this.bar.query.trim();
    const current = this.hits[this.index];
    const pin = this.pinned;
    this.objects = d ? (pin?.query === q && d.participants.some((p) => p.id === pin.id) ? new Set([pin.id]) : objectsOfQuery(d, q)) : undefined;
    const objects = this.objects;
    const matches = (m: Message) => (objects ? (m.from !== null && objects.has(m.from)) || objects.has(m.to) : messageMatches(m, d!, q));
    this.hits = d && q ? d.messages.filter(matches).map((m) => m.id) : [];
    // FR-23.6 zoomed to layers: the calls folded into the drawn ones (not drawn, but known)
    this.folded = d && q && !objects ? foldedMatches(d, q) : [];
    const kept = current ? this.hits.indexOf(current) : -1;
    this.index = kept >= 0 ? kept : this.hits.length ? 0 : -1;
    this.apply(queryChanged || kept < 0);
    if (!deep) return;
    // FR-23.5 a drawn object's messages are the drawn ones; one not drawn is searched for below the collapsed calls
    if (objects?.size) {
      clearTimeout(this.timer);
      this.deep = null;
      return this.bar.setExtra(null);
    }
    // the collapsed calls: searched by the host after a pause (a new diagram changes what is collapsed)
    clearTimeout(this.timer);
    if (queryChanged) this.deep = null;
    this.renderDeep();
    if (q.length < 2 || !d) return;
    this.timer = setTimeout(() => {
      this.deep = { type: 'searchResults', query: q, state: 'running', methods: 0 };
      this.renderDeep();
      this.host.post({ type: 'searchCollapsed', query: q });
    }, queryChanged ? DEEP_DELAY_MS : 0);
  }

  private step(delta: number): void {
    if (!this.hits.length) return;
    this.index = this.bar.step(this.index, delta, this.hits.length);
    this.apply(true);
  }

  /** Marks the matches (and dims the rest); `scroll` = highlight the current match and scroll to it. */
  private apply(scroll: boolean): void {
    const { body, header, root } = this.host;
    const hits = new Set(this.hits);
    for (const el of body.querySelectorAll('.find-hit')) el.classList.remove('find-hit');
    for (const el of header.querySelectorAll('.find-hit')) el.classList.remove('find-hit');
    const d = this.host.diagram();
    const receivers = new Set<string>();
    for (const el of body.querySelectorAll('[data-msg-id]')) {
      const id = el.getAttribute('data-msg-id')!;
      if (!hits.has(id)) continue;
      el.classList.add('find-hit');
      const m = d?.messages.find((x) => x.id === id);
      if (m) receivers.add(m.to);
    }
    const marked = this.objects ?? receivers;
    for (const el of header.querySelectorAll('[data-participant-id]')) if (marked.has(el.getAttribute('data-participant-id')!)) el.classList.add('find-hit');
    root.classList.toggle('find-dimmed', this.bar.dimmed && hits.size > 0);
    this.bar.setCount(this.index, this.hits.length, this.emptyText());
    this.renderTicks();
    if (scroll && this.index >= 0) this.host.highlight([this.hits[this.index]]);
  }

  /** FR-23.1 one tick per match on the right edge of the scroll area (where in a long flow they are). */
  private renderTicks(): void {
    const g = this.host.geometry();
    const s = this.host.scroll;
    this.ticks.replaceChildren();
    this.ticks.hidden = !this.bar.isOpen || !this.hits.length || !g;
    if (this.ticks.hidden || !g) return;
    const r = s.getBoundingClientRect();
    const head = g.headerHeight * this.host.zoom();
    this.ticks.style.top = `${Math.round(r.top + head)}px`;
    this.ticks.style.height = `${Math.max(0, Math.round(r.height - head))}px`;
    const total = Math.max(1, g.bodyHeight);
    this.hits.forEach((id, i) => {
      const mg = g.messages.find((m) => m.id === id);
      if (!mg) return;
      const t = html('div', { class: `find-tick${i === this.index ? ' current' : ''}` });
      t.style.top = `${(100 * (mg.box.y + mg.box.height / 2)) / total}%`;
      this.ticks.appendChild(t);
    });
  }

  /** What the count says when nothing drawn matches: matches may be folded into layers or below collapsed calls. */
  private emptyText(): string {
    if (this.folded.length) return `None drawn · ${this.folded.length} folded`;
    // FR-23.5 an object not drawn: "No matches" would read as "not in this flow" while the collapsed calls were not searched yet
    if (this.objects && (!this.deep || this.deep.state === 'running')) return 'Not drawn';
    return this.deep?.hits?.length ? 'None drawn' : 'No matches';
  }

  /** FR-23.2 the collapsed calls' matches under the query row; FR-23.6 the calls folded into layers first. */
  private renderDeep(): void {
    const r = this.deep;
    const q = this.bar.query.trim();
    if (!this.bar.isOpen || !q || q.length < 2) return this.bar.setExtra(null);
    const box = html('div', { class: 'find-deep' });
    if (this.folded.length) {
      box.appendChild(html('div', { class: 'find-deep-status' }, [`Folded into layers (${this.folded.length})`]));
      const list = html('div', { class: 'find-deep-list find-folded-list', role: 'listbox' });
      for (const f of this.folded) list.appendChild(this.foldedRow(f));
      box.appendChild(list);
    }
    const extra = (el: HTMLElement | null) => this.bar.setExtra(el ?? (this.folded.length ? box : null));
    if (!r || r.state === 'running') {
      if (r) box.appendChild(html('div', { class: 'find-deep-status' }, [`Searching the collapsed calls… ${r.methods ?? 0} methods`]));
      return extra(r ? box : null);
    }
    if (r.state === 'error') {
      box.appendChild(html('div', { class: 'find-deep-status error' }, [r.error ?? 'The search failed.']));
      return this.bar.setExtra(box);
    }
    if (r.state === 'cancelled') return extra(null);
    const hits = r.hits ?? [];
    const head = html('div', { class: 'find-deep-status' }, [hits.length ? `In collapsed calls (${hits.length}${r.truncated ? '+' : ''})` : `${this.hits.length ? 'No more in the collapsed calls' : 'Not in the collapsed calls either'}${r.truncated ? ' (searched ' + (r.methods ?? 0) + ' methods)' : ''}`]);
    if (r.truncated && !r.deeper) {
      const deeper = html('button', { type: 'button', class: 'find-deeper', title: 'Search more levels and methods below the collapsed calls' }, ['Search deeper']);
      deeper.addEventListener('click', () => {
        this.deep = { type: 'searchResults', query: q, state: 'running', methods: 0 };
        this.renderDeep();
        this.host.post({ type: 'searchCollapsed', query: q, deeper: true });
      });
      head.appendChild(deeper);
    }
    box.appendChild(head);
    if (hits.length) {
      const list = html('div', { class: 'find-deep-list', role: 'listbox' });
      for (const h of hits) list.appendChild(this.hitRow(h));
      box.appendChild(list);
    }
    this.bar.setExtra(box);
  }

  /** FR-23.6 a call folded into a layer: hovering marks the drawn call it is in, a click pulls its object out. */
  private foldedRow(f: FoldedMatch): HTMLElement {
    const row = html('button', { type: 'button', class: 'find-deep-item find-folded-item', role: 'option', 'data-folded-into': f.into.id, title: `${f.name}\nfolded into ${f.into.methodName} (+${f.into.folded!.count}) in ${f.layer}\nClick: pull its object out of the layer, so the call is drawn` }, [
      html('span', { class: 'find-deep-name' }, [f.name]),
      html('span', { class: 'find-deep-via' }, [`in ${f.into.methodName} · ${f.layer}`]),
    ]);
    const mark = (on: boolean) => {
      for (const el of this.host.body.querySelectorAll('[data-msg-id]')) if (el.getAttribute('data-msg-id') === f.into.id) el.classList.toggle('find-hit', on || this.hits.includes(f.into.id));
      for (const el of this.host.header.querySelectorAll('[data-participant-id]')) if (el.getAttribute('data-participant-id') === f.into.to) el.classList.toggle('find-hit', on);
    };
    row.addEventListener('mouseenter', () => mark(true));
    row.addEventListener('mouseleave', () => mark(false));
    row.addEventListener('click', () => {
      this.revealing = true;
      this.host.post({ type: 'setLayerOpen', layer: f.participant, open: true });
    });
    return row;
  }

  private hitRow(h: SearchHit): HTMLElement {
    const l = h.labels;
    const via = l.length <= 2 ? l.join(' → ') : `${l[0]} → … → ${l[l.length - 1]}`;
    const row = html('button', { type: 'button', class: 'find-deep-item', role: 'option', title: `${[...l, h.hit.label].join(' → ')}\n${h.hit.range.file}:${h.hit.range.start.line + 1}\nClick: expand the calls down to it` }, [
      html('span', { class: 'find-deep-name' }, [h.hit.label]),
      html('span', { class: 'find-deep-via' }, [`in ${via}`]),
      html('span', { class: 'find-deep-loc' }, [formatLocation(h.hit.range)]),
    ]);
    row.addEventListener('click', () => {
      this.revealing = true;
      this.host.post({ type: 'revealSearchHit', hit: h });
    });
    return row;
  }
}
