import { describe, expect, it } from 'vitest';
import { HeadlessController } from '../src/controller';
import { recordingSink } from './controller-helpers';

// The HeadlessController before any project is open (no workspace, no diagram): every view message gets an answer
// that says so, or nothing — never an exception, never a write.

const NO_METHOD_REASON = 'Place the caret inside a method, constructor, getter/setter or function body and run "Show Sequence Diagram".';
const NO_PROJECT = 'Open a project or a source file first.';

describe('HeadlessController without a project', () => {
  it('FR-16.2 / FR-19.9 / FR-24.13 / FR-26.5 the project lists say there is no project (no workspace, no diagram)', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink);
    await c.onSequenceMessage({ type: 'requestEntryPoints' });
    await c.onSequenceMessage({ type: 'requestProjectFindings' });
    await c.onSequenceMessage({ type: 'requestReview' });
    await c.onSequenceMessage({ type: 'requestGitRefs' });
    await c.onSequenceMessage({ type: 'searchMethods', query: 'persist' });
    expect(r.seq).toEqual([
      { type: 'entryPoints', entryPoints: [], error: 'No project open.', show: false },
      { type: 'projectFindings', state: 'error', error: NO_PROJECT, show: false },
      { type: 'review', state: 'error', error: NO_PROJECT, show: false },
      { type: 'gitRefs', error: NO_PROJECT },
      { type: 'methodResults', query: 'persist', methods: [], more: 0 },
    ]);
    await c.onClassMessage({ type: 'requestAppMap' });
    expect(r.cls).toEqual([{ type: 'appMap', state: 'error', error: NO_PROJECT }]);
    // the host asks directly (a command) with the defaults: not shown
    await c.sendProjectFindings();
    expect(r.seq.at(-1)).toEqual({ type: 'projectFindings', state: 'error', error: NO_PROJECT, show: false });
    await c.sendProjectFindings(true);
    expect(r.seq.at(-1)).toEqual({ type: 'projectFindings', state: 'error', error: NO_PROJECT, show: true });
    await c.onSequenceMessage({ type: 'requestUnreachable' });
    expect(r.seq.at(-1)).toEqual({ type: 'unreachable', state: 'error', error: NO_PROJECT, show: false });
    expect(r.other).toEqual([]); // no progress: nothing ran
  });

  it('FR-1.1 a (re)loaded view, a diagram intent or a state copy without a diagram: the views say what to do', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink);
    await c.onSequenceMessage({ type: 'ready' });
    await c.onSequenceMessage({ type: 'expand', messageId: 'root/0:find' });
    await c.onSequenceMessage({ type: 'copyState' });
    expect(r.seq).toEqual([
      { type: 'empty', reason: NO_METHOD_REASON },
      { type: 'empty', reason: NO_METHOD_REASON },
      { type: 'diagramState', error: 'No diagram to share.' },
    ]);
    // FR-12.4 the class view opens: nothing to derive yet
    await c.onClassMessage({ type: 'ready' });
    await c.onClassMessage({ type: 'copyState', save: true }); // FR-25.2 answered in the view that asked
    expect(r.cls).toEqual([
      { type: 'empty', reason: 'Open a sequence diagram first ("Show Sequence Diagram").' },
      { type: 'diagramState', error: 'No diagram to share.' },
    ]);
    expect(r.seq).toHaveLength(3);
  });

  it('FR-7.12 layer scopes without a project: none, in the view that asked', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink);
    await c.onSequenceMessage({ type: 'requestLayerScopes', classKey: 'src/a.ts#A', className: 'A' });
    await c.onClassMessage({ type: 'requestLayerScopes', classKey: 'src/b.ts#B', className: 'B' });
    expect(r.seq).toEqual([{ type: 'layerScopes', classKey: 'src/a.ts#A', scopes: [] }]);
    expect(r.cls).toEqual([{ type: 'layerScopes', classKey: 'src/b.ts#B', scopes: [] }]);
  });

  it('FR-7.5 / FR-7.11 / FR-12.12 / FR-12.14 / FR-16.11 / FR-19.10 / FR-25.3 intents that need a diagram do nothing without one (no write, no post)', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink);
    const ep = { kind: 'http' as const, label: 'GET /orders', method: { key: 'src/a.ts#A.get', name: 'get', owner: { key: 'src/a.ts#A', name: 'A', kind: 'class' as const }, isStatic: false, hasBody: true } };
    const finding = { id: 'f1', kind: 'god-class' as const, title: 'God class: A' };
    await c.onSequenceMessage({ type: 'restoreSettings' });
    await c.onSequenceMessage({ type: 'useSharedConfig', on: true });
    await c.onSequenceMessage({ type: 'switchEntryPointsProject' });
    await c.onSequenceMessage({ type: 'savePositions', rootKey: 'src/a.ts#A.get', positions: { x: 1 } });
    await c.onSequenceMessage({ type: 'setLayer', classKey: 'src/a.ts#A', className: 'A', layer: 'Domain' });
    await c.onSequenceMessage({ type: 'ignoreFinding', pattern: 'A' });
    await c.onSequenceMessage({ type: 'ignoreLayerHint', pattern: 'src/**' });
    await c.onSequenceMessage({ type: 'unignoreFinding', pattern: 'A' });
    await c.onSequenceMessage({ type: 'openDependencyRule' });
    await c.onSequenceMessage({ type: 'openMethod', methodKey: 'src/a.ts#A.get' });
    await c.onSequenceMessage({ type: 'openFinding', entryPoint: ep, finding });
    await c.onSequenceMessage({ type: 'focusClass', classKey: 'src/a.ts#A' }); // the class view is closed
    await c.onClassMessage({ type: 'setLayer', classKey: 'src/a.ts#A', className: 'A', layer: 'Domain' });
    await c.onClassMessage({ type: 'ignoreFinding', pattern: 'A' });
    await c.onClassMessage({ type: 'ignoreLayerHint', pattern: 'src/**' });
    await c.onClassMessage({ type: 'unignoreLayerHint', pattern: 'src/**' });
    await c.onClassMessage({ type: 'openDependencyRule' });
    await c.onClassMessage({ type: 'openFinding', entryPoint: ep, finding });
    await c.onClassMessage({ type: 'revealRelation', from: 'src/a.ts#A', to: 'src/b.ts#B', fallback: { file: '/x/a.ts', start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } });
    await c.onClassMessage({ type: 'setTypeUses', value: true });
    expect(r.seq).toEqual([]);
    expect(r.cls).toEqual([]);
    expect(r.other).toEqual([]);
  });

  it('FR-12.17 / FR-26.5 / FR-26.8 messages between the views: focusClass and the codebase map reach an open class view', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink);
    await c.onClassMessage({ type: 'ready' });
    r.cls.length = 0;
    await c.onSequenceMessage({ type: 'focusClass', classKey: 'src/a.ts#A' });
    await c.onSequenceMessage({ type: 'openAppMap', entryPoints: ['http|GET /a|src/a.ts#A.get'] });
    await c.onSequenceMessage({ type: 'openAppMap', entryPoints: [] }); // an empty selection: all
    expect(r.cls).toEqual([
      { type: 'focusClass', classKey: 'src/a.ts#A' },
      { type: 'showAppMap', entryPoints: ['http|GET /a|src/a.ts#A.get'] },
      { type: 'showAppMap' },
    ]);
    expect(r.other).toEqual([{ kind: 'showClassDiagram' }, { kind: 'showClassDiagram' }]);
    // closed again: focusClass is dropped, the map waits for the next ready (the empty selection: all)
    c.classViewClosed();
    await c.onSequenceMessage({ type: 'focusClass', classKey: 'src/a.ts#A' });
    await c.onSequenceMessage({ type: 'openAppMap', entryPoints: [] });
    expect(r.cls).toHaveLength(3);
    await c.onClassMessage({ type: 'ready' });
    expect(r.cls.slice(3)).toEqual([{ type: 'showAppMap' }, { type: 'empty', reason: 'Open a sequence diagram first ("Show Sequence Diagram").' }]);
    // shown once: a later ready does not show the map again
    await c.onClassMessage({ type: 'ready' });
    expect(r.cls.slice(5)).toEqual([{ type: 'empty', reason: 'Open a sequence diagram first ("Show Sequence Diagram").' }]);
  });

  it('FR-12.9 / FR-23.4 / FR-25.1 host-side actions from the views: logs, images, navigation, highlights, find in the flow', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink);
    const range = { file: '/w/src/a.ts', start: { line: 2, character: 0 }, end: { line: 2, character: 5 } };
    await c.onSequenceMessage({ type: 'log', level: 'error', message: 'view broke' });
    await c.onClassMessage({ type: 'log', level: 'info', message: 'class view ok' });
    await c.onSequenceMessage({ type: 'saveImage', name: 'flow.svg', format: 'svg', data: '<svg/>' });
    await c.onClassMessage({ type: 'saveImage', name: 'classes.png', format: 'png', data: 'AAAA' });
    await c.onClassMessage({ type: 'navigate', range });
    expect(r.other).toEqual([
      { kind: 'log:error', arg: 'view broke' },
      { kind: 'log:info', arg: 'class view ok' },
      { kind: 'log:info', arg: 'image flow.svg: saved by the page' },
      { kind: 'log:info', arg: 'image classes.png: saved by the page' },
      { kind: 'navigate', arg: range },
    ]);
    await c.onClassMessage({ type: 'highlightMessages', messageIds: [] });
    await c.onClassMessage({ type: 'highlightMessages', messageIds: ['root/1:b', 'root/2:b'] });
    await c.onClassMessage({ type: 'findInFlow', query: 'save' });
    // a class method row's Paths to here: the sequence view opens it
    await c.onClassMessage({ type: 'openInSequence', panel: 'paths', messageId: 'root/1:b' });
    expect(r.seq).toEqual([
      { type: 'highlight', messageId: null, messageIds: [] },
      { type: 'highlight', messageId: 'root/1:b', messageIds: ['root/1:b', 'root/2:b'] },
      { type: 'openFind', query: 'save' },
      { type: 'openPanel', panel: 'paths', messageId: 'root/1:b' },
    ]);
  });

  it('FR-2.4 the caret moves before any diagram: nothing to highlight', async () => {
    const r = recordingSink();
    const c = new HeadlessController(r.sink);
    await c.caretMoved('/w/src/a.ts', { line: 1, character: 1 });
    expect(r.seq).toEqual([]);
    await c.dispose();
  });
});
