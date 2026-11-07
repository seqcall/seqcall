/**
 * FR-24.9 / FR-24.10 the review bar under the toolbar while a review is on: the flow of the tour (⏮ ⏭) and the
 * change in this diagram (◀ ▶), so a reviewer walks through every change without going back to the panel.
 */
import type { Message } from '@seqcall/protocol';
import { html } from '../dom';
import { changeWeight, stopText, type AlsoFrom, type TourFlow } from './review-tour';

export interface ReviewBarState {
  /** FR-24.9 the current stop's changes are folded into a layer (zoomed): the layer's name. */
  foldedIn?: string;
  /** FR-24.12 the open diagram is an entry point the current flow covers (not the flow's own root). */
  also?: AlsoFrom;
  branch: string;
  base: string;
  flows: TourFlow[];
  /** -1: the diagram is not one of the tour's flows (opened otherwise). */
  flowIndex: number;
  stops: Message[];
  /** Index into `stops`, -1 = none chosen yet. */
  current: number;
  /** ▶ at the last change: the next press opens the next flow. */
  atEnd: boolean;
  /** FR-24.15 the flow's changes (the diagram's `reviewTotal`): the same at every level; absent = the stops' weights. */
  total?: number;
  /** FR-24.15 numbered tour: the change shown (null: none yet) and its line; the count is `Change n/total`. */
  position?: number | null;
  text?: string;
}

/** FR-24.15 "Change 3/16", or "Changes 3–7/16" for a stop standing for several (below, folded, another implementation). */
export function changeCount(s: Pick<ReviewBarState, 'stops' | 'current' | 'total' | 'position'>): string {
  const total = s.total ?? s.stops.reduce((n, m) => n + changeWeight(m), 0);
  // FR-24.15 numbered: one change at a time
  if (s.position !== undefined) return `Change ${s.position ?? '–'}/${total}`;
  const stop = s.stops[s.current];
  if (!stop) return `Change –/${total}`;
  const first = s.stops.slice(0, s.current).reduce((n, m) => n + changeWeight(m), 0) + 1;
  const last = first + changeWeight(stop) - 1;
  return last > first ? `Changes ${first}–${last}/${total}` : `Change ${first}/${total}`;
}

export interface ReviewBarActions {
  prevFlow(): void;
  nextFlow(): void;
  prevChange(): void;
  nextChange(): void;
  openPanel(): void;
  /** FR-24.12 the flow label opens the list of all flows (at the label's position). */
  chooseFlow(anchor: HTMLElement): void;
}

/** The entry points a flow stands for: itself and the ones it covers (shown only for a flow that covers others). */
export const coversText = (flow: TourFlow): string => `covers ${flow.alsoFrom.length + 1} entry points`;
const alsoLine = (flow: TourFlow): string[] => (flow.alsoFrom.length ? [`Also reached from (same changes): ${flow.alsoFrom.map((a) => a.label).join(', ')}`] : []);

export function reviewBar(s: ReviewBarState, a: ReviewBarActions): HTMLElement {
  const btn = (text: string, title: string, run: () => void, disabled = false, cls = '') => {
    const b = html('button', { type: 'button', class: `rb-btn ${cls}`.trim(), title, 'aria-label': title }, [text]) as HTMLButtonElement;
    b.disabled = disabled;
    b.addEventListener('click', run);
    return b;
  };
  const flow = s.flows[s.flowIndex];
  const flowTitle = flow
    ? [s.also ? `${s.also.label} — reaches the changes of flow ${s.flowIndex + 1} (${flow.label})` : flow.label, `Shows: ${(s.also ?? flow).methods.join(', ')}`, ...alsoLine(flow)].join('\n')
    : 'This diagram is not one of the review’s flows — ⏭ opens the first';
  const stop = s.stops[s.current];
  const changeText = !s.stops.length
    ? 'no changed calls in this flow'
    : s.atEnd
      ? `last change here — ▶ opens the next flow`
      : stop
        ? (s.text ?? stopText(stop, s.foldedIn))
        : `${s.total ?? s.stops.length} here — ▶ for the first`;
  const title = btn(`⎇ ${s.branch} vs ${s.base}`, `${s.branch} vs ${s.base}\nOpen the review panel`, a.openPanel, false, 'rb-title');
  return html('div', { class: 'review-bar', role: 'toolbar', 'aria-label': 'Review changes' }, [
    title,
    html('span', { class: 'rb-sep' }, ['│']),
    btn('⏮', 'Previous flow (Shift+P)', a.prevFlow, s.flowIndex <= 0),
    flowButton(s, flow, flowTitle, a),
    btn('⏭', 'Next flow (Shift+N)', a.nextFlow, s.flowIndex >= s.flows.length - 1),
    html('span', { class: 'rb-sep' }, ['│']),
    btn('◀', s.current <= 0 ? 'Previous change (P): the last change of the previous flow' : 'Previous change (P)', a.prevChange, s.current <= 0 && s.flowIndex <= 0),
    // Δ badges on class boxes count members changed anywhere in the branch, not only the calls drawn
    html('span', { class: `rb-change${stop ? ` st-${stop.diff?.status ?? (stop.diff?.call || stop.diff?.method ? 'changed' : 'inside')}` : ''}`, title: s.stops.length ? changeText : `${changeText}\nA Δn on a box counts the members of its class the branch changed — also those this flow does not call` }, [
      // what the tour counts (the panel and the flow list count changed methods)
      html('span', { class: 'rb-count', title: `Steps of the tour: each changed call, and each changed method it reaches${flow ? ` (${flow.methods.length} changed method${flow.methods.length === 1 ? '' : 's'} in this flow)` : ''}` }, [changeCount(s)]),
      ` ${changeText}`,
    ]),
    btn('▶', 'Next change (N) — expands collapsed calls with changes below', a.nextChange, !s.stops.length && s.flowIndex >= s.flows.length - 1),
  ]);
}

/** FR-24.12 the flow label as a button: it lists every flow of the tour. */
function flowButton(s: ReviewBarState, flow: TourFlow | undefined, title: string, a: ReviewBarActions): HTMLElement {
  const b = html('button', { type: 'button', class: 'rb-flow rb-flow-btn', title: `${title}\n\nClick: all ${s.flows.length} flows`, 'aria-haspopup': 'listbox', 'data-cmd': 'choose-flow' }, [
    html('span', { class: 'rb-count' }, [`Flow ${s.flowIndex >= 0 ? s.flowIndex + 1 : '–'}/${s.flows.length}`]),
    ` ${s.also ? s.also.label : flow ? flow.label : 'other diagram'}`,
    // FR-24.12 "8 affected, 1 flow": the flow stands for the entry points that reach the same changes
    s.also ? html('span', { class: 'rb-also' }, [` · same changes as ${flow!.label}`]) : flow?.alsoFrom.length ? html('span', { class: 'rb-also' }, [` · ${coversText(flow)}`]) : null,
    html('span', { class: 'rb-caret', 'aria-hidden': 'true' }, [' ▾']),
  ]);
  b.addEventListener('click', () => a.chooseFlow(b));
  return b;
}

/** Does the flow match the filter: its label, the methods it shows, the entry points it also stands for. */
export function flowMatches(f: TourFlow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [f.label, ...f.methods, ...f.alsoFrom.flatMap((a) => [a.label, ...a.methods])].some((t) => t.toLowerCase().includes(q));
}

/**
 * FR-24.12 all flows of the tour in a popup: a filter on top (flow label or changed method — "where does
 * `Order.total` change?"), each row with what it reviews; flows with no entry point after a separator.
 * Enter opens the first match, ↑ ↓ move, Escape closes.
 */
export function flowChooser(flows: TourFlow[], current: number, pick: (index: number, also?: number) => void): HTMLElement {
  const input = html('input', { type: 'text', class: 'find-input fc-filter', placeholder: 'Filter: entry point or changed method', 'aria-label': 'Filter flows', spellcheck: 'false', autocomplete: 'off' }) as HTMLInputElement;
  const list = html('div', { class: 'fc-list', role: 'listbox' });
  const status = html('div', { class: 'fc-status' });
  let active = -1;
  const rows: { el: HTMLElement; index: number; also?: number }[] = [];
  const render = () => {
    list.replaceChildren();
    rows.length = 0;
    let separated: 'unreached' | 'notWalked' | undefined;
    flows.forEach((f, i) => {
      if (!flowMatches(f, input.value)) return;
      const sep = f.entryPoint ? undefined : f.notWalked ? 'notWalked' : 'unreached';
      if (sep && sep !== separated && rows.length) {
        list.appendChild(html('div', { class: 'fc-sep' }, [sep === 'notWalked' ? 'Changed methods not walked up to the entry points (limit)' : 'Changed methods no entry point reaches']));
        separated = sep;
      }
      const methods = f.methods.length ? f.methods.join(', ') : 'nothing new (reaches changes shown before)';
      const el = html('button', { type: 'button', class: `fc-row${i === current ? ' current' : ''}`, role: 'option', 'data-flow-index': String(i), title: [f.label, `Shows: ${methods}`, ...alsoLine(f)].join('\n') }, [
        html('span', { class: 'fc-num' }, [i === current ? '✓' : String(i + 1)]),
        html('span', { class: 'fc-main' }, [
          html('span', { class: 'fc-label' }, [f.label, f.alsoFrom.length ? html('span', { class: 'rb-also' }, [` · ${coversText(f)}`]) : null]),
          html('span', { class: 'fc-methods' }, [`${f.methods.length} changed: ${methods}`]),
        ]),
      ]);
      el.addEventListener('click', () => pick(i));
      rows.push({ el, index: i });
      list.appendChild(el);
      // FR-24.12 the entry points this flow covers, indented: each opens its own flow down to the same changes
      f.alsoFrom.forEach((a, j) => {
        const sub = html('button', { type: 'button', class: 'fc-row fc-sub', role: 'option', 'data-flow-index': String(i), 'data-also-index': String(j), title: `${a.label}\nReaches ${a.methods.join(', ')} — shown by flow ${i + 1}; click for its own flow` }, [
          html('span', { class: 'fc-num' }, ['↳']),
          html('span', { class: 'fc-main' }, [html('span', { class: 'fc-label' }, [a.label]), html('span', { class: 'fc-methods' }, [`${a.methods.length} changed, same as above: ${a.methods.join(', ')}`])]),
        ]);
        sub.addEventListener('click', () => pick(i, j));
        rows.push({ el: sub, index: i, also: j });
        list.appendChild(sub);
      });
    });
    active = rows.length ? 0 : -1;
    rows[0]?.el.classList.add('active');
    const shown = rows.filter((r) => r.also === undefined).length;
    status.textContent = shown === flows.length ? `${flows.length} flows` : `${shown} of ${flows.length} flows`;
  };
  const move = (delta: number) => {
    if (!rows.length) return;
    rows[active]?.el.classList.remove('active');
    active = (active + delta + rows.length) % rows.length;
    rows[active].el.classList.add('active');
    rows[active].el.scrollIntoView?.({ block: 'nearest' });
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') move(1);
    else if (e.key === 'ArrowUp') move(-1);
    else if (e.key === 'Enter' && rows[active]) pick(rows[active].index, rows[active].also);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  render();
  const panel = html('div', { class: 'callers-panel flow-chooser', role: 'dialog', 'aria-label': 'Flows of the review' }, [input, status, list]);
  setTimeout(() => input.focus(), 0);
  return panel;
}
