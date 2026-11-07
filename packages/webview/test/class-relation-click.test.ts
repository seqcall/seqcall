// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassDiagram, ClassNode, ClassViewToHost, HostToClassView, HostToSequenceView, SequenceViewToHost, SourceRange } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { issueRow, mount, testBridge, withViolations } from './helpers';

const at = (line: number): SourceRange => ({ file: '/p/src/a.ts', start: { line, character: 4 }, end: { line, character: 20 } });
const cls = (key: string): ClassNode => ({ key, name: key, kind: 'class', stereotypes: [], namespace: 'src', methods: [], declaration: at(1) });
const diagram: ClassDiagram = {
  classes: [cls('A'), cls('B'), cls('C'), cls('I')],
  relations: [
    { id: 'one', kind: 'dependency', from: 'A', to: 'B', calls: [{ messageId: 'root/0:b', label: 'run → b', callSite: at(10) }] },
    { id: 'many', kind: 'dependency', from: 'A', to: 'C', calls: [{ messageId: 'root/1:c', label: 'run → c', callSite: at(11) }, { messageId: 'root/2:c', label: 'run → c', callSite: at(12) }] },
    { id: 'impl', kind: 'realization', from: 'C', to: 'I' },
  ],
};

function setup() {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  bridge.send({ type: 'render', diagram });
  bridge.posted.length = 0;
  const click = (id: string) => view.canvas.querySelector(`[data-relation-id="${id}"] .rel-hit`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 }));
  return { bridge, view, click };
}

describe('FR-12.9 clicking a class-diagram relation', () => {
  it('a single call: highlight it in the sequence diagram and jump to the code', () => {
    const { bridge, click } = setup();
    click('one');
    expect(bridge.posted).toEqual([
      { type: 'highlightMessages', messageIds: ['root/0:b'] },
      { type: 'navigate', range: at(10) },
    ]);
  });

  it('several calls: highlight all, then pick one from the list (jump + narrow the highlight)', () => {
    const { bridge, view, click } = setup();
    click('many');
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/1:c', 'root/2:c'] }]);
    const pick = view.root.querySelector('.popup-layer [data-menu-id="relation-call:1"]') as HTMLElement;
    expect(pick.textContent).toContain('run → c');
    pick.click();
    expect(bridge.posted.slice(1)).toEqual([
      { type: 'highlightMessages', messageIds: ['root/2:c'] },
      { type: 'navigate', range: at(12) },
    ]);
  });

  it('FR-12.14 a dependency / association whose calls are collapsed asks the host to reveal them (field, fallback)', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({ type: 'render', diagram: withViolations({ classes: [cls('Svc'), cls('Repo')], relations: [{ id: 'assoc', kind: 'association', from: 'Svc', to: 'Repo', label: 'repository', calls: [], violation: 'Application → Infrastructure' }] }) });
    bridge.posted.length = 0;
    view.canvas.querySelector('[data-relation-id="assoc"] .rel-hit')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 }));
    const reveal = { type: 'revealRelation', from: 'Svc', to: 'Repo', field: 'repository', fallback: at(1) };
    expect(bridge.posted).toEqual([reveal]);
    // ⚠ N (FR-19.17): pick the violation → outlined here and revealed in the sequence diagram
    bridge.posted.length = 0;
    const row = issueRow(view, 'layer-violation:assoc');
    expect(row.textContent).toContain('Svc → Repo');
    row.click();
    expect(bridge.posted).toEqual([reveal]);
    expect([...view.canvas.querySelectorAll('.class-node.finding-hl')].map((n) => n.getAttribute('data-class-key')).sort()).toEqual(['Repo', 'Svc']);
    expect(view.canvas.querySelectorAll('.relation.finding-hl')).toHaveLength(1);
  });

  it('FR-12.16 a layer violation opens its card: the case, ⚑ misclassification, show the calls, move the class, adjust the rule', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const rule = { ...cls('Rule'), layer: 'Domain' };
    const enums = { ...cls('Enums'), layer: 'Application', layerHint: { suggested: 'Domain', reasons: ['used only by Domain classes'] } };
    const call = { messageId: 'root/0:isActive', label: 'check → isActive', callSite: at(7) };
    bridge.send({ type: 'render', diagram: withViolations({ classes: [rule, enums], relations: [{ id: 'v', kind: 'dependency' as const, from: 'Rule', to: 'Enums', calls: [call], violation: 'Domain → Application: an inner layer depends on an outer layer' }] }) });
    bridge.posted.length = 0;
    view.canvas.querySelector('[data-relation-id="v"] .rel-hit')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 }));
    expect(bridge.posted).toEqual([{ type: 'highlightMessages', messageIds: ['root/0:isActive'] }]);
    const card = view.root.querySelector('.popup-layer .guide-card') as HTMLElement;
    expect(card.querySelector('.gc-title')!.textContent).toBe('⚠ Layer violation: Rule (Domain) → Enums (Application)');
    expect(card.querySelector('.gc-detail')!.textContent).toContain('⚑ Enums looks like Domain — used only by Domain classes: a misclassification would explain this violation.');
    expect(card.textContent).toContain('Dependency inversion');
    const buttons = [...card.querySelectorAll('.gc-btn')] as HTMLElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Show in diagram', 'Move Enums to Domain', 'Adjust the rule', 'Copy as Markdown', 'Ask AI', 'Close']);
    bridge.posted.length = 0;
    buttons[2].click();
    expect(bridge.posted).toEqual([{ type: 'openDependencyRule' }]);
    buttons[1].click();
    (view.root.querySelector('.popup-layer [data-cmd="ls-move"]') as HTMLElement).click(); // FR-7.12 the scope card: this file
    expect(bridge.last()).toEqual({ type: 'setLayer', classKey: 'Enums', className: 'Enums', layer: 'Domain' });
    // from ⚠ N too (FR-19.17)
    issueRow(view, 'layer-violation:v').click();
    expect(view.root.querySelector('.popup-layer .guide-card .gc-title')!.textContent).toContain('Layer violation: Rule');
  });

  it('realization (no call): jump to the implementing class', () => {
    const { bridge, click } = setup();
    click('impl');
    expect(bridge.posted).toEqual([{ type: 'navigate', range: at(1) }]);
  });
});

describe('sequence view highlights several messages', () => {
  it('marks every given message', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    bridge.send({ type: 'render', diagram: d });
    const ids = d.messages.filter((m) => m.kind === 'call').slice(0, 2).map((m) => m.id);
    bridge.send({ type: 'highlight', messageId: ids[0], messageIds: ids });
    const marked = [...view.body.querySelectorAll('.message.highlighted')].map((e) => e.getAttribute('data-msg-id'));
    expect(marked.sort()).toEqual([...ids].sort());
  });
});

describe('obvious association names are not drawn', () => {
  it('omits the label text but keeps the name in the tooltip', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    bridge.send({
      type: 'render',
      diagram: {
        classes: [cls('A'), cls('Coupon'), cls('Repo')],
        relations: [
          { id: 'obvious', kind: 'association', from: 'A', to: 'Coupon', label: '_coupon', labelObvious: true },
          { id: 'named', kind: 'association', from: 'A', to: 'Repo', label: 'primary' },
        ],
      },
    });
    const rel = (id: string) => view.canvas.querySelector(`[data-relation-id="${id}"]`)!;
    expect(rel('obvious').querySelector('.rel-label')).toBeNull();
    expect(rel('obvious').querySelector('title')!.textContent).toContain('_coupon');
    expect(rel('named').querySelector('.rel-label')!.textContent).toBe('primary');
  });
});
