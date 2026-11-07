import { describe, expect, it } from 'vitest';
import type { EntryPoint } from '@seqcall/protocol';
import { DEFAULT_TSCONFIG, tsProject } from './ts-project';

// FR-16.6 / FR-16.7 client routes and render roots of React apps, for the less common shapes (also mid-edit code).

const pkg = (name: string, dts: string, file = 'index.d.ts') => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({ name, types: 'index.d.ts' }),
  [`node_modules/${name}/${file}`]: dts,
});

const STUBS = {
  ...pkg('react', 'export function lazy<T>(load: () => Promise<{ default: T }>): T;\nexport function memo<T>(c: T): T;\nexport function createElement(c: unknown): unknown;\nexport const StrictMode: (p: { children?: unknown }) => unknown;\n'),
  ...pkg('react-dom', 'export function render(element: unknown, container: unknown): void;\nexport function hydrateRoot(container: unknown, element: unknown): void;\n'),
  'node_modules/react-dom/client.d.ts': 'export interface Root { render(children: unknown): void; }\nexport function createRoot(container: unknown): Root;\nexport function hydrateRoot(container: unknown, children: unknown): Root;\n',
  ...pkg('react-router-dom', 'export function Route(props: { path?: string; element?: unknown; children?: unknown }): unknown;\n'),
  ...pkg('@tanstack/react-router', 'export function createFileRoute(path: string): (opts: object) => unknown;\nexport function createRoute(opts: object): unknown;\n'),
};

const PAGES = `import { memo } from 'react';
export function Home() { return <main />; }
export function About() { return <section />; }
export function Shop() { return <div />; }
export function Pick({ a }: { a: boolean }) { return a ? <b /> : <i />; }
export function Wrapper({ children }: { children?: unknown }) { return <>{children}</>; }
export class Store { load() { return 1; } }
export class Blank { render() { return null; } }
export default memo(About);
export const makePage = () => Home;
export const enum Paths { Help = '/help' }
export const ROUTES = { team: '/team', count: 3 };
`;

const show = (eps: EntryPoint[], kind: EntryPoint['kind']) => eps.filter((e) => e.kind === kind).map((e) => `${e.label} → ${e.method.key.split('#')[1]}`).sort();

describe('FR-16.6 TanStack Router code routes and file routes (TS)', () => {
  it('FR-16.6 paths join through getParentRoute (a `/` parent adds nothing); parents that are not routes, cycles and unknown paths give no page', async () => {
    const { adapter } = tsProject({
      ...STUBS,
      'src/pages.tsx': PAGES,
      'src/routes.tsx': `import { createFileRoute, createRoute } from '@tanstack/react-router';
import { Home, About, Shop, Pick } from './pages';
declare const ID: string;
declare const options: object;
declare const dynamic: string;
declare const routes: { parent: unknown };
export const fileByVar = createFileRoute(ID)({ component: Home });
export const fileOpts = createFileRoute('/opts')(options);
const root = createRoute({ path: '/', component: Home });
export const about = createRoute({ getParentRoute: () => root, path: 'about', component: About });
const layout = createRoute({ getParentRoute: () => root, id: 'layout' });
export const shop = createRoute({ getParentRoute: () => layout, path: '/shop/', component: Shop });
export const blockBody = createRoute({ getParentRoute: () => { return root; }, path: 'block', component: Pick });
export const fromMember = createRoute({ getParentRoute: () => routes.parent, path: 'member', component: Pick });
const notCall = root;
export const fromAlias = createRoute({ getParentRoute: () => notCall, path: 'alias', component: Pick });
export const byValue = createRoute({ getParentRoute: root as any, path: 'value', component: Pick });
const dyn = createRoute({ getParentRoute: () => root, path: dynamic, component: Shop });
export const underDynamic = createRoute({ getParentRoute: () => dyn, path: 'x', component: About });
const ping: any = createRoute({ getParentRoute: () => pong, path: 'ping', component: Shop });
const pong: any = createRoute({ getParentRoute: () => ping, path: 'pong', component: Shop });
export const optsVar = createRoute(options);
export function make(parent: unknown) { return createRoute({ getParentRoute: () => parent, path: 'param', component: Pick }); }
`,
      // not imported from the router (mid-edit): no route
      'src/other.tsx': "import { Home } from './pages';\nexport const u = createRoute({ getParentRoute: () => u, path: '/unimported', component: Home });\n",
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } });
    expect(show(await adapter.getEntryPoints(), 'route')).toEqual([
      '/ → <module>.Home',
      '/about → <module>.About',
      '/alias → <module>.Pick',
      '/block → <module>.Pick',
      '/member → <module>.Pick',
      '/param → <module>.Pick',
      '/shop → <module>.Shop',
      '/value → <module>.Pick',
    ]);
  });
});

describe('FR-16.6 route objects and <Route> elements (TS)', () => {
  it('FR-16.6 paths from constants (const, object member, enum member), templates with unknown parts; a computed path is no page; nesting under an unknown or path-less parent', async () => {
    const { adapter } = tsProject({
      ...STUBS,
      'src/pages.tsx': PAGES,
      'src/objects.tsx': `import { Home, About, Shop, Pick, Paths, ROUTES } from './pages';
declare function compute(): string;
declare const cfg: { base: string };
const BASE = '/base';
export const table = [
  { path: BASE, element: <Home /> },
  { path: ROUTES.team, element: <About /> },
  { path: Paths.Help, element: <Shop /> },
  { path: ROUTES.count, element: <Pick a /> },
  { path: \`/t/\${compute()}/\${cfg.base}/\${BASE}\`, element: <Home /> },
  { path: compute(), element: <About />, children: [{ path: 'under-computed', element: <Shop /> }] },
  { element: <Home />, children: [{ path: 'no-parent-path', element: <About /> }] },
  { path: '/a', element: <Home />, children: [{ element: <Shop />, children: [{ path: 'b', element: <Pick a /> }] }] },
];
export const single = { path: '/single', element: <Pick a /> };
`,
      'src/jsx.tsx': `import { Route } from 'react-router-dom';
import { Home, About, Shop } from './pages';
declare function compute(): string;
export function Routes2() {
  return (
    <>
      <Route path={compute()} element={<Home />} />
      <Route path={compute()}><Route path="under" element={<About />} /></Route>
      <Route element={<Shop />} />
      <Route path="/empty" element={} />
      <Route path="/bare" element=<About /> />
    </>
  );
}
`,
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } });
    expect(show(await adapter.getEntryPoints(), 'route')).toEqual([
      '/ → <module>.Shop',
      '/a → <module>.Home',
      // under a path-less layout route (no page of its own): still under /a
      '/a/b → <module>.Pick',
      // an element given without braces
      '/bare → <module>.About',
      '/base → <module>.Home',
      '/help → <module>.Shop',
      '/no-parent-path → <module>.About',
      '/single → <module>.Pick',
      '/t/{…}/{base}//base → <module>.Home',
      '/team → <module>.About',
      '/under → <module>.About',
      '/under-computed → <module>.Shop',
      '/{count} → <module>.Pick',
    ]);
  });
});

describe('FR-16.6 / FR-16.7 which component a page or root shows (TS)', () => {
  it('FR-16.6 pages: a fragment\'s content, a memo default export, a lazy re-export; not a DOM element, a React.* element, a class without render JSX, a string, a call without a component, a wrapper cycle, a lazy load without import, of a missing or default-less module', async () => {
    const { adapter } = tsProject({
      ...STUBS,
      'src/pages.tsx': PAGES,
      'src/reexport.tsx': "export { Shop as default } from './pages';\n",
      'src/nodefault.tsx': 'export const x = 1;\n',
      'src/routes.tsx': `import { lazy } from 'react';
import AboutMemo, { Home, Shop, Wrapper, Store, Blank, makePage } from './pages';
declare const React: { Fragment: (p: object) => unknown };
declare function wrap<T>(c: T): T;
declare function loadPage(): Promise<{ default: () => unknown }>;
const Cyc1: any = wrap(Cyc2);
const Cyc2: any = wrap(Cyc1);
const Made = makePage();
const Lazy1 = lazy(() => import('./reexport'));
const Lazy2 = lazy(() => loadPage());
const Lazy3 = lazy(() => import('./missing'));
const Lazy4 = lazy(() => import('./nodefault'));
const component = Home;
export const table = [
  { path: '/frag', element: <Wrapper><><Shop /></></Wrapper> },
  { path: '/memo', element: <AboutMemo /> },
  { path: '/lazy-reexport', element: <Lazy1 /> },
  { path: '/shorthand', component },
  { path: '/dom', element: <div>text</div> },
  { path: '/react', element: <React.Fragment /> },
  { path: '/around-react', element: <Wrapper><React.Fragment /></Wrapper> },
  { path: '/around-dom', element: <Shop><div /></Shop> },
  { path: '/store', component: Store },
  { path: '/blank', component: Blank },
  { path: '/string', component: 'Home' },
  { path: '/made', element: <Made /> },
  { path: '/cycle', element: <Cyc1 /> },
  { path: '/lazy-call', element: <Lazy2 /> },
  { path: '/lazy-missing', element: <Lazy3 /> },
  { path: '/lazy-nodefault', element: <Lazy4 /> },
];
export function withParam(Page: () => unknown) { return [{ path: '/param', component: Page }]; }
`,
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } });
    expect(show(await adapter.getEntryPoints(), 'route')).toEqual([
      // a DOM element or a React.* element inside a component: the component is the page
      '/around-dom → <module>.Shop',
      '/around-react → <module>.Wrapper',
      '/frag → <module>.Shop',
      '/lazy-reexport → <module>.Shop',
      '/memo → <module>.About',
      '/shorthand → <module>.Home',
    ]);
  });

  it('FR-16.7 render roots: `render` imported from react-dom; an anonymous class component; not createElement, not hydrateRoot through a namespace; container labels', async () => {
    const { adapter } = tsProject({
      ...STUBS,
      'src/pages.tsx': PAGES,
      'src/anon.tsx': 'export default class { render() { return <p />; } }\n',
      'src/main.tsx': `import { render } from 'react-dom';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import Anon from './anon';
import { Home, About, Shop } from './pages';
declare const someVeryLongContainerVariableNameThatGoesOnAndOn: { element: unknown };
declare const dom: { find(sel: string): unknown };
declare const container: unknown;
render(<Home />, document.querySelector('.home'));
render(<Anon />, document.body.appendChild(document.createElement('div')));
createRoot(someVeryLongContainerVariableNameThatGoesOnAndOn.element).render(<About />);
createRoot(document.getElementById('x')).render(createElement(Shop));
ReactDOM.hydrateRoot(document.getElementById('y'), <Shop />);
render(<Shop />, dom.find('#main'));
render(<About />, container);
`,
    }, { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve', lib: ['ES2022', 'DOM'] } });
    expect(show(await adapter.getEntryPoints(), 'ui')).toEqual([
      '.home → <module>.Home',
      'container → <module>.About',
      'document.body.appendChild(document.crea… → default.render',
      "dom.find('#main') → <module>.Shop",
      'someVeryLongContainerVariableNameThatGo… → <module>.About',
    ]);
  });

  it('FR-1.20 a namespaced JSX tag (`<svg:rect />`) renders no component', async () => {
    const { adapter, method } = tsProject({ ...STUBS, 'src/pages.tsx': PAGES, 'src/icon.tsx': "import { Home } from './pages';\nexport function Icon() { return <g><svg:rect /><Home /></g>; }\n" },
      { compilerOptions: { ...DEFAULT_TSCONFIG.compilerOptions, jsx: 'preserve' } });
    const calls = await adapter.getOutgoingCalls(await method('src/icon.tsx#<module>.Icon'));
    expect(calls.map((c) => [c.methodName, c.render ?? false])).toEqual([['Home', true]]);
  });
});
