import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostToClassView } from '@seqcall/protocol';
import { DiagramSession, layerScopes } from '@seqcall/core';
import { HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, SAMPLE_APP, type Recorded } from './controller-helpers';

// The class view's messages through the HeadlessController (FR-12) on fixtures/sample-app (read only).

const CONTROLLER = `${SAMPLE_APP}/src/controllers/user-controller.ts`;
const SERVICE_KEY = 'src/services/user-service.ts#UserService';

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of disposers) await d();
  disposers = [];
});

/** getUser open, the class view ready (its first render received). */
async function opened(): Promise<{ c: HeadlessController; r: Recorded }> {
  const r = recordingSink();
  const c = new HeadlessController(r.sink, { workspace: SAMPLE_APP });
  disposers.push(() => c.dispose());
  await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
  await c.onClassMessage({ type: 'ready' });
  return { c, r };
}

const lastClass = (cls: HostToClassView[]) => {
  const m = cls.filter((x) => x.type === 'render').pop();
  if (m?.type !== 'render') throw new Error(`no class render in ${JSON.stringify(cls.map((x) => x.type))}`);
  return m;
};

describe('HeadlessController: class view messages (FR-12)', () => {
  it('FR-12.4 the class view on ready: the classes of the flow, with the flow\'s options, root class and layers', async () => {
    const { r } = await opened();
    const seq = lastRender(r.seq);
    const m = lastClass(r.cls);
    expect(m.diagram.classes.map((x) => x.key)).toEqual(['src/controllers/user-controller.ts#UserController', SERVICE_KEY, 'src/domain/user-dto.ts#UserDto', 'src/util/logger.ts#Logger', 'src/util/format.ts#<module>']);
    expect(m).toMatchObject({ rootClassKey: 'src/controllers/user-controller.ts#UserController', options: seq.options, hiddenFilters: [], layerChoices: seq.layerChoices });
    expect(m).not.toHaveProperty('borrowedConfig');
  });

  it('FR-7.12 layer scopes of a class of the diagram\'s project, in the view that asked', async () => {
    const { c, r } = await opened();
    const scopes = layerScopes(SAMPLE_APP, SERVICE_KEY, 'UserService');
    expect(scopes.length).toBeGreaterThan(0);
    await c.onSequenceMessage({ type: 'requestLayerScopes', classKey: SERVICE_KEY, className: 'UserService' });
    await c.onClassMessage({ type: 'requestLayerScopes', classKey: SERVICE_KEY, className: 'UserService' });
    expect(r.seq.at(-1)).toEqual({ type: 'layerScopes', classKey: SERVICE_KEY, scopes });
    expect(r.cls.at(-1)).toEqual({ type: 'layerScopes', classKey: SERVICE_KEY, scopes });
  });

  it('FR-12.14 / FR-12.9 a relation: its calls opened and highlighted; without a call its field, else the class the view gave, else nothing', async () => {
    const { c, r } = await opened();
    // collapsed calls behind UserService → UserRepository (via the field replica): opened, then highlighted
    await c.onClassMessage({ type: 'revealRelation', from: SERVICE_KEY, to: 'src/ports/user-repository.ts#UserRepository', field: 'replica' });
    expect(lastRender(r.seq).messages.find((m) => m.id === 'root/2:findUser')?.expanded).toBe(true);
    expect(r.seq.at(-1)).toEqual({ type: 'highlight', messageId: 'root/2:findUser/0:findById', messageIds: ['root/2:findUser/0:findById'] });
    // no call through the field notifier in this flow: its declaration (before the class the view gives)
    const elsewhere = { file: `${SAMPLE_APP}/src/notifications/notifier.ts`, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    await c.onClassMessage({ type: 'revealRelation', from: SERVICE_KEY, to: 'src/notifications/notifier.ts#Notifier', field: 'notifier', fallback: elsewhere });
    expect(r.other.at(-1)).toEqual({ kind: 'navigate', arg: { file: `${SAMPLE_APP}/src/services/user-service.ts`, start: { line: 10, character: 21 }, end: { line: 10, character: 29 } } });
    // neither a call nor a field: the class the view points at, else nothing
    const fallback = { file: `${SAMPLE_APP}/src/util/logger.ts`, start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    const seqBefore = r.seq.length;
    await c.onClassMessage({ type: 'revealRelation', from: 'src/domain/user-dto.ts#UserDto', to: 'src/util/logger.ts#Logger', fallback });
    expect(r.other.at(-1)).toEqual({ kind: 'navigate', arg: fallback });
    const otherBefore = r.other.length;
    await c.onClassMessage({ type: 'revealRelation', from: 'src/domain/user-dto.ts#UserDto', to: 'src/util/logger.ts#Logger' });
    expect(r.other.length).toBe(otherBefore);
    expect(r.seq.length).toBe(seqBefore);
  });

  it('FR-12.12 type uses switched on: only the class diagram is derived again, with the use relations; a failure is logged', async () => {
    const { c, r } = await opened();
    const uses = () => lastClass(r.cls).diagram.relations.filter((x) => x.kind === 'use').map((x) => `${x.from} → ${x.to}`);
    expect(uses()).toEqual([]);
    const seqBefore = r.seq.length;
    await c.onClassMessage({ type: 'setTypeUses', value: true });
    expect(uses()).toEqual([`${SERVICE_KEY} → src/domain/user.ts#User`, 'src/util/format.ts#<module> → src/domain/user.ts#User']);
    expect(r.seq.length).toBe(seqBefore);
    await c.onClassMessage({ type: 'setTypeUses', value: false });
    expect(uses()).toEqual([]);
    vi.spyOn(DiagramSession.prototype, 'setOption').mockRejectedValueOnce(new Error('sidecar gone'));
    const clsBefore = r.cls.length;
    await c.onClassMessage({ type: 'setTypeUses', value: false });
    expect(r.logs('error')).toEqual(['class diagram: sidecar gone']);
    expect(r.cls.length).toBe(clsBefore);
  });

  it('FR-11.6 / FR-9.3 / FR-12.13 / FR-28.7 / FR-28.9 filters, focus, options and layers from the class view change both diagrams', async () => {
    const { c, r } = await opened();
    await c.onClassMessage({ type: 'hide', filter: { kind: 'class', classKey: 'src/util/logger.ts#Logger', className: 'Logger' } });
    expect(lastRender(r.seq).participants.some((p) => p.className === 'Logger')).toBe(false);
    expect(lastClass(r.cls).diagram.classes.some((x) => x.name === 'Logger')).toBe(false);
    const filterId = lastRender(r.seq).hiddenFilters[0].filter.id;
    await c.onClassMessage({ type: 'unhide', filterId });
    expect(lastRender(r.seq).participants.some((p) => p.className === 'Logger')).toBe(true);
    await c.onClassMessage({ type: 'hide', filter: { kind: 'class', classKey: 'src/util/logger.ts#Logger', className: 'Logger' } });
    await c.onClassMessage({ type: 'unhideAll' });
    expect(lastClass(r.cls).hiddenFilters).toEqual([]);
    await c.onClassMessage({ type: 'setOption', option: 'showArguments', value: true });
    expect(lastClass(r.cls).options?.showArguments).toBe(true);
    await c.onClassMessage({ type: 'setOption', option: 'layerZoom', value: true });
    await c.onClassMessage({ type: 'setLayerOpen', layer: 'layer:Application', open: true });
    expect(lastRender(r.seq).options.openLayers).toEqual(['layer:Application']);
    await c.onClassMessage({ type: 'foldLayers' });
    expect(lastRender(r.seq).options.openLayers).toEqual([]);
    await c.onClassMessage({ type: 'setOption', option: 'layerZoom', value: false });
    await c.onClassMessage({ type: 'focus', messageId: 'root/2:findUser' });
    expect(lastRender(r.seq).root.name).toBe('findUser');
    expect(lastClass(r.cls).rootClassKey).toBe(SERVICE_KEY);
  });

  it('FR-24.11 a changed class\'s diff asked outside a review: nothing to show, said in the log (as VS Code says it)', async () => {
    const { c, r } = await opened();
    const counts = [r.seq.length, r.cls.length];
    const infos = r.logs('info').length;
    await c.onClassMessage({ type: 'openDiff', classKey: SERVICE_KEY });
    await c.onSequenceMessage({ type: 'openDiff', messageId: 'root/2:findUser' });
    await c.onSequenceMessage({ type: 'openDiff' });
    expect([r.seq.length, r.cls.length]).toEqual(counts);
    expect(r.logs('info').slice(infos)).toEqual(Array(3).fill('no diff for this call (the review has ended?)'));
    expect(r.other.some((o) => o.kind === 'navigate')).toBe(false);
  });

  it('FR-12.14 / FR-25.2 a reveal or a settings restore that fails is reported, not thrown past the controller', async () => {
    const { c, r } = await opened();
    vi.spyOn(DiagramSession.prototype, 'revealRelation').mockRejectedValueOnce(new Error('relation gone'));
    await c.onClassMessage({ type: 'revealRelation', from: SERVICE_KEY, to: 'src/util/logger.ts#Logger' }); // rejects if thrown
    expect(r.logs('error').at(-1)).toBe('reveal relation: relation gone');
    vi.spyOn(DiagramSession.prototype, 'restoreSettings').mockRejectedValueOnce(new Error('no settings'));
    await c.onSequenceMessage({ type: 'restoreSettings' });
    expect(r.logs('error').at(-1)).toBe('restoreSettings: no settings');
    expect(r.seq.at(-1)).toEqual({ type: 'error', message: 'no settings' });
  });

  it('FR-12.4 a class diagram that fails to derive: the class view says why', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink, { workspace: SAMPLE_APP });
    disposers.push(() => c.dispose());
    await c.openAt(CONTROLLER, positionOf(CONTROLLER, 'this.validate(id);'));
    vi.spyOn(DiagramSession.prototype, 'getClassDiagram').mockRejectedValueOnce(new Error('no types'));
    await c.onClassMessage({ type: 'ready' });
    expect(r.cls).toEqual([{ type: 'empty', reason: 'Error: no types' }]);
    expect(r.logs('error')).toEqual(['class diagram: no types']);
  });
});
