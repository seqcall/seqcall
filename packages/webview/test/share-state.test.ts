// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { DiagramStateReport, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import type { ClassDiagram, HostToClassView, ClassViewToHost } from '@seqcall/protocol';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const item = (root: HTMLElement, id: string) => root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;

function setup() {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  return { bridge, view };
}

const REPORT: DiagramStateReport = {
  source: 'OrderController.placeOrder · shop · c9cbbc2 · 2026-10-10',
  differences: ['Other commit: the sender was on 0123456, you are on c9cbbc2.'],
  missing: ['expanded call root/9:gone'],
  seen: { messages: 9, participants: 4 },
  now: { messages: 7, participants: 4 },
  settingsReplaced: true,
};

describe('FR-25.2 diagram state to share (sequence view)', () => {
  it('FR-25.2 ⤴ Share → Copy to reopen elsewhere asks the host; Open a shared diagram… sends the pasted text', () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: cloneSequence() });
    (view.root.querySelector('[data-cmd="image"]') as HTMLElement).click();
    item(view.root, 'state:copy')!.click();
    expect(bridge.last()).toEqual({ type: 'copyState' });

    (view.root.querySelector('[data-cmd="image"]') as HTMLElement).click();
    item(view.root, 'state:open')!.click();
    const area = view.root.querySelector('.state-card textarea') as HTMLTextAreaElement;
    (view.root.querySelector('[data-cmd="state-open"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'copyState' }); // nothing pasted: nothing sent
    area.value = '```json\n{"format":"seqcall-state"}\n```';
    (view.root.querySelector('[data-cmd="state-open"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'openState', text: area.value });
    expect(view.root.querySelector('.state-card')).toBeNull();
  });

  it('FR-25.2 an empty view offers to open a shared state; the host command opens the same card', () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'empty', reason: 'Open a file.' });
    (view.root.querySelector('[data-cmd="open-state"]') as HTMLElement).click();
    expect(view.root.querySelector('.state-card textarea')).not.toBeNull();
    (view.root.querySelector('[data-cmd="state-cancel"]') as HTMLElement).click();
    expect(view.root.querySelector('.state-card')).toBeNull();
    bridge.send({ type: 'openStatePrompt' });
    expect(view.root.querySelector('.state-card textarea')).not.toBeNull();
  });

  it('FR-25.2 the report: a notice with the counts, Details lists them, settings can be taken back; another root drops it', () => {
    const { bridge, view } = setup();
    const d = cloneSequence();
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'stateReport', report: REPORT });
    const notice = view.noticeEl;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('Shared diagram OrderController.placeOrder · shop · c9cbbc2 · 2026-10-10 — 1 difference, 1 step not found');

    const buttons = [...notice.querySelectorAll('button')];
    buttons.find((b) => b.textContent === 'Details')!.click();
    const card = view.root.querySelector('.state-card') as HTMLElement;
    expect(card.textContent).toContain('Other commit: the sender was on 0123456');
    expect(card.textContent).toContain('expanded call root/9:gone');
    expect(card.textContent).toContain('were replaced by the sender');

    buttons.find((b) => b.textContent === 'Back to my view settings')!.click();
    expect(bridge.last()).toEqual({ type: 'restoreSettings' });

    // a re-render of the same root keeps the notice (without the settings button now)
    bridge.send({ type: 'render', diagram: d });
    expect(notice.hidden).toBe(false);
    expect([...notice.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Details', '✕']);
    // another root: gone
    bridge.send({ type: 'render', diagram: { ...d, root: { ...d.root, key: 'other#X.y' } } });
    expect(notice.hidden).toBe(true);
  });

  it('FR-25.2 the same as the sender says so; an error opens a card', () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.send({ type: 'stateReport', report: { ...REPORT, differences: [], missing: [], settingsReplaced: false } });
    expect(view.noticeEl.textContent).toContain('same as the sender ✓');
    bridge.send({ type: 'stateReport', error: 'X.y is not in this project' });
    expect(view.root.querySelector('[role=alert]')!.textContent).toContain('X.y is not in this project');
  });

  it('FR-25.2 Save to reopen elsewhere: the page downloads the JSON (Rider / Vim); VS Code saved it itself', async () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: cloneSequence() });
    const urls: Blob[] = [];
    const clicked: string[] = [];
    const orig = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, click: HTMLAnchorElement.prototype.click };
    URL.createObjectURL = (b: Blob) => (urls.push(b), 'blob:x');
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    try {
      bridge.send({ type: 'diagramState', text: '{"format":"seqcall-state"}', save: true, name: 'A.run.seqcall.json' });
      await new Promise((r) => setTimeout(r, 0));
      expect(clicked).toEqual(['A.run.seqcall.json']);
      expect(urls[0].type).toBe('application/json');
      expect(view.root.querySelector('[data-cmd="image"]')!.getAttribute('data-flash')).toBe('Saved ✓');
      bridge.send({ type: 'diagramState', done: true });
      await new Promise((r) => setTimeout(r, 0));
      expect(view.root.querySelector('[data-cmd="image"]')!.getAttribute('data-flash')).toMatch(/^Copied ✓/);
    } finally {
      URL.createObjectURL = orig.create;
      URL.revokeObjectURL = orig.revoke;
      HTMLAnchorElement.prototype.click = orig.click;
    }
  });

  it('FR-25.2 when the clipboard refuses, the copied text is shown selected in a card', async () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.send({ type: 'diagramState', text: 'STATE-TEXT' }); // jsdom: no clipboard API, no execCommand copy
    await new Promise((r) => setTimeout(r, 0));
    expect((view.root.querySelector('.state-card textarea') as HTMLTextAreaElement | null)?.value).toBe('STATE-TEXT');
  });

  it('FR-25.4 Share → Copy as text asks the host; its answer is copied like the state (a card when the clipboard refuses)', async () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: cloneSequence() });
    (view.root.querySelector('[data-cmd="image"]') as HTMLElement).click();
    item(view.root, 'text:copy')!.click();
    expect(bridge.last()).toEqual({ type: 'copyText' });
    const btn = view.root.querySelector('[data-cmd="image"]')!;
    bridge.send({ type: 'diagramText', done: true }); // VS Code copied it itself
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.getAttribute('data-flash')).toMatch(/^Copied ✓/);
    bridge.send({ type: 'diagramText', error: 'No diagram to copy.' });
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.getAttribute('data-flash')).toBe('No diagram to copy.');
    bridge.send({ type: 'diagramText', text: 'A.run\n  B.go()' }); // jsdom: no clipboard API
    await new Promise((r) => setTimeout(r, 0));
    expect((view.root.querySelector('.state-card textarea') as HTMLTextAreaElement | null)?.value).toBe('A.run\n  B.go()');
  });

  it('FR-25.2 the toolbar button is "⤴ Share" (image and text in one menu)', () => {
    const { bridge, view } = setup();
    bridge.send({ type: 'render', diagram: cloneSequence() });
    const btn = view.root.querySelector('[data-cmd="image"]') as HTMLElement;
    expect(btn.querySelector('.tb-icon svg.share-icon')).not.toBeNull(); // the box with an arrow up
    expect(btn.textContent).toContain('Share');
    btn.click();
    expect([...view.root.querySelectorAll('.popup-layer [data-menu-id]')].map((e) => e.getAttribute('data-menu-id'))).toEqual(['image:copy', 'text:copy', 'image:png', 'image:svg', 'image:copy-visible', 'image:png-visible', 'state:copy', 'state:save', 'state:open']);
    item(view.root, 'state:save')!.click();
    expect(bridge.last()).toEqual({ type: 'copyState', save: true });
  });

  it('FR-25.3 the notice offers the sender\'s layer config; while it is in use a bar says so and config writes are held back', () => {
    const { bridge, view } = setup();
    const d = cloneSequence();
    bridge.send({ type: 'render', diagram: d });
    bridge.send({ type: 'stateReport', report: { ...REPORT, configDiffers: true } });
    [...view.noticeEl.querySelectorAll('button')].find((b) => b.textContent === 'Use the sender\'s layer config')!.click();
    expect(bridge.last()).toEqual({ type: 'useSharedConfig', on: true });

    bridge.send({ type: 'render', diagram: { ...d, borrowedConfig: { source: REPORT.source } } });
    expect(view.borrowEl.hidden).toBe(false);
    expect(view.borrowEl.textContent).toContain('Using the shared diagram\'s layer config');
    expect(view.borrowEl.textContent).toContain(REPORT.source);
    // offered once: not again while in use
    expect([...view.noticeEl.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Use the sender\'s layer config');

    const before = bridge.posted.length;
    view.handle({ type: 'render', diagram: { ...d, borrowedConfig: { source: REPORT.source } } });
    // a config write (Move to layer) is not sent; the card offers the way back
    (view as unknown as { post(m: SequenceViewToHost): void }).post({ type: 'setLayer', classKey: 'a#B', className: 'B', layer: 'Domain' });
    expect(bridge.posted.length).toBe(before);
    const card = view.root.querySelector('[role=alert]') as HTMLElement;
    expect(card.textContent).toContain('Not while the shared layer config is in use');
    (card.querySelector('[data-cmd="config-back"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'useSharedConfig', on: false });

    bridge.send({ type: 'render', diagram: d }); // the project's config again
    expect(view.borrowEl.hidden).toBe(true);
  });
});

const CLASS_DIAGRAM: ClassDiagram = {
  classes: [{ key: 'src/a.ts#A', name: 'A', kind: 'class', layer: 'Application', stereotypes: [], methods: [], fields: [] }],
  relations: [],
} as unknown as ClassDiagram;

describe('FR-25.2 / FR-25.3 the class view\'s Share menu', () => {
  function classSetup() {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    return { bridge, view };
  }

  it('FR-25.2 Copy to reopen elsewhere / Open a shared diagram… from the class view', async () => {
    const { bridge, view } = classSetup();
    bridge.send({ type: 'render', diagram: CLASS_DIAGRAM });
    const btn = view.root.querySelector('[data-cmd="image"]') as HTMLElement;
    expect(btn.textContent).toContain('Share');
    expect(btn.querySelector('svg.share-icon')).not.toBeNull();
    btn.click();
    item(view.root, 'state:copy')!.click();
    expect(bridge.last()).toEqual({ type: 'copyState' });
    btn.click();
    item(view.root, 'state:save')!.click();
    expect(bridge.last()).toEqual({ type: 'copyState', save: true });
    btn.click();
    item(view.root, 'state:open')!.click();
    (view.root.querySelector('.state-card textarea') as HTMLTextAreaElement).value = '{"format":"seqcall-state"}';
    (view.root.querySelector('[data-cmd="state-open"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'openState', text: '{"format":"seqcall-state"}' });
    bridge.send({ type: 'stateReport', error: 'X.y is not in this project' });
    expect(view.root.querySelector('[role=alert]')!.textContent).toContain('X.y is not in this project');
    bridge.send({ type: 'diagramState', text: 'STATE-TEXT' }); // no clipboard in jsdom: shown in a card
    await new Promise((r) => setTimeout(r, 0));
    expect((view.root.querySelector('.state-card textarea') as HTMLTextAreaElement).value).toBe('STATE-TEXT');
  });

  it('FR-25.4 Copy as text from the class view asks the host; the answer is copied (a card here); no diagram yet: disabled', async () => {
    const { bridge, view } = classSetup();
    const btn = view.root.querySelector('[data-cmd="image"]') as HTMLElement;
    btn.click();
    expect(item(view.root, 'text:copy')!.classList.contains('disabled')).toBe(true);
    expect(item(view.root, 'text:copy')!.getAttribute('title')).toBe('No diagram to copy');
    bridge.send({ type: 'render', diagram: CLASS_DIAGRAM });
    btn.click();
    item(view.root, 'text:copy')!.click();
    expect(bridge.last()).toEqual({ type: 'copyText' });
    bridge.send({ type: 'diagramText', text: 'CLASS-TEXT' }); // no clipboard in jsdom: shown in a card
    await new Promise((r) => setTimeout(r, 0));
    expect((view.root.querySelector('.state-card textarea') as HTMLTextAreaElement).value).toBe('CLASS-TEXT');
  });

  it('FR-25.2 the codebase map cannot be copied as text (the item says why)', () => {
    const { bridge, view } = classSetup();
    bridge.send({ type: 'render', diagram: CLASS_DIAGRAM });
    bridge.send({ type: 'showAppMap' });
    (view.root.querySelector('[data-cmd="image"]') as HTMLElement).click();
    for (const id of ['text:copy', 'state:copy', 'state:save']) {
      const copy = item(view.root, id)!;
      expect(copy.classList.contains('disabled')).toBe(true);
      expect(copy.getAttribute('title')).toContain('codebase map');
    }
  });

  it('FR-25.3 the class view shows the bar and holds config writes back while the shared config is in use', () => {
    const { bridge, view } = classSetup();
    bridge.send({ type: 'render', diagram: CLASS_DIAGRAM, borrowedConfig: { source: 'A.run · x' } });
    expect(view.borrowEl.hidden).toBe(false);
    const before = bridge.posted.length;
    (view as unknown as { bridge: { post(m: ClassViewToHost): void } }).bridge.post({ type: 'openDependencyRule' });
    expect(bridge.posted.length).toBe(before);
    (view.root.querySelector('[role=alert] [data-cmd="config-back"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'useSharedConfig', on: false });
    bridge.send({ type: 'render', diagram: CLASS_DIAGRAM });
    expect(view.borrowEl.hidden).toBe(true);
    (view as unknown as { bridge: { post(m: ClassViewToHost): void } }).bridge.post({ type: 'openDependencyRule' });
    expect(bridge.last()).toEqual({ type: 'openDependencyRule' });
  });
});
