import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { EntryPoint } from '@seqcall/protocol';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-react-ep-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', lib: ['ES2022', 'DOM'], strict: false, jsx: 'preserve', moduleResolution: 'node' }, include: ['src', 'features'] }));
// the libraries as stubs, as in a real app
write('node_modules/react/package.json', JSON.stringify({ name: 'react', types: 'index.d.ts' }));
write('node_modules/react/index.d.ts', `export function lazy<T>(load: () => Promise<{ default: T }>): T;
export function Suspense(props: { fallback?: unknown; children?: unknown }): unknown;
export function memo<T>(c: T): T;
`);
write('node_modules/react-dom/package.json', JSON.stringify({ name: 'react-dom', types: 'index.d.ts' }));
write('node_modules/react-dom/index.d.ts', 'export function render(element: unknown, container: Element | null): void;\n');
write('node_modules/react-dom/client.d.ts', `export interface Root { render(children: unknown): void; }
export function createRoot(container: Element | null): Root;
export function hydrateRoot(container: Element | null, children: unknown): Root;
`);
write('node_modules/react-router-dom/package.json', JSON.stringify({ name: 'react-router-dom', types: 'index.d.ts' }));
write('node_modules/react-router-dom/index.d.ts', `export function createBrowserRouter(routes: unknown[]): unknown;
export function RouterProvider(props: { router: unknown }): unknown;
export function Navigate(props: { to: string }): unknown;
export function Routes(props: { children?: unknown }): unknown;
export function Route(props: { path?: string; element?: unknown; index?: boolean; children?: unknown }): unknown;
`);
write('node_modules/mobx-react/package.json', JSON.stringify({ name: 'mobx-react', types: 'index.d.ts' }));
write('node_modules/mobx-react/index.d.ts', 'export function observer<T>(c: T): T;\n');

write('src/pages.tsx', `import { observer } from 'mobx-react';
export function Layout() { return <main />; }
export function OrderList() { return <ul />; }
export function OrderPage() { return <div />; }
export function Home() { return <h1 />; }
export function Preview() { return <h2 />; }
function _Account() { return <form />; }
export const Account = observer(_Account);
export class Legacy { render() { return <p />; } }
export function Header() { return <header />; }
export function GlobalProvider({ children }: { children?: unknown }) { return <>{children}</>; }
export function Guard({ children }: { children?: unknown }) { return <>{children}</>; }
export function Icon() { return null; }
export default function Reports() { return <table />; }
`);
write('src/deals.tsx', `export function Deals() { return <section />; }\n`);
// react-router: route objects, relative children, an index route, lazy pages, a redirect
write('src/router.tsx', `import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { Layout, OrderList, OrderPage } from './pages';
const LazyReports = lazy(() => import('./pages'));
const LazyDeals = lazy(() => import('./deals').then((m) => ({ default: m.Deals })));
export const router = createBrowserRouter([
  {
    path: '/orders',
    element: <Layout />,
    children: [
      { index: true, element: <OrderList /> },
      { path: ':id', element: <Suspense fallback={null}><OrderPage /></Suspense> },
    ],
  },
  { path: '/reports', Component: LazyReports },
  { path: '/deals', element: <LazyDeals /> },
  { path: '*', element: <Navigate to="/orders" /> },
]);
`);
// an app's own route table: absolute children, template paths, wrapped and conditional components
write('src/appRoutes.tsx', `import { Account, Home, Legacy, Preview, Icon } from './pages';
const settings = { accountPath: '/members' };
const preview = Math.random() > 0.5;
export function accountRoutes() {
  const { accountPath } = settings;
  return [
    {
      path: \`\${accountPath}\`,
      component: Account,
      routes: [{ path: \`\${accountPath}/legacy\`, component: Legacy }],
    },
    { path: '/', component: preview ? Preview : Home },
  ];
}
// a menu config has a path too, its icon renders no JSX: not a route
export const MENU = [{ path: '/help', component: Icon }];
`);
// react-router JSX
write('src/jsxRoutes.tsx', `import { Routes, Route } from 'react-router-dom';
import { OrderList, OrderPage, Guard } from './pages';
export function Shop() {
  return (
    <Routes>
      <Route path="/shop" element={<OrderList />}>
        <Route path="items/:id" element={<Guard><OrderPage /></Guard>} />
      </Route>
    </Routes>
  );
}
`);
// render roots
write('src/main.tsx', `import { createRoot, hydrateRoot } from 'react-dom/client';
import ReactDOM from 'react-dom';
import { RouterProvider } from 'react-router-dom';
import { GlobalProvider, Header, Account, Legacy } from './pages';
import { router } from './router';
const root = createRoot(document.querySelector('#cart-app'));
root.render(<GlobalProvider><Header /></GlobalProvider>);
createRoot(document.getElementById('account')).render(<Account />);
createRoot(document.getElementById('app')).render(<GlobalProvider><RouterProvider router={router} /></GlobalProvider>);
hydrateRoot(document.getElementById('legacy'), <Legacy />);
ReactDOM.render(<Header />, document.getElementById('old-header'));
const view = { render(x: unknown) { return x; } };
view.render(<Header />);
`);
// Cucumber step definitions are test code (route tables of a memory router there are not the app's)
write('features/step-definitions/orders.tsx', `import { OrderPage } from '../../src/pages';
export const routes = [{ path: '/test-only', element: <OrderPage /> }];
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const list = () => createTsAdapter(root).getEntryPoints!();
const rows = (eps: EntryPoint[], kind: EntryPoint['kind']) => eps.filter((e) => e.kind === kind).map((e) => `${e.label} → ${e.method.key.split('#')[1]}`);

describe('React entry points (FR-16.6, FR-16.7)', () => {
  it('FR-16.6 react-router route objects: nested paths, index routes, lazy pages; redirects are not pages', async () => {
    const routes = rows(await list(), 'route');
    expect(routes).toEqual(expect.arrayContaining([
      '/orders → <module>.Layout',
      '/orders → <module>.OrderList', // index route
      '/orders/:id → <module>.OrderPage', // relative child, through <Suspense>
      '/reports → <module>.Reports', // lazy(() => import('./pages')): the default export
      '/deals → <module>.Deals', // lazy(…then((m) => ({ default: m.Deals })))
    ]));
    expect(routes.some((r) => r.startsWith('/* '))).toBe(false);
  });

  it('FR-16.6 an app\'s own route tables: template paths, absolute children, observer() and class components, both pages of a condition', async () => {
    const routes = rows(await list(), 'route');
    expect(routes).toEqual(expect.arrayContaining([
      '/{accountPath} → <module>._Account', // observer(_Account) → the inner function
      '/{accountPath}/legacy → Legacy.render', // already starts with its parent's path: not joined twice
      '/ → <module>.Preview',
      '/ → <module>.Home',
    ]));
    // a menu entry whose component renders no JSX; step definitions are test code
    expect(routes.some((r) => r.startsWith('/help') || r.startsWith('/test-only'))).toBe(false);
  });

  it('FR-16.6 <Route> elements: nested paths join, the page inside a wrapper', async () => {
    const routes = rows(await list(), 'route');
    expect(routes).toEqual(expect.arrayContaining(['/shop → <module>.OrderList', '/shop/items/:id → <module>.OrderPage']));
    expect(routes.some((r) => r.endsWith('Guard'))).toBe(false);
  });

  it('FR-16.7 render roots: the container and the component inside the providers; router-only roots and other render() calls are not listed', async () => {
    const eps = await list();
    expect(rows(eps, 'ui').sort()).toEqual([
      '#account → <module>._Account',
      '#cart-app → <module>.Header', // createRoot through a variable, inside <GlobalProvider>
      '#legacy → Legacy.render', // hydrateRoot(container, element)
      '#old-header → <module>.Header', // ReactDOM.render(element, container)
    ]);
    const header = eps.find((e) => e.kind === 'ui' && e.label === '#cart-app')!;
    expect(header.detail).toBe('render root (src/main.tsx)');
  });

  it('FR-16.6 pages and UI roots come right after HTTP endpoints, before programs', async () => {
    const kinds = [...new Set((await list()).map((e) => e.kind))];
    expect(kinds.indexOf('route')).toBeLessThan(kinds.indexOf('ui'));
    expect(kinds.filter((k) => k !== 'route' && k !== 'ui').every((k) => kinds.indexOf(k) > kinds.indexOf('ui'))).toBe(true);
  });
});
