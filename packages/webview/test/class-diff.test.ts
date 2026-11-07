// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { fire, mount, testBridge } from './helpers';

describe('FR-24.6 the class view compared with the base version', () => {
  it('classes and relations new on the branch / removed by it are marked and say so', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string, diff?: 'added' | 'removed') => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [], ...(diff ? { diff } : {}) });
    const diagram: ClassDiagram = {
      classes: [node('OrderService'), node('Order'), node('Audit', 'removed'), node('Db', 'added')],
      relations: [
        { id: 'r1', kind: 'dependency', from: 'OrderService', to: 'Audit', diff: 'removed' },
        { id: 'r2', kind: 'dependency', from: 'Order', to: 'Db', diff: 'added' },
        { id: 'r3', kind: 'dependency', from: 'OrderService', to: 'Order' },
      ],
    };
    bridge.send({ type: 'render', diagram });
    const cls = (key: string) => view.canvas.querySelector(`[data-class-key="${key}"]`)!;
    const rel = (id: string) => view.canvas.querySelector(`[data-relation-id="${id}"]`)!;
    expect(cls('Audit').classList.contains('diff-removed')).toBe(true);
    expect(cls('Db').classList.contains('diff-added')).toBe(true);
    expect(cls('Order').getAttribute('class')).not.toContain('diff-');
    expect(cls('Audit').querySelector('title')!.textContent).toContain('reached only by calls this branch removed');
    expect(rel('r1').classList.contains('diff-removed')).toBe(true);
    expect(rel('r2').classList.contains('diff-added')).toBe(true);
    expect(rel('r2').querySelector('title')!.textContent).toContain('new on this branch');
    expect(rel('r3').getAttribute('class')).not.toContain('diff-');
  });

  it('FR-24.11 a changed class: Δn tag (members in its tooltip), member rows signed; tag and changed rows open the diff; a new class: NEW', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const diagram: ClassDiagram = {
      classes: [
        {
          key: 'Order', name: 'Order', kind: 'class', stereotypes: [], namespace: '',
          methods: [
            { name: 'total', isStatic: false, signature: 'total(): number', diff: 'changed' },
            { name: 'legacy', isStatic: false, signature: 'legacy(): number', diff: 'removed' },
            { name: 'db', isStatic: false, signature: 'db: Db', diff: 'added', field: true },
            { name: 'show', isStatic: false, signature: 'show(): void' },
          ],
          change: { kind: 'changed', members: [
            { kind: 'method', name: 'total', change: 'changed', text: 'total(): number', hunk: [{ kind: '+', text: "new Db().save('total');", at: true }], line: 4 },
            { kind: 'method', name: 'legacy', change: 'removed', text: 'legacy(): number' },
            { kind: 'field', name: 'db', change: 'added', text: 'db: Db' },
          ] },
        },
        { key: 'Pricing', name: 'Pricing', kind: 'class', stereotypes: [], namespace: '', methods: [], change: { kind: 'new', members: [] } },
      ],
      relations: [],
    };
    bridge.send({ type: 'render', diagram });
    const cls = (key: string) => view.canvas.querySelector(`[data-class-key="${key}"]`)!;
    expect(cls('Order').querySelector('.change-tag')!.textContent).toContain('Δ3');
    expect(cls('Order').querySelector('.change-tag title')!.textContent).toBe('Changed on this branch:\n~ total(): number\n− legacy(): number\n+ db: Db (field)\n(click: open it side by side)');
    expect(cls('Pricing').querySelector('.change-tag')!.textContent).toContain('NEW');
    expect([...cls('Order').querySelectorAll('.cls-diff-sign')].map((x) => x.textContent)).toEqual(['~', '−', '+']);
    const row = (name: string) => cls('Order').querySelector(`[data-member="${name}"]`)!;
    expect(row('legacy').getAttribute('text-decoration')).toBe('line-through');
    expect(row('total').querySelector('title')!.textContent).toBe("~ total(): number — method changed on this branch\n+ new Db().save('total');\n(click: open the change side by side)");
    fire(row('total'), 'click');
    expect(bridge.last()).toEqual({ type: 'openDiff', classKey: 'Order', member: 'total' });
    fire(cls('Pricing').querySelector('.change-tag rect')!, 'click');
    expect(bridge.last()).toEqual({ type: 'openDiff', classKey: 'Pricing' });
    // an unchanged row keeps its navigation
    expect(row('show').hasAttribute('data-member-diff')).toBe(false);
  });
});
