import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-react-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], strict: false, jsx: 'preserve', moduleResolution: 'node' }, include: ['src'] }));
// the hooks come from a library, as in a real app
write('node_modules/react/package.json', JSON.stringify({ name: 'react', types: 'index.d.ts' }));
write('node_modules/react/index.d.ts', `export function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
export function useCallback<T extends Function>(fn: T, deps: unknown[]): T;
`);
write('src/store.ts', `export class EligibilityStore {
  clear(): void {}
  async fetchStatus(id: string): Promise<void> {}
}
export function useEligibilityStore(): EligibilityStore { return new EligibilityStore(); }
`);
write('src/list.tsx', `import { useCallback, useEffect } from 'react';
import { useEligibilityStore } from './store';
export function List({ id }: { id: string }) {
  const { clear, fetchStatus } = useEligibilityStore();
  useEffect(() => { void fetchStatus(id); }, [id]);
  useEffect(() => { clear(); }, []);
  useEffect(() => { clear(); });
  const onClose = useCallback(() => { clear(); }, []);
  useEffect(() => {
    const t = setInterval(() => { void fetchStatus(id); }, 5000);
    window.addEventListener('resize', () => clear());
    return () => clearInterval(t);
  }, [id]);
  return <button onClick={onClose} />;
}
`);
// handlers given to JSX props
write('src/join.tsx', `import { useCallback } from 'react';
import { useEligibilityStore } from './store';
export function Join({ id, onDone }: { id: string; onDone: () => void }) {
  const store = useEligibilityStore();
  const onReset = () => { store.clear(); };
  function onRetry() { void store.fetchStatus(id); }
  const onMemo = useCallback(() => { store.clear(); }, []);
  return (
    <div>
      <button onClick={async () => { await store.fetchStatus(id); }} />
      <button onMouseEnter={onReset} />
      <button onClick={onReset} />
      <a onClick={onRetry} />
      <a onClick={onMemo} />
      <a onClick={onDone} />
    </div>
  );
}
`);
// FR-1.20 child components: function, wrapped (observer / memo, default export), class, library and DOM elements
write('node_modules/mobx-react/package.json', JSON.stringify({ name: 'mobx-react', types: 'index.d.ts' }));
write('node_modules/mobx-react/index.d.ts', 'export function observer<T>(c: T): T;\n');
write('node_modules/router-lib/package.json', JSON.stringify({ name: 'router-lib', types: 'index.d.ts' }));
write('node_modules/router-lib/index.d.ts', 'export function Link(props: { to: string }): unknown;\n');
write('src/panel.tsx', `import { useEligibilityStore } from './store';
export function Panel({ id }: { id: string }) {
  useEligibilityStore().clear();
  return <div>{id}</div>;
}
`);
write('src/badge.tsx', `import { observer } from 'mobx-react';
function _Badge() { return <span />; }
export const Badge = observer(_Badge);
`);
write('src/footer.tsx', `import { memo } from 'react';
function Footer() { return <p />; }
export default memo(Footer);
`);
write('src/legacy.tsx', `export class Legacy { render() { return <i />; } }
`);
write('src/page.tsx', `import { Link } from 'router-lib';
import { Panel } from './panel';
import { Badge } from './badge';
import Footer from './footer';
import { Legacy } from './legacy';
const helper = () => 1;
export function Page({ open, rest }: { open: boolean; rest: object }) {
  return (
    <div>
      <Panel id="1" {...rest} />
      {open && <Badge />}
      {[1, 2].map((n) => <Legacy key={n} />)}
      <Link to="/home" />
      <Footer />
    </div>
  );
}
`);
// FR-1.20 / FR-19.1 I/O in a handler written inside a loop runs on a click; a loop inside a handler is N+1 on that click
write('src/api.ts', `export class Api {
  async remove(id: number): Promise<void> { await fetch('/items/' + id, { method: 'DELETE' }); }
}
export const api = new Api();
`);
write('src/rows.tsx', `import { api } from './api';
export function Rows({ ids }: { ids: number[] }) {
  return (
    <ul>
      {ids.map((id) => <li key={id} onClick={() => api.remove(id)} />)}
      <button onClick={() => ids.forEach((id) => api.remove(id))} />
    </ul>
  );
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('React components (FR-6.5, FR-1.11, FR-1.20)', () => {
  const open = async () => {
    const adapter = createTsAdapter(root);
    return (await new DiagramSession({ adapter, classifier: createClassifier(root) }).openMethodByKey('src/list.tsx#<module>.List'))!;
  };

  it('FR-6.5 functions destructured from one store are calls on that store: one lifeline', async () => {
    const d = await open();
    const stores = d.participants.filter((p) => p.className === 'EligibilityStore');
    expect(stores).toHaveLength(1);
    const calls = d.messages.filter((m) => m.methodName === 'clear' || m.methodName === 'fetchStatus');
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(calls.map((m) => m.to))).toEqual(new Set([stores[0].id]));
  });

  it('FR-1.11 callback frames say when they run: effect dependencies, useCallback, timers, DOM events', async () => {
    const d = await open();
    const guards = (d.fragments ?? []).filter((f) => f.kind === 'callback').map((f) => f.operands[0].guard);
    expect(guards).toEqual([
      'useEffect: when id changes',
      'useEffect: on mount',
      'useEffect: after every render',
      'useCallback: when called',
      'useEffect: when id changes',
      'setInterval: every 5000 ms',
      'window.addEventListener: on resize',
    ]);
  });

  it('FR-1.11 handlers given to JSX props are drawn there: inline, or a local function passed by name (once)', async () => {
    const adapter = createTsAdapter(root);
    const d = (await new DiagramSession({ adapter, classifier: createClassifier(root) }).openMethodByKey('src/join.tsx#<module>.Join'))!;
    const guards = (d.fragments ?? []).filter((f) => f.kind === 'callback').map((f) => f.operands[0].guard);
    expect(guards).toEqual([
      'useCallback: when called',
      'button onClick: on click', // inline lambda
      'button onMouseEnter: on mouse enter', // const onReset = () => …, drawn at its first prop only
      'a onClick: on click', // function onRetry() {…}
    ]);
    // the calls inside them are in the diagram (before: skipped, while Callers listed the component as the caller)
    expect(d.messages.filter((m) => m.methodName === 'fetchStatus')).toHaveLength(2);
    expect(d.messages.filter((m) => m.methodName === 'clear')).toHaveLength(2); // onReset once, useCallback once
  });

  const openPage = async () => {
    const adapter = createTsAdapter(root);
    const session = new DiagramSession({ adapter, classifier: createClassifier(root) });
    return { adapter, session, d: (await session.openMethodByKey('src/page.tsx#<module>.Page'))! };
  };

  it('FR-1.20 a project component in JSX is a render message named by its tag, props as arguments; DOM and library elements are not', async () => {
    const { d } = await openPage();
    const renders = d.messages.filter((m) => m.render);
    expect(renders.map((m) => m.methodName)).toEqual(['Panel', 'Badge', 'Legacy', 'Footer']);
    expect(renders[0].args).toEqual(['id', '...rest']);
    expect(renders[0].expandable).toBe(true);
    // through observer(_Badge) / memo(Footer) to the function that renders; a class component to its render
    expect(renders.map((m) => m.methodKey)).toEqual([
      'src/panel.tsx#<module>.Panel',
      'src/badge.tsx#<module>._Badge',
      'src/legacy.tsx#Legacy.render',
      'src/footer.tsx#<module>.Footer',
    ]);
    expect(d.messages.some((m) => m.methodName === 'Link' || m.methodName === 'helper')).toBe(false);
  });

  it('FR-1.20 `cond && <X />` is an opt frame, an element in a .map a loop; expanding a render shows the child\'s calls', async () => {
    const { session, d } = await openPage();
    const frame = (name: string) => {
      const id = d.messages.find((m) => m.methodName === name)!.id;
      return (d.fragments ?? []).find((f) => f.operands.some((o) => o.firstMessageId === id && o.lastMessageId === id));
    };
    expect(frame('Badge')).toMatchObject({ kind: 'opt', operands: [{ guard: 'open' }] });
    expect(frame('Legacy')).toMatchObject({ kind: 'loop' });
    const panel = d.messages.find((m) => m.methodName === 'Panel')!;
    const expanded = (await session.expand(panel.id))!;
    expect(expanded.messages.filter((m) => m.parentId === panel.id).map((m) => m.methodName)).toEqual(['useEligibilityStore', 'clear']);
  });

  it('FR-1.20 Show callers of a component: the elements that render it, also through observer(…) and export default memo(…)', async () => {
    const { adapter } = await openPage();
    const callers = async (key: string) => (await adapter.getCallers((await adapter.getMethod(key))!)).map((c) => `${c.enclosing.name}: ${c.preview}`);
    expect(await callers('src/panel.tsx#<module>.Panel')).toEqual(['Page: <Panel id="1" {...rest} />']);
    expect(await callers('src/badge.tsx#<module>._Badge')).toEqual(['Page: {open && <Badge />}']);
    expect(await callers('src/footer.tsx#<module>.Footer')).toEqual(['Page: <Footer />']);
  });

  it('FR-1.20 I/O in a loop: not for a handler written inside the loop (runs on a click), yes for a loop inside a handler', async () => {
    const adapter = createTsAdapter(root);
    const session = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await session.openMethodByKey('src/rows.tsx#<module>.Rows');
    const d = (await session.scanSideEffects()) ?? session.current()!;
    const removes = d.messages.filter((m) => m.methodName === 'remove');
    expect(removes).toHaveLength(2);
    expect(removes.every((m) => m.sideEffects?.kinds.includes('http'))).toBe(true);
    const io = (d.findings ?? []).filter((f) => f.kind === 'io-in-loop');
    expect(io.map((f) => f.messageIds)).toEqual([[removes[1].id]]);
  });
});
