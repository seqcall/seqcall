// @vitest-environment jsdom
import type { ClassDiagram, ClassViewToHost } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { ClassFind } from '../src/class/find';
import { mount } from './helpers';

const diagram: ClassDiagram = {
  classes: [
    { key: 'S', name: 'Shop', kind: 'class', stereotypes: [], namespace: 'src', methods: [{ name: 'placeOrder', isStatic: false, signature: 'placeOrder()' }] },
    { key: 'O', name: 'Order', kind: 'class', stereotypes: [], namespace: 'src', methods: [{ name: 'total', isStatic: false, signature: 'total()' }] },
    { key: 'H', name: 'OrderHistory', kind: 'class', stereotypes: [], namespace: 'src', methods: [] }, // in the diagram, not drawn (yet)
  ],
  relations: [],
};

/** The drawn classes: `<g data-class-key>` with `<text data-member>` rows, like the class view's SVG. */
function drawn(keys: string[], d: ClassDiagram = diagram): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const k of keys) {
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('data-class-key', k);
    for (const m of d.classes.find((c) => c.key === k)!.methods) {
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('data-member', m.name);
      g.appendChild(t);
    }
    svg.appendChild(g);
  }
  return svg;
}

/** jsdom has no layout: the drawn class `i` sits at x = 1000·i (in a scrolled 800 px wide view). */
function place(scroll: HTMLElement, svg: SVGSVGElement): void {
  Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 800 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 600 });
  [...svg.children].forEach((g, i) => {
    g.getBoundingClientRect = () => ({ left: 1000 * i - scroll.scrollLeft, right: 1000 * i + 100 - scroll.scrollLeft, top: 100, bottom: 150, width: 100, height: 50 }) as DOMRect;
  });
}

function setup(d: ClassDiagram | null = diagram, svg: SVGSVGElement | null = drawn(['S', 'O'])) {
  const root = mount();
  const scroll = document.createElement('div');
  root.appendChild(scroll);
  if (svg) {
    scroll.appendChild(svg);
    place(scroll, svg);
  }
  const posted: ClassViewToHost[] = [];
  let current = d;
  let currentSvg = svg;
  const find = new ClassFind({ root, scroll, diagram: () => current, svg: () => currentSvg, post: (m) => void posted.push(m) });
  const cls = (sel: string) => [...(currentSvg?.querySelectorAll(sel) ?? [])].map((e) => e.getAttribute('data-member') ?? e.getAttribute('data-class-key'));
  const count = () => find.bar.element.querySelector('.find-count')!.textContent;
  const btn = (title: string) => find.bar.element.querySelector(`button[title^="${title}"]`) as HTMLButtonElement;
  return {
    find, root, posted, cls, count, btn, scroll,
    redraw(nd: ClassDiagram | null, keys: string[] | null) {
      current = nd;
      currentSvg = keys ? drawn(keys) : null;
      if (currentSvg) place(scroll, currentSvg);
      scroll.replaceChildren(...(currentSvg ? [currentSvg] : []));
      find.onDraw();
    },
  };
}

describe('FR-23.4 find in the class diagram (ClassFind)', () => {
  it('FR-23.4 ↓ / ↑ step through classes and method rows (also by Class.method), wrapping around', () => {
    const s = setup();
    s.find.open('order'); // Shop.placeOrder, Order, Order.total, OrderHistory (not drawn)
    expect(s.count()).toBe('1 of 4');
    expect(s.cls('.find-current')).toEqual(['S', 'placeOrder']);
    s.btn('Next').click();
    expect(s.cls('.find-current')).toEqual(['O']);
    s.btn('Next').click();
    expect(s.cls('.find-current')).toEqual(['O', 'total']);
    s.btn('Next').click(); // OrderHistory: counted, not drawn, nothing outlined
    expect(s.count()).toBe('4 of 4');
    expect(s.cls('.find-current')).toEqual([]);
    expect(s.cls('.find-hit')).toEqual(['S', 'placeOrder', 'O', 'total']);
    s.btn('Next').click();
    expect(s.count()).toBe('1 of 4');
    s.btn('Previous').click();
    expect(s.count()).toBe('4 of 4');
  });

  it('FR-23.4 Interface.method finds the method rows of the classes realizing or extending it', () => {
    const d: ClassDiagram = {
      classes: [
        { key: 'I', name: 'PaymentPort', kind: 'interface', stereotypes: ['interface'], namespace: 'src', methods: [] },
        { key: 'C', name: 'CardPayments', kind: 'class', stereotypes: [], namespace: 'src', methods: [{ name: 'charge', isStatic: false, signature: 'charge()' }] },
        { key: 'B', name: 'BasePayments', kind: 'abstract', stereotypes: [], namespace: 'src', methods: [] },
        { key: 'W', name: 'WirePayments', kind: 'class', stereotypes: [], namespace: 'src', methods: [{ name: 'charge', isStatic: false, signature: 'charge()' }] },
        { key: 'L', name: 'Ledger', kind: 'class', stereotypes: [], namespace: 'src', methods: [{ name: 'charge', isStatic: false, signature: 'charge()' }] },
      ],
      relations: [
        { id: 'r1', kind: 'realization', from: 'C', to: 'I' },
        { id: 'r2', kind: 'generalization', from: 'W', to: 'B' },
        { id: 'r3', kind: 'dependency', from: 'L', to: 'I' }, // uses the port, does not realize it
        { id: 'r4', kind: 'realization', from: 'L', to: 'gone' }, // its interface is not in the diagram
      ],
    };
    const s = setup(d, drawn(['I', 'C', 'B', 'W', 'L'], d));
    s.find.open('PaymentPort.charge');
    expect(s.count()).toBe('1 of 1');
    expect(s.cls('.find-current')).toEqual(['C', 'charge']);
    s.find.open('BasePayments.charge');
    expect(s.cls('.find-current')).toEqual(['W', 'charge']);
    s.find.open('PPort.charge'); // a dotted query is a substring, no word starts
    expect(s.count()).toBe('No matches');
  });

  it('FR-23.4 a redraw keeps the current match where it moved, without scrolling; a vanished one starts over and is scrolled to', () => {
    const s = setup();
    s.find.open('order');
    s.btn('Next').click();
    s.btn('Next').click(); // Order.total
    expect(s.scroll.scrollLeft).toBe(1000 - 350); // centred
    s.scroll.scrollLeft = 0;
    s.redraw({ ...diagram, classes: [diagram.classes[0], diagram.classes[1]] }, ['S', 'O']); // OrderHistory gone
    expect(s.count()).toBe('3 of 3');
    expect(s.cls('.find-current')).toEqual(['O', 'total']);
    expect(s.scroll.scrollLeft).toBe(0); // a redraw does not move the view to a match it keeps
    s.redraw({ ...diagram, classes: [diagram.classes[1]] }, ['H', 'O']); // Shop gone, Order now second
    expect(s.count()).toBe('2 of 2'); // Order.total kept
    s.redraw({ ...diagram, classes: [diagram.classes[0]] }, ['H', 'S']);
    expect(s.count()).toBe('1 of 1');
    expect(s.cls('.find-current')).toEqual(['S', 'placeOrder']);
    expect(s.scroll.scrollLeft).toBe(1000 - 350); // the new current one, at x = 1000
  });

  it('FR-23.4 a closed bar ignores redraws; closing clears the marks and the dimming', () => {
    const s = setup();
    s.find.open('total');
    (s.find.bar.element.querySelector('.find-dim-toggle') as HTMLInputElement).click();
    expect(s.root.classList.contains('find-dimmed')).toBe(true);
    s.btn('Close').click();
    expect(s.root.classList.contains('find-dimmed')).toBe(false);
    expect(s.cls('.find-hit')).toEqual([]);
    s.redraw(diagram, ['S', 'O']);
    expect(s.cls('.find-hit')).toEqual([]);
  });

  it('FR-23.4 dimming without matches does not dim; stepping without matches does nothing; Search the flow asks the host', () => {
    const s = setup();
    s.find.open('invoice');
    (s.find.bar.element.querySelector('.find-dim-toggle') as HTMLInputElement).click();
    expect(s.root.classList.contains('find-dimmed')).toBe(false);
    s.btn('Next').click();
    expect(s.count()).toBe('No matches');
    (s.find.bar.element.querySelector('.find-deeper') as HTMLElement).click();
    expect(s.posted).toEqual([{ type: 'findInFlow', query: 'invoice' }]);
  });

  it('FR-23.4 no diagram and nothing drawn yet (the panel just opened): no matches, no error', () => {
    const s = setup(null, null);
    s.find.open('order');
    expect(s.count()).toBe('No matches');
    s.redraw(diagram, null); // the diagram arrived, its SVG not yet
    expect(s.count()).toBe('1 of 4');
  });
});
