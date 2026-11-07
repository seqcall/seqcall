// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { askMarkdown, findingCard, guideCard, guideOf } from '../src/finding-guide';
import { fire, mount, testBridge } from './helpers';

// FR-25.5 Ask AI: a ready question for an AI chat or agent, about a call (with the shown flow, built by the host) or
// about an issue (the card).

const FIND = 'root/1:placeOrder/0:findById';
const settle = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => vi.restoreAllMocks());

describe('FR-25.5 Ask AI', () => {
  it('FR-25.5 right-click a call → Ask AI about this call asks the host for the prompt about that call', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    bridge.send({ type: 'render', diagram: cloneSequence() });
    const msg = [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === FIND)!;
    fire(msg.querySelector('.msg-hit')!, 'contextmenu', { clientX: 50, clientY: 60 });
    const item = view.root.querySelector('.popup-layer [data-menu-id="ask-ai"]') as HTMLElement;
    expect(item.textContent).toContain('Ask AI about this call');
    fire(item, 'click');
    expect(bridge.last()).toEqual({ type: 'copyText', messageId: FIND });
  });

  it('FR-25.5 an issue card: Ask AI copies a question, then the card as Markdown; explanation cards have no Ask AI', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (t: string) => void writes.push(t)) } });
    const card = findingCard({ id: 'c', kind: 'dependency-cycle', title: 'Dependency cycle: A → B → A' }, { show: () => undefined, ignore: () => undefined, close: () => undefined });
    const ask = [...card.querySelectorAll('.gc-btn')].find((b) => b.textContent === 'Ask AI') as HTMLElement;
    ask.click();
    await settle();
    const lines = writes[0].split('\n');
    expect(lines[0]).toMatch(/^Seqcall flagged this design issue in my code/);
    expect(lines[1]).toBe('Read the code it names. Is it a real problem here or acceptable, and if real, what is the smallest fix?');
    expect(lines[3]).toBe('### ⚠ Dependency cycle: A → B → A');
    expect(askMarkdown('x').split('\n').at(-1)).toBe('x');
    expect(ask.textContent).toBe('Copied ✓');
    // the clipboard refused: says so
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    ask.click();
    await settle();
    expect(ask.textContent).toBe('Copy failed');
    // a card not asked to offer it (not an issue of the user's code): no question to ask
    expect([...guideCard('God class', guideOf('god-class')).querySelectorAll('.gc-btn')].map((b) => b.textContent)).toEqual(['Copy as Markdown']);
  });
});
