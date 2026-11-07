import { afterEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram } from '@seqcall/protocol';
import { HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, SAMPLE_APP, type Recorded } from './controller-helpers';

// The sequence view's diagram intents through the HeadlessController (FR-15.2) on fixtures/sample-app (read only):
// each reaches its session operation, and both views get the result.

const CONTROLLER = `${SAMPLE_APP}/src/controllers/user-controller.ts`;
const SERVICE = `${SAMPLE_APP}/src/services/user-service.ts`;

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const d of disposers) await d();
  disposers = [];
});

async function opened(file = CONTROLLER, at = 'this.validate(id);'): Promise<{ c: HeadlessController; r: Recorded; d: SequenceDiagram }> {
  const r = recordingSink();
  const c = new HeadlessController(r.sink, { workspace: SAMPLE_APP });
  disposers.push(() => c.dispose());
  await c.openAt(file, positionOf(file, at));
  return { c, r, d: lastRender(r.seq) };
}

const expandedIds = (d: SequenceDiagram) => d.messages.filter((m) => m.expanded).map((m) => m.id);
const ids = (d: SequenceDiagram) => d.messages.map((m) => m.id);
/** The posts after `from`, by type. */
const typesAfter = (msgs: HostToSequenceView[], from: number) => msgs.slice(from).map((m) => m.type);

describe('HeadlessController: diagram intents (FR-15.2)', () => {
  it('FR-3.1 / FR-3.2 / FR-3.3 / FR-3.7 expand, collapse, expand one level, expand everything below a call, collapse all; the class view follows', async () => {
    const { c, r, d } = await opened();
    // FR-3.12 validate()'s only call is in its error branch: drawn with ↯ Fold errors off
    await c.onSequenceMessage({ type: 'setOption', option: 'foldErrors', value: false });
    await c.onClassMessage({ type: 'ready' });
    expect(expandedIds(d)).toEqual(['root']);

    await c.onSequenceMessage({ type: 'expand', messageId: 'root/2:findUser' });
    expect(expandedIds(lastRender(r.seq))).toEqual(['root', 'root/2:findUser']);
    await c.onSequenceMessage({ type: 'collapse', messageId: 'root/2:findUser' });
    expect(ids(lastRender(r.seq))).toEqual(ids(d));

    await c.onSequenceMessage({ type: 'expandAll', oneLevel: true });
    expect(expandedIds(lastRender(r.seq))).toEqual(['root', 'root/0:validate', 'root/1:info', 'root/2:findUser', 'root/3:formatName']);
    await c.onSequenceMessage({ type: 'collapseAll' });
    expect(expandedIds(lastRender(r.seq))).toEqual(['root']);

    await c.onSequenceMessage({ type: 'expandAll', messageId: 'root/0:validate' }); // everything below validate()
    expect(expandedIds(lastRender(r.seq))).toEqual(['root', 'root/0:validate', 'root/0:validate/0:error']);
    // FR-12.4 every change re-derives the class diagram
    const classRenders = r.cls.filter((m) => m.type === 'render');
    expect(classRenders).toHaveLength(6); // ready + five changes
  });

  it('FR-1.12 a fragment folds and opens again; FR-4.6 focus on a call; FR-4.3 back and forward walk the history', async () => {
    const { c, r } = await opened();
    await c.onSequenceMessage({ type: 'collapseFragment', fragmentId: 'root#loop0@6' });
    expect(lastRender(r.seq).fragments?.find((f) => f.id === 'root#loop0@6')?.collapsed).toBe(true);
    await c.onSequenceMessage({ type: 'expandFragment', fragmentId: 'root#loop0@6' });
    expect(lastRender(r.seq).fragments?.find((f) => f.id === 'root#loop0@6')?.collapsed).toBeFalsy();

    // FR-1.22 / FR-3.11 follow a case, show all cases, show an error path: each answered with a render
    for (const msg of [{ type: 'followCase', fragmentId: 'root#alt0@0', case: 0 }, { type: 'showAllCases', fragmentId: 'root#alt0@0' }, { type: 'showErrorPath', key: 'root#opt0@0#0' }] as const) {
      const before = r.seq.length;
      await c.onSequenceMessage(msg);
      expect(typesAfter(r.seq, before)).toContain('render');
    }

    await c.onSequenceMessage({ type: 'focus', messageId: 'root/2:findUser' }); // FR-4.6 the call as the new root
    expect(lastRender(r.seq).root.name).toBe('findUser');
    await c.onSequenceMessage({ type: 'back' });
    expect(lastRender(r.seq)).toMatchObject({ root: { name: 'getUser' }, canGoForward: true });
    await c.onSequenceMessage({ type: 'forward' });
    expect(lastRender(r.seq)).toMatchObject({ root: { name: 'findUser' }, canGoBack: true });
  });

  it('FR-8.2 / FR-8.3 implementations chosen and reverted; FR-4.1 / FR-4.2 callers listed, a caller as the new root', async () => {
    const { c, r } = await opened(SERVICE, 'const cached');
    const findById = () => lastRender(r.seq).messages.find((m) => m.id === 'root/0:findById')!;
    const impls = findById().polymorphic!.implementations.map((i) => i.key);
    expect(impls).toContain('src/adapters/sql-user-repository.ts#SqlUserRepository');
    await c.onSequenceMessage({ type: 'selectImplementation', messageId: 'root/0:findById', classKey: 'src/adapters/sql-user-repository.ts#SqlUserRepository' });
    expect(findById().polymorphic?.selectedKey).toBe('src/adapters/sql-user-repository.ts#SqlUserRepository');
    await c.onSequenceMessage({ type: 'revertImplementation', messageId: 'root/0:findById' });
    expect(findById().polymorphic?.selectedKey).toBeUndefined();

    await c.onSequenceMessage({ type: 'requestCallers', messageId: 'root' });
    const callers = r.seq.at(-1)!;
    if (callers.type !== 'callers') throw new Error(JSON.stringify(callers));
    expect(callers.messageId).toBe('root');
    const getUser = callers.callers.find((x) => x.enclosing.name === 'getUser')!;
    expect(callers.callers.map((x) => x.enclosing.name).sort()).toEqual(['audit', 'generate', 'getUser', 'managementChain', 'rename']);
    await c.onSequenceMessage({ type: 'reroot', messageId: 'root', callerId: getUser.id });
    expect(lastRender(r.seq).root.name).toBe('getUser');
  });

  it('FR-11.1 / FR-11.3 hide, unhide, unhide all; FR-9.3 an option; FR-28.1 / FR-28.7 / FR-28.9 layer zoom, a layer opened and folded', async () => {
    const { c, r } = await opened();
    await c.onSequenceMessage({ type: 'hide', filter: { kind: 'methodName', methodName: 'info' } });
    const d = lastRender(r.seq);
    expect(d.messages.some((m) => m.methodName === 'info')).toBe(false);
    const filterId = d.hiddenFilters[0].filter.id;
    await c.onSequenceMessage({ type: 'unhide', filterId });
    expect(lastRender(r.seq).messages.some((m) => m.methodName === 'info')).toBe(true);
    await c.onSequenceMessage({ type: 'hide', filter: { kind: 'methodName', methodName: 'info' } });
    await c.onSequenceMessage({ type: 'hide', filter: { kind: 'methodName', methodName: 'slugify' } });
    expect(lastRender(r.seq).hiddenFilters).toHaveLength(2);
    await c.onSequenceMessage({ type: 'unhideAll' });
    expect(lastRender(r.seq).hiddenFilters).toEqual([]);

    await c.onSequenceMessage({ type: 'setOption', option: 'showArguments', value: true });
    expect(lastRender(r.seq).options.showArguments).toBe(true);
    await c.onSequenceMessage({ type: 'setOption', option: 'layerZoom', value: true });
    expect(lastRender(r.seq).participants.map((p) => p.id)).toContain('layer:Application');
    await c.onSequenceMessage({ type: 'setLayerOpen', layer: 'layer:Application', open: true });
    expect(lastRender(r.seq).options.openLayers).toEqual(['layer:Application']);
    await c.onSequenceMessage({ type: 'foldLayers' });
    expect(lastRender(r.seq).options.openLayers).toEqual([]);
  });

  it('FR-25.2 restore settings re-renders the current diagram; FR-25.3 using a shared config when none was opened says why', async () => {
    const { c, r, d } = await opened();
    const from = r.seq.length;
    await c.onSequenceMessage({ type: 'restoreSettings' });
    expect(typesAfter(r.seq, from)).toEqual(['render']);
    expect(ids(lastRender(r.seq))).toEqual(ids(d));
    await c.onSequenceMessage({ type: 'useSharedConfig', on: true });
    expect(r.seq.at(-1)).toEqual({ type: 'stateReport', error: 'No shared diagram with a layer config was opened.' });
    expect(r.logs('error')).toEqual(['shared config: No shared diagram with a layer config was opened.']);
  });

  it('FR-4.3 / FR-15.2 a second diagram of the same project uses the same analysis: back returns to the first', async () => {
    const { c, r } = await opened();
    await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'const user = await this.userService.rename'));
    expect(lastRender(r.seq)).toMatchObject({ root: { name: 'renameUser' }, canGoBack: true });
    expect(r.other.filter((o) => o.kind === 'progress')).toHaveLength(2); // the first analysis only
  });

  it('FR-15.2 a message type the controller does not know is logged, not thrown', async () => {
    const { c, r } = await opened();
    const from = r.seq.length;
    await c.onSequenceMessage({ type: 'teleport', messageId: 'root' } as never);
    expect(r.logs('error')).toEqual(['unknown sequence view message {"type":"teleport","messageId":"root"}']);
    expect(r.seq.length).toBe(from);
  });
});
