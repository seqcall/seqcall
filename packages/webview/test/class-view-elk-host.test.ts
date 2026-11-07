// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassDiagram, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge } from './helpers';

/**
 * The class view with the default ELK engine when ELK is slow or fails: the real ELK unless a test holds or
 * rejects its answers (`hold`).
 */
let hold: ((graph: unknown) => Promise<unknown>) | undefined;
let calls = 0;
vi.mock('elkjs/lib/elk.bundled.js', async (importOriginal) => {
  const Real = ((await importOriginal()) as { default: new () => { layout(g: unknown, o?: unknown): Promise<unknown> } }).default;
  return {
    default: class {
      private real = new Real();
      layout = (g: unknown, o?: unknown) => {
        calls++;
        return hold ? hold(g) : this.real.layout(g, o);
      };
    },
  };
});

afterEach(() => {
  hold = undefined;
  calls = 0;
});

const cls = (key: string, layer?: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: 'src/shop', methods: Array.from({ length: 8 }, (_, i) => ({ name: `step${i}`, isStatic: false, signature: `step${i}()` })), ...(layer ? { layer } : {}) });
const shop: ClassDiagram = { classes: [cls('Shop', 'Application'), cls('Order', 'Domain')], relations: [{ id: 'r', kind: 'dependency', from: 'Shop', to: 'Order' }] };
const invoice: ClassDiagram = { classes: [cls('Invoice', 'Domain')], relations: [] };

function setup() {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth });
  const drawn = () => [...view.canvas.querySelectorAll('.class-node')].map((n) => n.getAttribute('data-class-key'));
  const logs = (level: string) => bridge.posted.flatMap((m) => (m.type === 'log' && m.level === level ? [m.message] : []));
  return { bridge, view, drawn, logs };
}

/** ELK answers held until released (in any order). */
function deferred() {
  const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  hold = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  return pending;
}

describe('class view: ELK answers late or fails (FR-12.5)', () => {
  it('FR-12.5 a layout that is overtaken by a newer diagram is dropped: the newer one is drawn, nothing laid out twice', async () => {
    const pending = deferred();
    const { bridge, view, drawn } = setup();
    bridge.send({ type: 'render', diagram: shop });
    bridge.send({ type: 'render', diagram: invoice });
    expect(calls).toBe(2);
    hold = undefined;
    pending[0].resolve({ id: 'root', children: [{ id: 'Shop', x: 0, y: 0 }, { id: 'Order', x: 0, y: 200 }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(drawn()).toEqual([]);
    pending[1].resolve({ id: 'root', children: [{ id: 'Invoice', x: 0, y: 0 }] });
    await view.settled();
    expect(drawn()).toEqual(['Invoice']);
    expect(calls).toBe(2);
  });

  it('FR-12.5 the same diagram laid out again with other options (Layers off) before ELK answered: the older answer is dropped', async () => {
    const pending = deferred();
    const { bridge, view, drawn } = setup();
    bridge.send({ type: 'render', diagram: shop });
    view.setLanes(false);
    expect(calls).toBe(2);
    pending[0].resolve({ id: 'root', children: [{ id: 'Shop', x: 0, y: 0 }, { id: 'Order', x: 0, y: 200 }] });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2); // not laid out a third time
    expect(drawn()).toEqual([]);
    pending[1].resolve({ id: 'root', children: [{ id: 'Shop', x: 0, y: 0 }, { id: 'Order', x: 0, y: 200 }] });
    await view.settled();
    expect(drawn()).toEqual(['Shop', 'Order']);
  });

  it('FR-12.5 ELK fails: the view says so in the log and draws with dagre', async () => {
    hold = async () => {
      throw new Error('out of memory');
    };
    const { bridge, view, drawn, logs } = setup();
    bridge.send({ type: 'render', diagram: shop });
    await vi.waitFor(() => expect(drawn()).toEqual(['Shop', 'Order']));
    expect(logs('error')).toEqual(['ELK layout failed, using dagre: out of memory']);
    expect(logs('info').at(-1)).toContain('(dagre)');
    await view.settled(); // dagre: nothing pending
  });

  it('FR-12.5 ELK rejects with something that is not an Error: its text is logged', async () => {
    hold = () => Promise.reject('worker gone');
    const { bridge, logs, drawn } = setup();
    bridge.send({ type: 'render', diagram: shop });
    await vi.waitFor(() => expect(drawn()).toEqual(['Shop', 'Order']));
    expect(logs('error')).toEqual(['ELK layout failed, using dagre: worker gone']);
  });

  it('FR-12.5 a failure of an overtaken layout is ignored: the newer diagram still gets ELK', async () => {
    const pending = deferred();
    const { bridge, view, drawn, logs } = setup();
    bridge.send({ type: 'render', diagram: shop });
    bridge.send({ type: 'render', diagram: invoice });
    pending[0].reject(new Error('cancelled'));
    pending[1].resolve({ id: 'root', children: [{ id: 'Invoice', x: 0, y: 0 }] });
    await view.settled();
    expect(drawn()).toEqual(['Invoice']);
    expect(logs('error')).toEqual([]);
    expect(logs('info').at(-1)).toContain('(elk)');
  });

  it('FR-12.5 settled() waits for the layout of the current options: Layers, edge style and the methods shown', async () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: shop });
    await view.settled();
    expect(view.canvas.querySelectorAll('.class-lane')).toHaveLength(2);
    view.setLanes(false);
    await view.settled();
    expect(view.canvas.querySelectorAll('.class-lane')).toHaveLength(0);
    const before = view.canvas.querySelector('svg');
    view.setEdgeStyle('straight'); // another routing: ELK again, drawn when it answers
    expect(view.canvas.querySelector('svg')).toBe(before);
    await view.settled();
    expect(view.canvas.querySelector('svg')).not.toBe(before);
    const rows = view.canvas.querySelectorAll('[data-member]').length;
    fire(view.canvas.querySelector('[data-more-toggle="Shop"]')!, 'click');
    await view.settled();
    expect(view.canvas.querySelectorAll('[data-member]').length).toBe(rows + 3);
  });

  it('FR-12.5 settled() returns at once without a diagram', async () => {
    const { view } = setup();
    await view.settled();
    expect(calls).toBe(0);
  });
});
