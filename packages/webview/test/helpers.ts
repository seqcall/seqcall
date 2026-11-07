import type { Finding } from '@seqcall/protocol';
import type { HostBridge } from '../src/bridge';

export interface TestBridge<In, Out> extends HostBridge<In, Out> {
  posted: Out[];
  send(msg: In): void;
  last(): Out | undefined;
}

export function testBridge<In, Out>(): TestBridge<In, Out> {
  const listeners: ((m: In) => void)[] = [];
  let state: unknown;
  const b: TestBridge<In, Out> = {
    posted: [],
    post: (m) => void b.posted.push(m),
    onMessage(cb) {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    getState: <T>() => state as T | undefined,
    setState: (s) => void (state = s),
    send: (m) => listeners.forEach((l) => l(m)),
    last: () => b.posted[b.posted.length - 1],
  };
  return b;
}

export function fire(el: Element, type: string, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

export function mount(): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  return document.getElementById('app')!;
}

/** FR-14.2: opens the View ▾ menu (sequence or class view) unless it is open, and returns the row of an option. */
export function viewOptionRow(view: { root: HTMLElement }, option: string): HTMLElement {
  if (!view.root.querySelector('.popup-layer [data-menu-id^="view:"]')) fire(view.root.querySelector('[data-cmd="view"]')!, 'click');
  const row = view.root.querySelector(`.popup-layer [data-menu-id="view:${option}"]`) as HTMLElement | null;
  if (!row) throw new Error(`no View option ${option}`);
  return row;
}

/**
 * FR-19.17 the core sends a flow's layer violations as issues (`findings`) beside the red relations: test diagrams
 * written with `violation` on relations get them the same way (the core's layerViolationFindings, without evidence).
 */
export function withViolations<D extends { classes: { key: string; name: string }[]; relations: { id: string; from: string; to: string; violation?: string }[]; findings?: Finding[] }>(d: D): D {
  const name = (k: string) => d.classes.find((c) => c.key === k)?.name ?? k;
  const issues: Finding[] = d.relations
    .filter((r) => r.violation)
    .map((r) => ({ id: `layer-violation:${r.id}`, kind: 'layer-violation', title: `Layer violation: ${name(r.from)} → ${name(r.to)}`, detail: r.violation, classKeys: [r.from, r.to], relationIds: [r.id] }));
  return { ...d, findings: [...(d.findings ?? []), ...issues] };
}

/** FR-19.17 opens ⚠ N (sequence or class view) and returns the row of an issue. */
export function issueRow(view: { root: HTMLElement }, id: string): HTMLElement {
  fire(view.root.querySelector('[data-cmd="findings"]')!, 'click');
  const row = view.root.querySelector(`.popup-layer [data-menu-id="finding:${id}"]`) as HTMLElement | null;
  if (!row) throw new Error(`no issue ${id}`);
  return row;
}
