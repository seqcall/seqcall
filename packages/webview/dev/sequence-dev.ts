/**
 * Dev harness for the sequence view: renders the mock diagram and fakes a little host
 * behaviour (options, expand/collapse flags, hide/unhide, implementation choice, callers).
 * Keys: t = theme, e = empty, r = error, h = highlight next message, d = redraw mock.
 */
import type { HostToSequenceView, Message, ParticipantPositions, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { createFakeBridge, installThemeSwitcher } from './harness';
import { cloneSequence, mockCallers } from './mock-data';

let diagram: SequenceDiagram = cloneSequence();
let positions: ParticipantPositions | undefined;
let filterSeq = 10;

function isUnder(m: Message, id: string): boolean {
  return m.id === id || m.id.startsWith(id + '/');
}

function render(): void {
  // Drop participants that are no longer referenced.
  const used = new Set(diagram.messages.flatMap((m) => [m.to, m.from ?? '']));
  diagram.participants = diagram.participants.filter((p) => used.has(p.id));
  bridge.send({ type: 'render', diagram: JSON.parse(JSON.stringify(diagram)), positions });
}

const bridge = createFakeBridge<HostToSequenceView, SequenceViewToHost>((msg) => {
  switch (msg.type) {
    case 'ready':
      return render();
    case 'setOption':
      (diagram.options as unknown as Record<string, unknown>)[msg.option] = msg.value;
      return render();
    case 'expand':
    case 'collapse': {
      const m = diagram.messages.find((x) => x.id === msg.messageId);
      if (!m) return;
      m.expanded = msg.type === 'expand';
      if (msg.type === 'collapse') diagram.messages = diagram.messages.filter((x) => x.id === m.id || !isUnder(x, m.id));
      return render();
    }
    case 'hide': {
      const f = msg.filter;
      const hits = diagram.messages.filter((m) =>
        m.kind !== 'found' &&
        (f.kind === 'methodName' ? m.methodName === f.methodName : f.kind === 'classMethod' ? m.classKey === f.classKey && m.methodName === f.methodName : f.kind === 'class' && m.classKey === f.classKey),
      );
      diagram.messages = diagram.messages.filter((m) => !hits.some((h) => isUnder(m, h.id)));
      diagram.hiddenFilters.push({ filter: { id: `f${filterSeq++}`, ...f } as SequenceDiagram['hiddenFilters'][number]['filter'], hiddenCount: hits.length });
      return render();
    }
    case 'unhide':
      diagram.hiddenFilters = diagram.hiddenFilters.filter((f) => f.filter.id !== msg.filterId);
      return render();
    case 'unhideAll':
    case 'collapseAll':
    case 'expandAll':
      diagram = cloneSequence();
      if (msg.type === 'unhideAll') diagram.hiddenFilters = [];
      return render();
    case 'selectImplementation':
    case 'revertImplementation': {
      const m = diagram.messages.find((x) => x.id === msg.messageId);
      const p = diagram.participants.find((x) => x.id === m?.to);
      if (!m?.polymorphic || !p) return;
      if (msg.type === 'selectImplementation') {
        const impl = m.polymorphic.implementations.find((i) => i.key === msg.classKey)!;
        m.polymorphic.selectedKey = impl.key;
        m.expandable = true;
        Object.assign(p, { className: impl.name, label: `:${impl.name}`, kind: 'class', stereotypes: ['adapter'], implementsInterface: { key: m.polymorphic.interfaceKey, name: m.polymorphic.interfaceName } });
      } else {
        delete m.polymorphic.selectedKey;
        m.expandable = false;
        Object.assign(p, { className: 'PaymentGateway', label: ':PaymentGateway', kind: 'interface', stereotypes: ['interface', 'port', 'seam'], implementsInterface: undefined });
      }
      return render();
    }
    case 'requestCallers':
      setTimeout(() => bridge.send({ type: 'callers', messageId: msg.messageId, callers: mockCallers }), 350);
      return;
    case 'savePositions':
      positions = msg.positions;
      return;
    default:
      return; // navigate, reroot, back, forward, openClassDiagram: just logged
  }
});

installThemeSwitcher();
startSequenceView(document.getElementById('app')!, bridge);

let hi = 0;
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === 'e') bridge.send({ type: 'empty', reason: 'No method at cursor' });
  if (e.key === 'r') bridge.send({ type: 'error', message: 'TypeError: cannot read properties of undefined (reading "members")' });
  if (e.key === 'd') render();
  if (e.key === 'h') {
    const ids = diagram.messages.map((m) => m.id);
    bridge.send({ type: 'highlight', messageId: ids[hi++ % ids.length] });
  }
});
console.log('[harness] keys: t theme, e empty, r error, d redraw, h highlight next');

// Screenshot hooks (headless checks): #dark, #menu, #callers, #hidden
setTimeout(() => {
  const h = location.hash;
  if (h.includes('dark')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 't' })), document.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }));
  const charge = document.querySelector('[data-msg-id="root/1:placeOrder/4:charge"] .msg-hit');
  const r = charge?.getBoundingClientRect();
  const at = { bubbles: true, clientX: (r?.left ?? 0) + 200, clientY: (r?.top ?? 0) + 4 };
  if (h.includes('menu')) {
    charge?.dispatchEvent(new MouseEvent('contextmenu', at));
    document.querySelector('[data-menu-id="choose-impl"]')?.dispatchEvent(new MouseEvent('mouseenter'));
  }
  if (h.includes('callers')) {
    charge?.dispatchEvent(new MouseEvent('contextmenu', at));
    (document.querySelector('[data-menu-id="show-callers"]') as HTMLElement | null)?.click();
  }
  if (h.includes('hidden')) (document.querySelector('[data-cmd="hidden"]') as HTMLElement | null)?.click();
}, 50);
