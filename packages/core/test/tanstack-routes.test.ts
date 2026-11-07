import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-tanstack-')).replace(/\\/g, '/');
const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
  fs.writeFileSync(`${root}/${rel}`, text);
};
write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', strict: false, jsx: 'preserve', moduleResolution: 'node' }, include: ['src'] }));
write('node_modules/@tanstack/react-router/package.json', JSON.stringify({ name: '@tanstack/react-router', types: 'index.d.ts' }));
write('node_modules/@tanstack/react-router/index.d.ts', `export function createFileRoute(path: string): (opts: object) => unknown;
export function createLazyFileRoute(path: string): (opts: object) => unknown;
export function createRootRoute(opts: object): unknown;
export function createRoute(opts: object): unknown;
`);
// as a React front end: file routes under a pathless layout, a layout with only beforeLoad, a nested admin layout
write('src/pages.tsx', `export function HomePage() { return <main />; }
export function LoginPage() { return <form />; }
export function UsersPage() { return <table />; }
export function PostPage() { return <article />; }
export function AdminLayout() { return <section />; }
export function Root() { return <div />; }
export const notAComponent = { title: 'x' };
`);
write('src/routes/__root.tsx', `import { createRootRoute } from '@tanstack/react-router';
import { Root } from '../pages';
export const Route = createRootRoute({ component: Root });
`);
write('src/routes/_authed.tsx', `import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/_authed')({ beforeLoad: () => undefined });
`);
write('src/routes/_authed/index.tsx', `import { createFileRoute } from '@tanstack/react-router';
import { HomePage } from '../../pages';
export const Route = createFileRoute('/_authed/')({ component: HomePage });
`);
write('src/routes/_authed/_admin.tsx', `import { createFileRoute } from '@tanstack/react-router';
import { AdminLayout } from '../../pages';
export const Route = createFileRoute('/_authed/_admin')({ component: AdminLayout });
`);
write('src/routes/_authed/_admin/users.tsx', `import { createFileRoute } from '@tanstack/react-router';
import { UsersPage } from '../../../pages';
export const Route = createFileRoute('/_authed/_admin/users')({ loader: () => [], component: UsersPage });
`);
write('src/routes/(public)/login.tsx', `import { createLazyFileRoute } from '@tanstack/react-router';
import { LoginPage } from '../../pages';
export const Route = createLazyFileRoute('/(public)/login')({ component: LoginPage });
`);
// code-based routes: paths join through getParentRoute
write('src/code-routes.tsx', `import { createRootRoute, createRoute } from '@tanstack/react-router';
import { PostPage, Root } from './pages';
const rootRoute = createRootRoute({ component: Root });
const postsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'posts' });
export const postRoute = createRoute({ getParentRoute: () => postsRoute, path: '$postId', component: PostPage });
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-16.6 TanStack Router pages', () => {
  it('FR-16.6 file routes without pathless layout segments and route groups, a layout route by its own segment, code routes joined through getParentRoute; no page without a component, no root route', async () => {
    const routes = (await createTsAdapter(root).getEntryPoints!()).filter((e) => e.kind === 'route').map((e) => `${e.label} → ${e.method.name}`);
    expect(routes.sort()).toEqual([
      '/ → HomePage',
      '/_admin → AdminLayout',
      '/login → LoginPage',
      '/posts/$postId → PostPage',
      '/users → UsersPage',
    ]);
  });
});
