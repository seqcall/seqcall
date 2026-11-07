// @vitest-environment jsdom
import * as fs from 'node:fs';
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeadlessController, type HostSink } from '../../stdio-host/src/controller';
import { makeGatewayRepo } from '../../core/test/fixtures/gateway-repo';
import type { HostBridge } from '../src/bridge';
import { estimateTextWidth } from '../src/measure';
import { startSequenceView, type SequenceView } from '../src/sequence/view';
import { mount } from './helpers';

/**
 * FR-24.15 the review tour end to end: the real view wired to the real host (the editor-neutral controller the Rider
 * and Vim plugins use, the same session as VS Code) on a branch whose flow goes through an interface with two
 * changed implementations. N to the end, P to the start, N again: the same changes, in the same order.
 */
let root = '';
let ctl: HeadlessController;
let view: SequenceView;
let queue: Promise<void> = Promise.resolve();
/** The code diffs the host was asked to show (file:line), in order. */
const diffs: string[] = [];
const listeners: ((m: HostToSequenceView) => void)[] = [];

beforeAll(async () => {
  root = makeGatewayRepo();
  const bridge: HostBridge<HostToSequenceView, SequenceViewToHost> = {
    // the view's intents go to the host one after the other (as a host's message loop)
    post: (m) => void (queue = queue.then(() => ctl.onSequenceMessage(m))),
    onMessage(cb) {
      listeners.push(cb);
      return () => listeners.splice(listeners.indexOf(cb), 1);
    },
    getState: () => undefined,
    setState: () => undefined,
  };
  const sink: HostSink = {
    postSequence: (m) => listeners.forEach((l) => l(m)),
    postClass: () => undefined,
    navigate: () => undefined,
    openDiff: (target, keepFocus) => void diffs.push(`${target.file.slice(target.file.lastIndexOf('/') + 1)}:${target.line}${keepFocus ? '' : ' (focus)'}`),
    showClassDiagram: () => undefined,
    log: () => undefined,
    progress: () => undefined,
  };
  ctl = new HeadlessController(sink, { workspace: root });
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  const file = `${root}/src/presentation/checkout.controller.ts`;
  const line = fs.readFileSync(file, 'utf8').split('\n').findIndex((l) => l.includes('pay()'));
  await ctl.openAt(file, { line, character: 20 });
}, 60_000);
afterAll(async () => {
  await ctl?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Waits until the host answered everything the view asked (an answer can ask again: until it is quiet). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const q = queue;
    await q;
    await new Promise((r) => setTimeout(r, 0));
    if (q === queue) return;
  }
}

const key = async (k: string, shift = false) => {
  view.root.ownerDocument.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true }));
  await settle();
};
const count = () => (view.root.querySelector('.review-bar .rb-change .rb-count') as HTMLElement).textContent;
const lit = () => view.body.querySelector('.message.highlighted')?.getAttribute('data-msg-id') ?? 'none';

describe('FR-24.15 the review tour through the real host', () => {
  it('FR-24.15 N to the end, P to the start and N again visit the same changes in the same order, also zoomed to layers', async () => {
    await ctl.onSequenceMessage({ type: 'requestReview', base: 'develop' });
    await settle();
    // the flow is open but collapsed: its changes are below the first call
    expect(count()).toBe('Change –/8');
    const total = 8;
    const walk = async (k: 'n' | 'p', steps: number) => {
      const seen: string[] = [];
      for (let i = 0; i < steps; i++) {
        await key(k);
        seen.push(`${count()} ${lit()}`);
      }
      return seen;
    };
    // N to the last (the host expands and chooses what each change needs), then once more: the bar says it is the last
    const forward = await walk('n', total);
    // each step showed its code diff, the diagram keeping the focus
    expect(diffs).toHaveLength(total);
    expect(diffs.every((x) => !x.endsWith('(focus)'))).toBe(true);
    // the methods' changes at their own declarations (the two implementations, the checkout's pay and audit)
    expect(diffs.map((x) => x.split(':')[0])).toEqual(['checkout.ts', 'checkout.ts', 'card-gateway.ts', 'card-gateway.ts', 'card-gateway.ts', 'card-gateway.ts', 'wallet-gateway.ts', 'checkout.ts']);
    expect(forward.map((x) => x.split(' ').slice(0, 2).join(' '))).toEqual(Array.from({ length: total }, (_, i) => `Change ${i + 1}/${total}`));
    await key('n');
    expect(view.root.querySelector('.review-bar .rb-change')!.textContent).toContain('last change here');
    // every change highlighted a call of its own (none skipped, none twice in a row)
    expect(new Set(forward.map((x) => x.split(' ')[2])).size).toBeGreaterThan(total / 2);
    expect(forward.every((x) => !x.endsWith(' none'))).toBe(true);
    const back = await walk('p', total - 1);
    expect(back).toEqual(forward.slice(0, -1).reverse());
    await key('p'); // at the first: stays
    expect(count()).toBe(`Change 1/${total}`);
    expect([`${count()} ${lit()}`, ...(await walk('n', total - 1))]).toEqual(forward);
    // zoomed to layers: the same numbers, each change drawn (its layer opened when needed)
    await ctl.onSequenceMessage({ type: 'setOption', option: 'layerZoom', value: true });
    await settle();
    const zoomedBack = await walk('p', total - 1);
    expect(zoomedBack.map((x) => x.split(' ').slice(0, 2).join(' '))).toEqual(forward.slice(0, -1).reverse().map((x) => x.split(' ').slice(0, 2).join(' ')));
    expect(zoomedBack.every((x) => !x.endsWith(' none'))).toBe(true);
  }, 120_000);
});
