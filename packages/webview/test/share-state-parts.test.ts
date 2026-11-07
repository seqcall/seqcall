// @vitest-environment jsdom
import type { DiagramStateReport } from '@seqcall/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onDiagramState, pasteStateCard, stateDetailsCard, stateSummary } from '../src/sequence/share-state';

afterEach(() => vi.restoreAllMocks());

function ui() {
  const flashes: string[] = [];
  const cards: HTMLElement[] = [];
  return { flashes, cards, flash: (t: string) => void flashes.push(t), card: (el: HTMLElement) => void cards.push(el) };
}

describe('FR-25.2 the host\'s answer to Copy / Save', () => {
  it('FR-25.2 an error, or nothing to share, is said in a flash', async () => {
    const u = ui();
    await onDiagramState({ error: 'No diagram' }, u);
    await onDiagramState({}, u);
    expect(u.flashes).toEqual(['No diagram', 'Nothing to share']);
  });

  it('FR-25.2 the host (VS Code) copied or saved it itself', async () => {
    const u = ui();
    await onDiagramState({ done: true }, u);
    await onDiagramState({ done: true, save: true }, u);
    expect(u.flashes).toEqual(['Copied ✓ — paste it into an issue or chat', 'Saved ✓']);
  });

  it('FR-25.2 Save in a browser without a name from the host: diagram.seqcall.json', async () => {
    const names: string[] = [];
    URL.createObjectURL = () => 'blob:1';
    URL.revokeObjectURL = () => {};
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    const u = ui();
    await onDiagramState({ text: '{}', save: true }, u);
    expect(names).toEqual(['diagram.seqcall.json']);
    expect(u.flashes).toEqual(['Saved ✓']);
  });

  it('FR-25.2 Copy where the clipboard works: copied, no card', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    const u = ui();
    await onDiagramState({ text: '{"v":1}' }, u);
    expect(writes).toEqual(['{"v":1}']);
    expect(u.flashes).toEqual(['Copied ✓ — paste it into an issue or chat']);
    expect(u.cards).toEqual([]);
  });
});

describe('FR-25.2 the paste card', () => {
  it('FR-25.2 Ctrl+Enter or Cmd+Enter opens the pasted text; Enter alone is a new line; an empty paste opens nothing', () => {
    const opened: string[] = [];
    const card = pasteStateCard((t) => opened.push(t), () => {});
    const area = card.querySelector('textarea')!;
    const key = (init: KeyboardEventInit) => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
    area.value = '  ';
    key({ ctrlKey: true });
    area.value = '{"a":1}';
    expect(key({})).toBe(true);
    expect(key({ ctrlKey: true })).toBe(false);
    expect(key({ metaKey: true })).toBe(false);
    expect(area.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))).toBe(true); // Ctrl+A selects
    expect(opened).toEqual(['{"a":1}', '{"a":1}']);
  });
});

describe('FR-25.2 the details of an opened state', () => {
  const report = (r: Partial<DiagramStateReport>): DiagramStateReport => ({ source: 'Shop.order · c9cbbc2', differences: [], missing: [], seen: { messages: 1, participants: 1 }, now: { messages: 1, participants: 1 }, settingsReplaced: false, ...r });
  const text = (el: HTMLElement) => [...el.querySelectorAll('.lr-head, .lr-row, .lr-note')].map((e) => e.textContent);

  it('FR-25.2 the same as the sender: one message, one object (singular)', () => {
    expect(text(stateDetailsCard(report({})))).toEqual(['Same code, same steps, same number of messages and objects as the sender.', '1 message, 1 object, as the sender saw.']);
  });

  it('FR-25.2 the notice line counts in plural; the card says the counts as the sender saw them', () => {
    expect(stateSummary(report({ differences: ['a', 'b'], missing: ['x', 'y'] }))).toBe('ⓘ Shared diagram Shop.order · c9cbbc2 — 2 differences, 2 steps not found');
    expect(text(stateDetailsCard(report({ seen: { messages: 5, participants: 3 }, now: { messages: 5, participants: 3 } }))).at(-1)).toBe('5 messages, 3 objects, as the sender saw.');
  });

  it('FR-25.2 differences only, other counts (no "as the sender saw"), settings replaced', () => {
    const r = report({ differences: ['3 messages more'], now: { messages: 4, participants: 1 }, settingsReplaced: true });
    expect(text(stateDetailsCard(r))).toEqual(['Differs from the sender', '≠3 messages more', " Your hidden calls and view options were replaced by the sender's."]);
  });

  it('FR-25.2 steps not found only; same message count but other objects', () => {
    const r = report({ missing: ['expanded: Shop.pay'], now: { messages: 1, participants: 2 } });
    expect(text(stateDetailsCard(r))).toEqual(['Not found in this code', '?expanded: Shop.pay', '']);
  });
});
