// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntryPoint, HostToSequenceView, ProjectFinding, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge } from './helpers';

let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;
const ep: EntryPoint = { kind: 'http', label: 'GET /orders/{id:long}', verb: 'GET', method: cloneSequence().root };
const pf: ProjectFinding = { finding: { id: 'f1', kind: 'io-in-loop', title: 'I/O in a loop: Repo.find (DB)', detail: 'N+1', messageIds: ['root/0:x'] }, entryPoint: ep, others: 2 };
const panel = () => view.root.querySelector('.design-issues-panel') as HTMLElement | null;

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: cloneSequence() });
  bridge.posted.length = 0;
});

describe('FR-19.9 project-wide design issues panel', () => {
  it('the Entry points panel offers "⚠ Design issues"; it asks the host and shows progress with Cancel', () => {
    fire(view.toolbar.button('entryPoints'), 'click');
    bridge.send({ type: 'entryPoints', entryPoints: [ep], project: 'shop' });
    fire(view.root.querySelector('.ep-issues-btn')!, 'click');
    expect(bridge.last()).toEqual({ type: 'requestProjectFindings' });
    bridge.send({ type: 'projectFindings', state: 'running', done: 3, total: 12, project: 'shop' });
    expect(panel()!.textContent).toContain('Scanning flows… 3 / 12');
    fire([...panel()!.querySelectorAll('button')].find((b) => b.textContent === 'Cancel')!, 'click');
    expect(bridge.last()).toEqual({ type: 'cancelProjectFindings' });
  });

  it('Copy as Markdown copies the list through the clipboard', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void writes.push(t) } });
    view.showDesignIssues();
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf], total: 40, project: 'shop' });
    fire(panel()!.querySelector('.paths-copy')!, 'click');
    await new Promise((r) => setTimeout(r, 0));
    expect(writes[0].split('\n')[0]).toBe('**Design issues · shop** — 1 finding in 40 entry points');
  });

  it('FR-19.9 opened again after a scan: the list stays (no "Scanning"), the host is asked for its cached result', () => {
    view.showDesignIssues();
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf], total: 40, project: 'shop' });
    view.root.querySelector('.popup-layer')!.replaceChildren();
    bridge.posted.length = 0;
    view.showDesignIssues();
    expect(bridge.posted).toEqual([{ type: 'requestProjectFindings' }]);
    expect(panel()!.textContent).toContain('1 finding in 40 entry points');
    expect(panel()!.textContent).not.toContain('Scanning');
  });

  it('FR-19.23 the host\'s count of methods no entry point reaches is shown with the result', () => {
    view.showDesignIssues();
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf], total: 40, project: 'shop', unreached: { scanned: 12, skipped: 0 } });
    expect(panel()!.textContent).toContain('1 finding in 40 entry points and 12 methods no flow opened');
    expect(panel()!.textContent).not.toContain('The code changed while this ran');
    // FR-19.23 a new scan: the entry points' findings while the rest runs, kept through the later progress
    bridge.send({ type: 'projectFindings', state: 'running', done: 0, project: 'shop' });
    expect(panel()!.querySelector('.di-item')).toBeNull();
    bridge.send({ type: 'projectFindings', state: 'running', findings: [pf], walking: true, project: 'shop' });
    expect(panel()!.textContent).toContain('Looking for the methods no entry point reaches');
    bridge.send({ type: 'projectFindings', state: 'running', done: 41, total: 52, project: 'shop' });
    expect(panel()!.textContent).toContain('1 finding in the entry points so far');
    // the host says the code changed while it scanned
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf], total: 40, project: 'shop', changed: true });
    expect(panel()!.textContent).toContain('The code changed while this ran');
  });

  it('the result is grouped by kind; choosing a finding opens its flow', () => {
    view.showDesignIssues();
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf], total: 40, project: 'shop' });
    expect(panel()!.textContent).toContain('1 finding in 40 entry points');
    expect(panel()!.querySelector('.ep-group')!.textContent).toBe('I/O in loops (N+1) 1');
    const item = panel()!.querySelector('.di-item') as HTMLElement;
    expect(item.textContent).toBe('I/O in a loop: Repo.find (DB)← GET /orders/{id} · +2 more');
    expect(item.title).toBe('N+1');
    fire(item, 'click');
    expect(bridge.last()).toEqual({ type: 'openFinding', entryPoint: ep, finding: pf.finding });
    expect(panel()).toBeNull();
  });

  it('layer violations are listed too, as the last group', () => {
    view.showDesignIssues();
    const v: ProjectFinding = { finding: { id: 'layer-violation:r1', kind: 'layer-violation', title: 'Layer violation: Order → Db', detail: 'Domain → Infrastructure: an inner layer depends on an outer layer' }, entryPoint: ep };
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf, v], total: 40, project: 'shop' });
    expect([...panel()!.querySelectorAll('.ep-group')].map((g) => g.textContent)).toEqual(['I/O in loops (N+1) 1', 'Layer violations 1']);
    expect(panel()!.querySelectorAll('.di-item')[1].textContent).toContain('Layer violation: Order → Db');
  });

  it('flows cut by the expand limit are named (as the codebase map does)', () => {
    view.showDesignIssues();
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf], total: 61, truncated: 10, project: 'shop' });
    expect(panel()!.querySelector('.di-truncated')!.textContent).toBe('10 flows hit the expand limit (some calls stayed folded and were not checked).');
    bridge.send({ type: 'projectFindings', state: 'done', findings: [], total: 61, truncated: 1, project: 'shop' });
    expect(panel()!.querySelector('.di-truncated')!.textContent).toBe('1 flow hit the expand limit (some calls stayed folded and were not checked).');
  });

  it('a finished result has ↻ Scan again, which asks the host to rescan (bypassing its cache)', () => {
    view.showDesignIssues();
    bridge.send({ type: 'projectFindings', state: 'done', findings: [pf], total: 40, project: 'shop' });
    const rescan = panel()!.querySelector('.di-rescan') as HTMLElement;
    expect(rescan.title).toBe('Scan again');
    fire(rescan, 'click');
    expect(bridge.last()).toEqual({ type: 'requestProjectFindings', rescan: true });
    expect(panel()!.textContent).toContain('Scanning flows…');
    expect(panel()!.textContent).toContain('shop');
    expect(panel()!.querySelector('.di-rescan')).toBeNull(); // not while running
  });

  it('no findings / cancelled / error states', () => {
    view.showDesignIssues();
    bridge.send({ type: 'projectFindings', state: 'done', findings: [], total: 0 });
    expect(panel()!.textContent).toContain('No entry points to scan');
    bridge.send({ type: 'projectFindings', state: 'done', findings: [], total: 5 });
    expect(panel()!.textContent).toContain('No design issues found in 5 entry points.');
    bridge.send({ type: 'projectFindings', state: 'cancelled' });
    expect(panel()!.textContent).toContain('Scan cancelled.');
    bridge.send({ type: 'projectFindings', state: 'error', error: 'boom' });
    expect(panel()!.querySelector('.ep-status.error')!.textContent).toBe('boom');
  });
});
