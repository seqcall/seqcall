import * as fs from 'node:fs';
import type { Message, SequenceDiagram } from '@seqcall/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { changeAt, changeIdentities, collectChanges, firstHeldBy, interfaceChangesLast, placeChanges, type FlowChanges } from '../src/review/flow-changes';
import { callChangeLines, parseHunks } from '../src/review/git-changes';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';
import { makeGatewayRepo, makeInterfaceOnlyRepo } from './fixtures/gateway-repo';

let root = '';
beforeAll(() => {
  root = makeGatewayRepo();
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const weight = (m: Message) => (m.diff?.count ?? 0) + (m.diff?.folded ?? 0);
const sum = (d: SequenceDiagram | undefined) => (d?.messages ?? []).reduce((n, m) => n + weight(m), 0);
const named = (d: SequenceDiagram | undefined, name: string) => d!.messages.find((m) => m.methodName === name)!;

describe('FR-3.12 the Changes view', () => {
  it('FR-3.12 opens only the paths to the changed methods, from any state — the whole flow or below one call', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    expect(await s.smartExpand(undefined, false, 'changes')).toBeUndefined();
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    const entry = r.methods.find((m) => m.method.name === 'chargeOne')!.reachedFrom[0].entryPoint;
    const paths = r.methods.flatMap((m) => m.reachedFrom.filter((x) => x.entryPoint.method.key === entry.method.key).map((x) => x.steps));
    const tour = (await s.openChangeFlow(paths, entry))!.diagram!;
    const open = (d: SequenceDiagram | undefined) => d!.messages.filter((m) => m.expanded).map((m) => m.id);
    await s.expandEverything();
    const changes = (await s.smartExpand(undefined, false, 'changes'))!;
    expect(open(changes)).toEqual(open(tour));
    expect(changes.messages.some((m) => m.importance)).toBe(false);
    // below one call: that call opened along its paths, the same calls as the whole view there
    const pay = changes.messages.find((m) => m.id !== 'root' && m.methodName === 'pay')!.id;
    await s.collapseAll();
    const below = (await s.smartExpand(pay, false, 'changes'))!;
    expect(open(below)).toEqual(open(tour));
    // a call with no change below it: nothing opens
    const before = open(below);
    const plain = below.messages.find((m) => m.id !== 'root' && !m.diff?.count)!;
    expect(open(await s.smartExpand(plain.id, false, 'changes'))).toEqual(before);
  });
});

describe('FR-24.15 one list of changes per flow', () => {
  it('FR-24.15 a blank line added between two methods changes neither', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root) });
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    const names = r.methods.map((m) => `${m.method.owner.name}.${m.method.name}`);
    expect(names).toEqual(expect.arrayContaining(['CardGateway.charge', 'CardGateway.chargeOne', 'WalletGateway.charge', 'Checkout.pay']));
    expect(names).not.toContain('CardGateway.fee');
  });

  it('FR-24.15 the total stays the same whatever implementation is drawn, expanded or zoomed; ▶ reaches the other implementation', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    const entry = r.methods.find((m) => m.method.name === 'chargeOne')!.reachedFrom[0].entryPoint;
    const paths = r.methods.flatMap((m) => m.reachedFrom.filter((x) => x.entryPoint.method.key === entry.method.key).map((x) => x.steps));
    const opened = (await s.openChangeFlow(paths, entry))!;
    const d = opened.diagram!;
    const total = d.reviewTotal!;
    // pay (method changed), the charge call (changed line) and the drawn implementation's charge, the other
    // implementation's charge, the card's charge no longer calling fee() (removed), the new chargeOne call and its
    // call of fee() (a call the new method makes), the new audit call after it
    expect(total).toBe(8);
    expect(sum(d)).toBe(total);
    const charge = named(d, 'charge');
    expect(charge.diff).toMatchObject({ status: 'changed', count: 3 });
    expect(charge.diff?.before).toBeUndefined();
    const other = charge.diff!.elsewhere!;
    expect(other).toHaveLength(1);
    expect(other[0].count).toBe(1);
    // the drawn implementation's new helper: a new call, its calls new too — not the calls of the unchanged fee()
    const shown = charge.polymorphic!.selectedKey!;
    const card = shown.endsWith('CardGateway');
    const cardView = card ? d : (await s.selectImplementation(charge.id, other[0].classKey))!;
    const expanded = (await s.expandEverything(charge.id))!;
    expect(named(expanded, 'chargeOne').diff?.status).toBe('added');
    const under = (name: string) => expanded.messages.find((m) => m.methodName === name && m.id.includes(':chargeOne/'))!;
    expect(under('fee').diff?.status).toBe('added');
    expect(under('round').diff?.status).toBeUndefined();
    // the Rounder below the moved fee() call is no new object (the base flow did not open fee() there)
    expect(expanded.participants.find((p) => p.id === under('round').to)!.diff).toBeUndefined();
    expect(expanded.messages.find((m) => m.methodName === 'fee' && m.diff?.status === 'removed')).toBeDefined();
    expect(expanded.reviewTotal).toBe(total);
    expect(sum(expanded)).toBe(total);
    expect(sum(cardView)).toBe(total);
    // the other implementation picked by hand: the same total, the card's changes now "in CardGateway"
    const wallet = named(cardView, 'charge').polymorphic!.implementations.find((i) => i.name === 'WalletGateway')!;
    const w = (await s.selectImplementation(named(cardView, 'charge').id, wallet.key))!;
    expect(w.reviewTotal).toBe(total);
    expect(sum(w)).toBe(total);
    expect(named(w, 'charge').diff?.elsewhere?.map((e) => e.className)).toEqual(['CardGateway']);
    // back to the interface, zoomed to layers, layers opened, all collapsed: still the same
    expect(sum(await s.revertImplementation(named(w, 'charge').id))).toBe(total);
    expect(sum(await s.setOption('layerZoom', true))).toBe(total);
    expect(sum(await s.setLayerOpen('layer:Infrastructure', true))).toBe(total);
    expect(sum(await s.setOption('layerZoom', false))).toBe(total);
    const collapsed = (await s.collapseAll())!;
    expect(collapsed.messages.find((m) => m.id === 'root/1:pay')!.diff).toMatchObject({ count: total, inside: total - 1 });
    expect(sum(collapsed)).toBe(total);
    // ▶ on the interface call: opens the implementation that holds the change, lands on it
    const again = (await s.openChangeFlow(paths, entry))!.diagram!;
    const holder = named(again, 'charge');
    const revealed = (await s.revealChange(holder.id))!;
    const target = revealed.diagram!.messages.find((m) => m.id === revealed.messageId)!;
    expect(weight(target)).toBeGreaterThan(0);
    expect(named(revealed.diagram, 'charge').polymorphic?.selectedKey).toBe(holder.diff!.elsewhere![0].classKey);
    expect(sum(revealed.diagram)).toBe(total);
  });

  it('FR-24.15 the tour by number: every change shown in turn, forwards, back and forwards again — the same calls each time', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    const entry = r.methods.find((m) => m.method.name === 'chargeOne')!.reachedFrom[0].entryPoint;
    const paths = r.methods.flatMap((m) => m.reachedFrom.filter((x) => x.entryPoint.method.key === entry.method.key).map((x) => x.steps));
    const total = (await s.openChangeFlow(paths, entry))!.diagram!.reviewTotal!;
    const walk = async (ns: number[]) => {
      const seen: string[] = [];
      for (const n of ns) {
        const shown = (await s.showChange(n))!;
        const m = shown.diagram!.messages.find((x) => x.id === shown.messageId)!;
        // drawn, and showing that number
        expect(m.diff?.positions?.map((p) => p.n), `change ${n}`).toContain(n);
        expect(shown.diagram!.reviewTotal).toBe(total);
        seen.push(`${n}:${m.id}:${m.polymorphic?.selectedKey ?? ''}`);
      }
      return seen;
    };
    const up = Array.from({ length: total }, (_, i) => i + 1);
    const forward = await walk(up);
    const back = await walk([...up].reverse());
    expect(back).toEqual([...forward].reverse());
    expect(await walk(up)).toEqual(forward);
    // the other implementation's change comes right after the changes below the call in the first one
    const charge = forward.filter((x) => x.includes(':root/1:pay/0:charge:'));
    const impls = [...new Set(charge.map((x) => x.slice(x.lastIndexOf(':') + 1)))];
    expect(impls).toHaveLength(2);
    // zoomed to layers: the same calls (layers opened as needed)
    await s.setOption('layerZoom', true);
    expect((await walk(up)).map((x) => x.split(':')[0])).toEqual(up.map(String));
  });

  it('FR-24.15 the tour\'s order: reading order; the other implementation\'s change right after the changes below the call, before what follows it', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    const entry = r.methods.find((m) => m.method.name === 'chargeOne')!.reachedFrom[0].entryPoint;
    const paths = r.methods.flatMap((m) => m.reachedFrom.filter((x) => x.entryPoint.method.key === entry.method.key).map((x) => x.steps));
    const total = (await s.openChangeFlow(paths, entry))!.diagram!.reviewTotal!;
    const order: string[] = [];
    for (let n = 1; n <= total; n++) {
      const shown = (await s.showChange(n))!;
      const m = shown.diagram!.messages.find((x) => x.id === shown.messageId)!;
      const own = m.diff!.positions!.find((p) => p.n === n)!;
      const impl = m.polymorphic?.selectedKey?.slice(m.polymorphic.selectedKey.lastIndexOf('#') + 1);
      order.push(`${m.diff?.status === 'removed' ? '-' : own.method ? 'method' : (m.diff?.status ?? 'call')} ${own.method && impl ? impl : (m.className ?? '')}.${m.methodName}`);
    }
    expect(order).toEqual([
      'method Checkout.pay',
      'changed PaymentGateway.charge', // the call: its argument changed
      'method CardGateway.charge', // the implementation drawn first, then everything below it
      '- CardGateway.fee',
      'added CardGateway.chargeOne',
      'added CardGateway.fee',
      'method WalletGateway.charge', // the other implementation: right after, not at the end
      'added Checkout.audit', // what follows the interface call
    ]);
  });

  it('FR-24.15 a call both versions make: its card shows its own old lines against its new ones', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    const entry = r.methods.find((m) => m.method.name === 'chargeOne')!.reachedFrom[0].entryPoint;
    const paths = r.methods.flatMap((m) => m.reachedFrom.filter((x) => x.entryPoint.method.key === entry.method.key).map((x) => x.steps));
    const d = (await s.openChangeFlow(paths, entry))!.diagram!;
    const charge = d.messages.find((m) => m.methodName === 'charge')!;
    // `return this.gateway.charge(orderId);` became `const n = this.gateway.charge([orderId]);` — not the audit
    // lines added below it
    expect(charge.diff?.hunk?.map((l) => `${l.kind}${l.text.trim()}`)).toEqual(['-return this.gateway.charge(orderId);', '+const n = this.gateway.charge([orderId]);']);
    // a new call: its own lines only (not the lines changed around it)
    const card = (m: Message | undefined) => m?.diff?.hunk?.map((l) => `${l.kind}${l.text.trim()}`);
    expect(card(d.messages.find((m) => m.methodName === 'audit'))).toEqual(['+this.audit(n);']);
    // a removed call: its own lines from the base version; its diff opens at what replaced it (the new helper's call)
    const all = (await s.expandEverything())!;
    const ghost = all.messages.find((m) => m.methodName === 'fee' && m.diff?.status === 'removed')!;
    expect(card(ghost)).toEqual(['-return this.fee(1);']);
    const chargeOne = all.messages.find((m) => m.methodName === 'chargeOne')!;
    expect((await s.diffTarget(ghost.id))!.line).toBe(chargeOne.callSite!.start.line);
    // a call in a new method: its lines as new
    expect(card(all.messages.find((m) => m.methodName === 'fee' && m.id.includes(':chargeOne/')))).toEqual(['+return this.fee(1);']);
  });

  it('FR-24.15 the call\'s own lines, not the tail of a removed loop above it (a per-item loop replaced by one call)', () => {
    const diff = [
      'diff --git a/app/Shop.cs b/app/Shop.cs',
      '@@ -10,12 +10,7 @@',
      '         var client = Pick(id);',
      '-        foreach (var group in items.GroupBy(i => i.Vendor))',
      '-        {',
      '-            var (orders, status) = await client.FetchAsync(',
      '-                group.Key,',
      '-                token);',
      '-            if (status != Ok)',
      '-            {',
      '-                continue;',
      '-            }',
      '-            all.AddRange(orders);',
      '-        }',
      '+        var (orders, status) = await client.FetchAsync(',
      '+            items,',
      '+            token);',
      '+        all.AddRange(orders);',
      '         return all;',
    ].join('\n');
    const hunks = parseHunks(diff, 'app/').get('Shop.cs')!;
    // the old call at lines 13–15, the new one at 11–13
    expect(callChangeLines(hunks, [13, 15], [11, 13])!.map((l) => `${l.kind}${l.text.trim()}`)).toEqual([
      '-var (orders, status) = await client.FetchAsync(',
      '-group.Key,',
      '-token);',
      '+var (orders, status) = await client.FetchAsync(',
      '+items,',
      '+token);',
    ]);
    // unchanged call lines: nothing of its own to show (the caller falls back to the lines around it)
    expect(callChangeLines(hunks, [10, 10], [10, 10])).toBeUndefined();
  });

  it('FR-24.15 placing changes: drawn, below a collapsed call, in another implementation; a change shown twice counts once', () => {
    const msg = (id: string, parentId: string | null, extra: Partial<Message> = {}): Message => ({ id, parentId, depth: id.split('/').length - 1, from: null, to: 'p', kind: 'call', methodName: id.slice(id.lastIndexOf(':') + 1), expandable: true, expanded: true, ...extra }) as Message;
    const site = (line: number) => ({ file: 'a.ts', start: { line, character: 2 }, end: { line, character: 9 } });
    const flow: FlowChanges = {
      order: [],
      changes: new Map([
        ['c1', [{ id: 'root/0:a', path: ['root', 'root/0:a'], needs: new Map() }]],
        ['c2', [{ id: 'root/1:b/0:c', path: ['root', 'root/1:b', 'root/1:b/0:c'], needs: new Map() }]],
        ['c3', [{ id: 'root/2:i/0:d', path: ['root', 'root/2:i', 'root/2:i/0:d'], needs: new Map([['root/2:i', 'X']]) }]],
      ]),
    };
    // the identities of drawn messages decide "drawn": give root/0:a the identity c1 through a fake flow keyed by its real identity
    const a = msg('root/0:a', 'root', { diff: { call: true }, callSite: site(3) });
    const [ida] = changeIdentities(a);
    flow.changes.set(ida, flow.changes.get('c1')!);
    flow.changes.delete('c1');
    flow.order = [ida, 'c2', 'c3'];
    const view = [msg('root', null, { kind: 'found' }), a, msg('root/1:b', 'root', { expanded: false }), msg('root/2:i', 'root'), msg('root/3:a', 'root', { diff: { call: true }, callSite: site(3) })];
    const placed = placeChanges(flow, { messages: view, implOf: (id) => (id === 'root/2:i' ? 'Y' : undefined) });
    expect(placed.total).toBe(3);
    expect(placed.at.get('root/0:a')).toMatchObject({ own: 1 });
    expect(placed.at.get('root/3:a')).toBeUndefined(); // the same call site again: shown already
    expect(placed.at.get('root/1:b')).toMatchObject({ inside: 1 });
    expect(placed.at.get('root/2:i')!.elsewhere.get('X')).toBe(1);
  });

  it('FR-24.15 change identities: chained calls on one line are two changes; a new call carries its new method', () => {
    const at = (s: number, e: number) => ({ file: 'a.ts', start: { line: 3, character: s }, end: { line: 3, character: e } });
    const ctor = { id: 'r/0:constructor', methodName: 'constructor', callSite: at(4, 12), diff: { call: true } } as Message;
    const save = { id: 'r/1:save', methodName: 'save', callSite: at(4, 25), diff: { call: true } } as Message;
    expect(changeIdentities(ctor)).not.toEqual(changeIdentities(save));
    const added = { id: 'r/2:x', methodName: 'x', methodKey: 'a.ts#A.x', callSite: at(30, 35), diff: { status: 'added', method: 'added' } } as Message;
    expect(changeIdentities(added)).toHaveLength(1);
    const changed = { id: 'r/3:y', methodName: 'y', methodKey: 'a.ts#A.y', callSite: at(40, 45), diff: { status: 'changed', method: 'changed', signature: true } } as Message;
    expect(changeIdentities(changed)).toHaveLength(2); // the call (signature) and the body of the method it reaches
  });

  it('FR-24.15 change identities: a call without a site by its id; at an interface call the signature only; a method without a key by the message', () => {
    expect(changeIdentities({ id: 'r/0:x', methodName: 'x', diff: { call: true } } as Message)).toEqual(['cr/0:x']);
    const site = { file: 'a.ts', start: { line: 3, character: 2 }, end: { line: 3, character: 9 } };
    const iface = { id: 'r/1:pay', methodName: 'pay', methodKey: 'a.ts#Gateway.pay', callSite: site, polymorphic: { interfaceKey: 'a.ts#Gateway' }, diff: { call: true, method: 'changed' } } as Message;
    expect(changeIdentities(iface)).toEqual(['ca.ts:3:2-3:9:pay']);
    // an implementation drawn: the call and the method it reaches
    expect(changeIdentities({ ...iface, polymorphic: { interfaceKey: 'a.ts#Gateway', selectedKey: 'a.ts#Card' } } as Message)).toEqual(['ca.ts:3:2-3:9:pay', 'ma.ts#Gateway.pay']);
    expect(changeIdentities({ id: 'r/2:y', methodName: 'y', diff: { method: 'changed' } } as Message)).toEqual(['mr/2:y']);
    expect(changeIdentities({ id: 'r/3:z', methodName: 'z', callSite: site, diff: { status: 'removed' } } as Message)).toEqual(['-a.ts:3:2-3:9:z']);
    // the interface's method only: by the interface; without an interface on the message, nothing
    expect(changeIdentities({ ...iface, diff: { declared: 'changed' }, polymorphic: { interfaceKey: 'a.ts#Gateway', selectedKey: 'a.ts#Card' } } as Message)).toEqual(['ia.ts#Gateway.pay']);
    expect(changeIdentities({ id: 'r/4:w', methodName: 'w', diff: { declared: 'changed' } } as Message)).toEqual([]);
    const flow: FlowChanges = { changes: new Map(), order: ['ia.ts#Gateway.pay', 'cx', 'my'] };
    interfaceChangesLast(flow);
    expect(flow.order).toEqual(['cx', 'my', 'ia.ts#Gateway.pay']);
  });

  it('FR-24.15 the tour order: a change only another implementation has, below a call where nothing else changed, comes right after where the walk is', () => {
    const msg = (id: string, parentId: string | null, extra: Partial<Message> = {}): Message => ({ id, parentId, methodName: id.slice(id.lastIndexOf(':') + 1), ...extra }) as Message;
    const flow: FlowChanges = { changes: new Map(), order: [] };
    const first = [msg('root', null), msg('root/0:a', 'root', { diff: { call: true } }), msg('root/1:i', 'root'), msg('root/2:b', 'root', { diff: { call: true } })];
    collectChanges(flow, first, new Map([['root/1:i', 'Card']]));
    expect(flow.order).toEqual(['croot/0:a', 'croot/2:b']);
    const second = [msg('root', null), msg('root/0:a', 'root', { diff: { call: true } }), msg('root/1:i', 'root'), msg('root/1:i/0:x', 'root/1:i', { diff: { call: true } })];
    collectChanges(flow, second, new Map([['root/1:i', 'Wallet']]), (path) => (path.includes('root/1:i') ? 'root/1:i' : undefined));
    expect(flow.order).toEqual(['croot/0:a', 'croot/1:i/0:x', 'croot/2:b']);
    expect(flow.changes.get('croot/1:i/0:x')).toEqual([{ id: 'root/1:i/0:x', path: ['root', 'root/1:i', 'root/1:i/0:x'], needs: new Map([['root/1:i', 'Wallet']]) }]);
  });

  it('FR-24.15 placing changes: drawn elsewhere than first; on a message without its mark; below a call not drawn; the earliest holder; what only the view shows', () => {
    const msg = (id: string, parentId: string | null, extra: Partial<Message> = {}): Message => ({ id, parentId, methodName: id.slice(id.lastIndexOf(':') + 1), expandable: true, expanded: true, ...extra }) as Message;
    const occ = (path: string[]) => ({ id: path[path.length - 1], path, needs: new Map<string, string>() });
    const flow: FlowChanges = {
      order: ['cfirst', 'cplain', 'cgone', 'ctwo'],
      changes: new Map([
        // first in the flow at root/9:s (not drawn), drawn at root/0:s: there
        ['croot/9:s', [occ(['root', 'root/9:s'])]],
        // root/1:p is drawn without a mark of its own (the view's build): still its own change, before a place below an
        // earlier call
        ['cplain', [occ(['root', 'root/0:s', 'root/0:s/4:p']), occ(['root', 'root/1:p'])]],
        // below root/1:p/7:g, which the view does not draw: held by root/1:p
        ['cgone', [occ(['root', 'root/1:p', 'root/1:p/7:g', 'root/1:p/7:g/0:z'])]],
        // reached two ways, both collapsed: the earlier holder in the view; a path from another root: never first
        ['ctwo', [occ(['other', 'other/0:q']), occ(['root', 'root/3:late', 'root/3:late/0:t']), occ(['root', 'root/2:early', 'root/2:early/0:t']), occ(['another', 'another/0:q'])]],
      ]),
    };
    flow.order = ['croot/9:s', 'cplain', 'cgone', 'ctwo'];
    const view = [
      msg('root', null),
      msg('root/0:s', 'root', { diff: { call: true } }),
      msg('root/1:p', 'root'),
      msg('root/2:early', 'root', { expanded: false }),
      msg('root/3:late', 'root', { expanded: false }),
      // expanded beyond the review's paths: a change the flow does not list
      msg('root/4:extra', 'root', { diff: { call: true } }),
    ];
    // root/0:s has the identity croot/0:s, not croot/9:s: give the drawn one the flow's identity
    flow.changes.set('croot/0:s', flow.changes.get('croot/9:s')!);
    flow.changes.delete('croot/9:s');
    flow.order[0] = 'croot/0:s';
    const placed = placeChanges(flow, { messages: view, implOf: () => undefined });
    expect([...placed.placement].map(([k, p]) => `${k} ${p.kind} ${p.id}`)).toEqual([
      'cplain own root/1:p',
      'cgone inside root/1:p',
      'ctwo inside root/2:early',
      'croot/0:s own root/0:s',
      'croot/4:extra own root/4:extra',
    ]);
    expect(placed.order).toEqual(['croot/0:s', 'cplain', 'cgone', 'ctwo', 'croot/4:extra']);
    expect(changeAt(placed, 3)).toMatchObject({ kind: 'inside', id: 'root/1:p' });
    expect(changeAt(placed, 6)).toBeUndefined();
    expect(firstHeldBy(placed, 'root/2:early')?.path).toEqual(['root', 'root/2:early', 'root/2:early/0:t']);
    // root/1:p shows its own change and holds one below it: the held one
    expect(firstHeldBy(placed, 'root/1:p')?.id).toBe('root/1:p/7:g/0:z');
    expect(firstHeldBy(placed, 'root/4:extra')).toBeUndefined();
  });
});


describe('a change only the interface has', () => {
  let only = '';
  beforeAll(() => {
    only = makeInterfaceOnlyRepo();
  });
  afterAll(() => fs.rmSync(only, { recursive: true, force: true }));

  it('the call through the interface is a step of its own, after the code changes; the implementation drawn is unchanged', async () => {
    const s = new DiagramSession({ adapter: createTsAdapter(only), classifier: createClassifier(only), createBaseAdapter: () => createTsAdapter(only) });
    const r = (await s.reviewChanges({ base: 'develop' }))!;
    expect(r.methods.map((m) => `${m.method.owner.name}.${m.method.name}`)).toEqual(expect.arrayContaining(['PaymentGateway.charge', 'Checkout.pay']));
    const entry = r.methods.find((m) => m.method.name === 'pay')!.reachedFrom[0].entryPoint;
    const paths = r.methods.flatMap((m) => m.reachedFrom.filter((x) => x.entryPoint.method.key === entry.method.key).map((x) => x.steps));
    const d = (await s.openChangeFlow(paths, entry))!.diagram!;
    const charge = named(d, 'charge');
    // (the interface method's status is the review's: its new signature)
    const status = r.methods.find((m) => m.method.owner.name === 'PaymentGateway')!.status;
    expect([charge.polymorphic?.selectedKey?.endsWith('#CardGateway'), charge.diff?.method, charge.diff?.declared]).toEqual([true, undefined, status]);
    // its number is the last: the code changes (the new audit call, the changed pay) come first
    const numbers = d.messages.flatMap((m) => (m.diff?.positions ?? []).map((p) => [p.n, m.methodName]));
    // its line changed too (`const n = …`): that change in reading order, the interface's last of all
    expect(charge.diff!.positions!.map((p) => p.n)).toEqual([2, d.reviewTotal]);
    expect(numbers.filter(([n]) => n !== d.reviewTotal).map(([, name]) => name)).toEqual(['pay', 'charge', 'audit']);
  });
});
