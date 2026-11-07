/**
 * "How to read this" (View ▾): each mark of the sequence diagram drawn with the diagram's own classes, and
 * one plain sentence. For readers who do not know UML.
 */
import { html, svg } from '../dom';

const W = 56;
const H = 26;

type Row = { glyph: SVGElement[]; text: string };

const box = (cls = '') => svg('g', { class: `participant${cls ? ` ${cls}` : ''}` }, [svg('rect', { class: 'p-box', x: 8, y: 2, width: 40, height: 14, rx: 3, ry: 3 }), svg('line', { class: 'lifeline', x1: 28, y1: 16, x2: 28, y2: H })]);
const arrow = (cls: string, open: boolean) => [
  svg('path', { class: `msg-line${cls}`, d: `M4,${H / 2} L${W - 6},${H / 2}`, fill: 'none' }),
  svg('path', { class: `legend-head${open ? ' open' : ''}`, d: `M${W - 13},${H / 2 - 4} L${W - 5},${H / 2} L${W - 13},${H / 2 + 4}${open ? '' : ' z'}` }),
];
const text = (cls: string, t: string) => [svg('text', { class: cls, x: W / 2, y: H / 2 + 4, 'text-anchor': 'middle' }, [t])];

/** Built on use (the glyphs are DOM nodes). */
export const legendRows = (): Row[] => [
  { glyph: [box()], text: 'An object taking part. Time runs down its dashed lifeline. "gateway:Gateway" is the field or variable holding it, then its class; ":Gateway" has no name of its own.' },
  { glyph: [box('kind-interface')], text: 'Dashed box, italic name: an interface or abstract class. The real class is picked at run time ("choose impl ▾" on the call shows one).' },
  { glyph: [box('kind-external')], text: 'Faint, empty box: a library, the runtime, or "unknown" (a call whose target could not be found; its hover says why).' },
  { glyph: [svg('rect', { class: 'activation', x: 23, y: 2, width: 10, height: H - 4 })], text: 'Bar on a lifeline: the object is running a method, from the call until it returns.' },
  { glyph: arrow('', false), text: 'Solid arrow, filled head: a call. Read it as "sender calls receiver.method()".' },
  { glyph: arrow('', true), text: 'Open head: an asynchronous call (it returns a promise / task).' },
  { glyph: arrow(' dashed', true), text: 'Dashed arrow: «create» — the object is made here (new).' },
  { glyph: [svg('circle', { class: 'found-gate', cx: 8, cy: H / 2, r: 3.5 }), ...arrow('', false)], text: 'Dot at the start: the flow begins here, called from outside (an entry point, the framework, a test).' },
  { glyph: arrow(' legend-violation', false), text: 'Red arrow: breaks the layer rule (an inner layer calls an outer one). Its hover says which rule.' },
  { glyph: text('legend-sym', '⊕ ⊖'), text: 'Open / close a call to see the calls it makes. ✦ Overview opens the important ones.' },
  { glyph: text('legend-sym', 'alt loop'), text: 'Frames: alt = one of the branches runs, opt = maybe runs, loop = repeats, try = with error handling.' },
  { glyph: text('legend-sym', '↯'), text: 'Error path (throw, early return), folded into one line; ⊕ shows it.' },
  { glyph: text('legend-sym', 'DB HTTP'), text: 'I/O badge: the call (or something below it) reads or writes a database, the network, files, a queue.' },
  { glyph: text('legend-sym', '⚑'), text: 'The layer of this class is a guess from its name or folder; right-click → Why this layer?' },
];

/** The legend card; `close` removes it. */
export function legendCard(close: () => void): HTMLElement {
  const card = html('div', { class: 'guide-card legend-card', role: 'dialog', 'aria-label': 'How to read this diagram' });
  card.appendChild(html('div', { class: 'gc-title' }, ['How to read this diagram']));
  const list = html('div', { class: 'legend-rows' });
  for (const r of legendRows()) {
    list.appendChild(html('div', { class: 'legend-row' }, [svg('svg', { class: 'legend-glyph', width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' }, r.glyph), html('span', { class: 'legend-text' }, [r.text])]));
  }
  card.appendChild(list);
  const b = html('button', { type: 'button', class: 'gc-btn primary' }, ['Close']);
  b.addEventListener('click', close);
  card.appendChild(html('div', { class: 'gc-actions' }, [b]));
  return card;
}

/** the keys of the sequence view, in one place ("?" or View ▾ → Keyboard shortcuts). */
export const KEYS: [string, string][] = [
  ['Alt+← / Alt+→', 'Back / forward to the previous diagram'],
  ['↓ / ↑', 'Next / previous call (Shift: skip the calls inside)'],
  ['Enter · Space or + / −', 'The selected call: its code · expand / collapse'],
  ['→ / ←', 'From the selected call (or the one under the mouse): jump to its receiver / its sender'],
  ['Backspace', 'Back to where the last jump started'],
  ['Ctrl+F or /', 'Find a call or class (↓ goes to the matches in collapsed calls)'],
  ['Enter / Shift+Enter', 'In Find: next / previous match'],
  ['Shift+click a lifeline', 'Step through that object\'s messages'],
  ['Shift+click ⊕', 'Expand everything below the call'],
  ['N / P, Shift+N / Shift+P', 'During a review: next / previous change, next / previous flow'],
  ['↓ ↑ Enter', 'In the ⌂ filter and in menus: move, open'],
  ['Ctrl + wheel', 'Zoom'],
  ['Escape', 'Close the menu, card or find bar; else let go of the selected call'],
  ['?', 'This list'],
];

export function keysCard(close: () => void): HTMLElement {
  const card = html('div', { class: 'guide-card legend-card keys-card', role: 'dialog', 'aria-label': 'Keyboard shortcuts' });
  card.appendChild(html('div', { class: 'gc-title' }, ['Keyboard shortcuts']));
  card.appendChild(html('div', { class: 'keys-rows' }, KEYS.flatMap(([k, what]) => [html('kbd', {}, [k]), html('span', { class: 'legend-text' }, [what])])));
  const b = html('button', { type: 'button', class: 'gc-btn primary' }, ['Close']);
  b.addEventListener('click', close);
  card.appendChild(html('div', { class: 'gc-actions' }, [b]));
  return card;
}
