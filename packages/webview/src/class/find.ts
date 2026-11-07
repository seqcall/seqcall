/**
 * FR-23.4 find in the class diagram: classes and method rows by name; matches outlined, the current one
 * scrolled into view, the rest optionally dimmed. Nothing drawn matches → *Search the flow* (the sequence
 * diagram, its collapsed calls too).
 */
import type { ClassDiagram, ClassViewToHost } from '@seqcall/protocol';
import { html, revealElements } from '../dom';
import { FindBar } from '../find-bar';
import { nameMatches } from '../find-match';

export interface ClassFindHost {
  root: HTMLElement;
  scroll: HTMLElement;
  diagram(): ClassDiagram | null;
  svg(): SVGSVGElement | null;
  post(msg: ClassViewToHost): void;
}

/** A class, or one of its method rows. */
interface Match {
  key: string;
  member?: string;
}

export class ClassFind {
  readonly bar: FindBar;
  private hits: Match[] = [];
  private index = -1;

  constructor(private readonly host: ClassFindHost) {
    this.bar = new FindBar(
      {
        change: () => this.search(true),
        next: () => this.step(1),
        previous: () => this.step(-1),
        dim: () => this.apply(false),
        close: () => {
          this.hits = [];
          this.index = -1;
          this.apply(false);
        },
      },
      'Find a class or method…',
    );
    host.root.appendChild(this.bar.element);
  }

  open(query?: string): void {
    this.bar.open(query);
  }

  /** After every draw (new diagram, layout, zoom): marks again, the current match kept. */
  onDraw(): void {
    if (this.bar.isOpen) this.search(false);
  }

  private search(queryChanged: boolean): void {
    const d = this.host.diagram();
    const q = this.bar.query.trim();
    const current = this.hits[this.index];
    this.hits = [];
    for (const c of d?.classes ?? []) {
      if (nameMatches(q, c.name)) this.hits.push({ key: c.key });
      // the code calls through the interface: `UserRepository.findById` finds the implementation's row (an interface's
      // box lists no methods)
      const supers = supertypeNames(d!, c.key);
      for (const m of c.methods) {
        if (nameMatches(q, m.name, `${c.name}.${m.name}`, ...supers.map((s) => `${s}.${m.name}`))) this.hits.push({ key: c.key, member: m.name });
      }
    }
    const kept = current ? this.hits.findIndex((h) => h.key === current.key && h.member === current.member) : -1;
    this.index = kept >= 0 ? kept : this.hits.length ? 0 : -1;
    this.apply(queryChanged || kept < 0);
  }

  private step(delta: number): void {
    if (!this.hits.length) return;
    this.index = this.bar.step(this.index, delta, this.hits.length);
    this.apply(true);
  }

  private apply(scroll: boolean): void {
    const svg = this.host.svg();
    const q = this.bar.query.trim();
    this.bar.setCount(this.index, this.hits.length);
    this.host.root.classList.toggle('find-dimmed', this.bar.dimmed && this.hits.length > 0);
    // FR-23.4 nothing drawn matches: the flow may still have it below a collapsed call
    if (this.bar.isOpen && q.length >= 2 && !this.hits.length) {
      const b = html('button', { type: 'button', class: 'find-deeper', title: 'Find it in the sequence diagram, also below the collapsed calls' }, ['Search the flow']);
      b.addEventListener('click', () => this.host.post({ type: 'findInFlow', query: q }));
      this.bar.setExtra(html('div', { class: 'find-deep' }, [html('div', { class: 'find-deep-status' }, ['Not among the drawn classes. ', b])]));
    } else this.bar.setExtra(null);
    if (!svg) return;
    for (const el of svg.querySelectorAll('.find-hit, .find-current')) el.classList.remove('find-hit', 'find-current');
    let current: Element | undefined;
    this.hits.forEach((h, i) => {
      const node = [...svg.querySelectorAll('[data-class-key]')].find((el) => el.getAttribute('data-class-key') === h.key);
      if (!node) return;
      const row = h.member ? [...node.querySelectorAll('[data-member]')].find((el) => el.getAttribute('data-member') === h.member) : undefined;
      node.classList.add('find-hit');
      row?.classList.add('find-hit');
      if (i === this.index) {
        (row ?? node).classList.add('find-current');
        node.classList.add('find-current');
        current = node;
      }
    });
    if (scroll && current) revealElements(this.host.scroll, [current]);
  }
}

/** The interfaces a class realizes and the classes it extends, as drawn. */
function supertypeNames(d: ClassDiagram, key: string): string[] {
  return d.relations
    .filter((r) => r.from === key && (r.kind === 'realization' || r.kind === 'generalization'))
    .flatMap((r) => d.classes.find((c) => c.key === r.to)?.name ?? []);
}
