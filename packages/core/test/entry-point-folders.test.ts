import { describe, expect, it } from 'vitest';
import type { EntryOutcome, EntryPoint, EntryPointKind } from '@seqcall/protocol';
import type { EntryPointListNode } from '@seqcall/protocol';
import { displayRoute, entriesUnder, entryOutcomeTags, entryPointFolders, entryPointMatches, entryPointProjects, entryPointTree, FOLDER_ABOVE, sortForDisplay, type EntryPointTreeNode } from '../src/entry-point-folders';

const ep = (kind: EntryPointKind, label: string, key: string, owner: 'class' | 'module' = 'class'): EntryPoint =>
  ({ kind, label, method: { key, name: key.split('.').pop()!, owner: { key: key.split('.')[0], name: key.split('#')[1].split('.')[0], kind: owner } } }) as unknown as EntryPoint;

/** A tree level as compact strings: `[/api · 30]`, `GET /health`. */
const level = (nodes: EntryPointTreeNode[]) => nodes.map((n) => (n.type === 'folder' ? `[${n.label} · ${n.items.length}${n.leaf ? ' C' : ''}]` : n.type === 'file' ? `file ${n.file}` : n.entryPoint.label));
const http = (path: string, i: number) => ep('http', `GET ${path}`, `app/C${i}.php#C${i}.m`);

describe('one route format', () => {
  it('parameters lose their constraint and ?, as the webview writes them (the same cases as its test)', () => {
    expect(displayRoute('/v{version:apiVersion}/Providers/{providerId:long}/{slug?}/{*rest}')).toBe('/v{version}/Providers/{providerId}/{slug}/{*rest}');
    expect(displayRoute('GET /orders/{id}')).toBe('GET /orders/{id}');
  });
});

describe('FR-16.4 long entry-point groups in folders', () => {
  it('FR-16.4 up to FOLDER_ABOVE entries: a flat list, as before', () => {
    const list = Array.from({ length: FOLDER_ABOVE }, (_, i) => http(`/api/x${i}/y`, i));
    expect(level(entryPointFolders('http', list))).toEqual(list.map((e) => e.label));
  });

  it('FR-16.4 HTTP: by route segment; a chain of single folders is one, parameters are no folder, one entry is no folder, a level with one folder is skipped', () => {
    const list = [
      ...Array.from({ length: 12 }, (_, i) => http(`/api/v1/payments/p${i}`, i)),
      ...Array.from({ length: 14 }, (_, i) => http(`/api/v1/catalog/g${i}/{id}`, 100 + i)),
      http('/api/v1/health', 200),
      http('/api/v1/{tenant}/info', 201),
    ];
    // everything is under /api/v1: that level is skipped, its path kept for the folders below
    const top = entryPointFolders('http', list);
    expect(level(top)).toEqual(['[/catalog · 14]', '[/payments · 12]', 'GET /api/v1/health', 'GET /api/v1/{tenant}/info']); // loose entries in list order
    const catalog = top[0] as Extract<EntryPointTreeNode, { type: 'folder' }>;
    expect(catalog.path).toBe('/api/v1/catalog');
    // a folder of 25 or fewer is a flat list
    expect(level(entryPointFolders('http', catalog.items, catalog.depth, catalog.path))).toHaveLength(14);
  });

  it('FR-16.4 pages: a template part (`/{accountPath}/…`) is a folder like any segment, `:id` is no folder', () => {
    const page = (path: string, i: number) => ep('route', `ROUTE ${path}`, `src/P${i}.tsx#<module>.P${i}`, 'module');
    const list = [
      ...Array.from({ length: 20 }, (_, i) => page(`/{accountPath}/bank/b${i}`, i)),
      ...Array.from({ length: 8 }, (_, i) => page(`/{accountPath}/rewards/x${i}`, 50 + i)),
      page('/{accountPath}', 90),
      page('/events/:id', 91),
      page('/events/:id/stats', 92),
      page('/', 93),
    ].map((e) => ({ ...e, label: e.label.replace(/^ROUTE /, '') }));
    const top = entryPointFolders('route', list);
    expect(level(top)).toEqual(['[/{accountPath} · 29]', '[/events · 2]', '/']);
    const members = top[0] as Extract<EntryPointTreeNode, { type: 'folder' }>;
    expect(level(entryPointFolders('route', members.items, members.depth, members.path))).toEqual(['[/bank · 20]', '[/rewards · 8]', '/{accountPath}']);
  });

  it('FR-16.4 a parameter followed by more segments is a folder (`/shop/:shopId/…`); one that ends the route is not', () => {
    const page = (path: string, i: number) => ({ ...ep('route', path, `src/P${i}.tsx#<module>.P${i}`, 'module'), label: path });
    const list = [
      ...Array.from({ length: 24 }, (_, i) => page(`/shop/:shopId/t${i}/x`, i)),
      page('/shop/:shopId', 40),
      page('/shop/browse', 41),
      page('/shop/events/:eventId', 42),
      page('/shop/events/:eventId/stats', 43),
    ];
    const top = entryPointFolders('route', list);
    // everything is under /shop: that level is skipped
    expect(level(top)).toEqual(['[/:shopId · 24]', '[/events · 2]', '/shop/:shopId', '/shop/browse']);
    expect((top[0] as Extract<EntryPointTreeNode, { type: 'folder' }>).path).toBe('/shop/:shopId');
  });

  it('FR-16.4 a large folder is split again by its next segment', () => {
    const list = [...Array.from({ length: 20 }, (_, i) => http(`/api/catalog/a/x${i}`, i)), ...Array.from({ length: 20 }, (_, i) => http(`/api/catalog/b/x${i}`, 50 + i)), ...Array.from({ length: 10 }, (_, i) => http(`/internal/z${i}`, 100 + i))];
    const top = entryPointFolders('http', list);
    expect(level(top)).toEqual(['[/api/catalog · 40]', '[/internal · 10]']);
    const api = top[0] as Extract<EntryPointTreeNode, { type: 'folder' }>;
    expect(level(entryPointFolders('http', api.items, api.depth, api.path))).toEqual(['[/a · 20]', '[/b · 20]']);
  });

  it('FR-16.4 tests: by the folders of their file, then the class (a class is marked as such)', () => {
    const t = (file: string, cls: string, i: number) => ep('test', `${cls}.t${i}`, `${file}#${cls}.t${i}`);
    const list = [
      ...Array.from({ length: 20 }, (_, i) => t('tests/Unit/Payments/PayTest.php', 'PayTest', i)),
      ...Array.from({ length: 8 }, (_, i) => t('tests/Unit/Cache/CacheTest.php', 'CacheTest', i)),
      ...Array.from({ length: 3 }, (_, i) => t('tests/Feature/HomeTest.php', 'HomeTest', i)),
    ];
    const top = entryPointFolders('test', list);
    expect(level(top)).toEqual(['[Feature/HomeTest · 3 C]', '[Unit · 28]']);
    const unit = top[1] as Extract<EntryPointTreeNode, { type: 'folder' }>;
    expect(unit.path).toBe('tests/Unit');
    expect(level(entryPointFolders('test', unit.items, unit.depth, unit.path))).toEqual(['[Cache/CacheTest · 8 C]', '[Payments/PayTest · 20 C]']);
  });

  it('FR-16.5 programs keep their files: several module-level calls of one file stay under the file', () => {
    const calls = [ep('cli', 'src/a.ts: x()', 'src/a.ts#<module>.x', 'module'), ep('cli', 'src/a.ts: y()', 'src/a.ts#<module>.y', 'module')].map((e) => ({ ...e, file: 'src/a.ts' }));
    expect(level(entryPointFolders('cli', calls))).toEqual(['file src/a.ts']);
    // a program (no file) and a file with one call stay entries, in list order
    const main = ep('cli', 'Program.Main', 'src/Program.cs#Program.Main');
    const once = { ...ep('cli', 'src/b.ts: z()', 'src/b.ts#<module>.z', 'module'), file: 'src/b.ts' };
    expect(level(entryPointFolders('cli', [main, calls[0], once, calls[1]]))).toEqual(['Program.Main', 'file src/a.ts', 'src/b.ts: z()']);
  });

  it('FR-16.4 / FR-16.5 many module-level calls: folders by the file path, the file itself the last level', () => {
    const call = (file: string, i: number) => ({ ...ep('cli', `${file}: c${i}()`, `${file}#<module>.c${i}`, 'module'), file });
    const list = [...Array.from({ length: 20 }, (_, i) => call('src/jobs/nightly.ts', i)), ...Array.from({ length: 10 }, (_, i) => call('src/jobs/hourly.ts', 50 + i))];
    // everything is under src/jobs: skipped; each file is a folder of its own (a leaf)
    const top = entryPointFolders('cli', list);
    expect(level(top)).toEqual(['[hourly.ts · 10 C]', '[nightly.ts · 20 C]']);
    // inside a file folder (no more than FOLDER_ABOVE): the calls under their file
    const hourly = top[0] as Extract<EntryPointTreeNode, { type: 'folder' }>;
    expect(hourly.path).toBe('src/jobs/hourly.ts');
    expect(level(entryPointFolders('cli', hourly.items, hourly.depth, hourly.path))).toEqual(['file src/jobs/hourly.ts']);
  });

  it('FR-16.4 a long group where no two entries share a segment: a flat list', () => {
    const list = Array.from({ length: FOLDER_ABOVE + 1 }, (_, i) => http(`/r${i}/x`, i));
    expect(level(entryPointFolders('http', list))).toEqual(list.map((e) => e.label));
  });

  it('FR-16.8 several projects: applications first by name, the test projects together under Tests; one project: none', () => {
    const at = (project: string | undefined, kind: EntryPointKind, i: number) => ({ ...ep(kind, `${kind}${i}`, `a/F${i}.cs#F${i}.m`), ...(project ? { project } : {}) });
    const list = [at('WebPortal', 'http', 1), at('UnitTests.Api', 'test', 2), at('ShopApi', 'http', 3), at('ShopApi', 'cli', 4), at('IntegrationTests.Api', 'test', 5)];
    const p = entryPointProjects(list)!;
    expect(p.map((x) => `${x.name} ${x.items.length}${x.projects ? ` [${x.projects.map((y) => y.name).join(', ')}]` : ''}`)).toEqual(['ShopApi 2', 'WebPortal 1', 'Tests 2 [IntegrationTests.Api, UnitTests.Api]']);
    // a single test project stays a project of its own
    expect(entryPointProjects([at('Api', 'http', 1), at('Api.Tests', 'test', 2)])!.map((x) => x.name)).toEqual(['Api', 'Api.Tests']);
    expect(entryPointProjects([at(undefined, 'http', 1)])).toBeUndefined();
    // entries without a project (files outside every package) are in the root's project
    expect(entryPointProjects([at('Api', 'http', 1), at(undefined, 'cli', 2), at(undefined, 'http', 3)], 'shop')!.map((x) => `${x.name} ${x.items.length}`)).toEqual(['Api 1', 'shop 2']);
    expect(entryPointProjects([at('Api', 'http', 1), at(undefined, 'cli', 2)])!.map((x) => x.name)).toEqual(['Api', 'project']);
  });

  it('FR-16.9 search: every word somewhere in the route, Class.method, detail or project, any case', () => {
    const e = { ...ep('http', 'DELETE /api/shop/delete-product', 'ShopApi/C.cs#Shop2Controller.DeleteProduct'), detail: 'controller', project: 'ShopApi' };
    expect(['shop delete', 'SHOPAPI product', 'Shop2Controller.DeleteProduct', 'controller', '', '  ']).toEqual(['shop delete', 'SHOPAPI product', 'Shop2Controller.DeleteProduct', 'controller', '', '  '].filter((q) => entryPointMatches(e, q)));
    expect(entryPointMatches(e, 'shop create')).toBe(false);
    // without detail and project: only the route and the method count
    const bare = ep('http', 'GET /api/orders', 'Api/C.cs#OrdersController.List');
    expect(['orders list', 'undefined', 'controller'].map((q) => entryPointMatches(bare, q))).toEqual([true, false, true]);
  });

  it('FR-32.4 `has:` a kind of I/O (its name or its tag), `has:io` any; an entry point whose outcome is not known does not match; the tags of a row', () => {
    const e = ep('http', 'POST /api/orders', 'Api/C.cs#OrdersController.Create');
    const db: EntryOutcome = { kinds: ['db', 'queue'], atLeast: true };
    const outcomes = { 'http|POST /api/orders|Api/C.cs#OrdersController.Create': db };
    const q = ['has:db', 'HAS:MQ', 'has:queue', 'has:io', 'orders has:db', 'has:http', 'has:db has:file', 'list has:db'];
    expect(q.map((w) => entryPointMatches(e, w, outcomes))).toEqual([true, true, true, true, true, false, false, false]);
    expect(['has:io', 'orders'].map((w) => entryPointMatches(e, w))).toEqual([false, true]);
    expect([entryOutcomeTags(db), entryOutcomeTags({ kinds: ['http'] }), entryOutcomeTags({ kinds: [] }), entryOutcomeTags(undefined)]).toEqual(['DB·MQ+', 'HTTP', '', '']);
  });
});

describe('FR-16.4 one tree for both lists (the sidebar and the panel\'s ⌂ list)', () => {
  /** The tree as indented lines: `group http`, `  [/catalog]`, `    GET /api/catalog/g0`. */
  const lines = (nodes: EntryPointListNode[], list: EntryPoint[], pad = ''): string[] =>
    nodes.flatMap((n) => {
      if (n.type === 'entry') return [`${pad}${list[n.index].label}`];
      const head = n.type === 'project' ? `project ${n.name}${n.tests ? ' (tests)' : ''}` : n.type === 'group' ? `group ${n.kind}` : n.type === 'folder' ? `[${n.label}${n.leaf ? ' C' : ''}]` : `file ${n.file}`;
      return [`${pad}${head}`, ...lines(n.children, list, `${pad}  `)];
    });

  it('FR-16.4 kinds in list order, HTTP by path then verb, a long group in folders, module-level calls of a file together', () => {
    const list = [
      ep('job', 'Sync.run', 'src/Sync.ts#Sync.run'),
      ...Array.from({ length: 26 }, (_, i) => http(`/api/catalog/g${String(i).padStart(2, '0')}`, i)),
      { ...ep('http', 'DELETE /api/health', 'app/H.php#H.d'), verb: 'DELETE' } as EntryPoint,
      { ...ep('http', 'GET /api/health', 'app/H.php#H.g'), verb: 'GET' } as EntryPoint,
      { ...ep('cli', 'src/boot.ts: start()', 'src/boot.ts#<module>.start', 'module'), file: 'src/boot.ts' } as EntryPoint,
      { ...ep('cli', 'src/boot.ts: listen()', 'src/boot.ts#<module>.listen', 'module'), file: 'src/boot.ts' } as EntryPoint,
    ];
    const tree = entryPointTree(list);
    const out = lines(tree, list);
    expect(out.filter((l) => !l.startsWith('    '))).toEqual(['group http', '  [/catalog]', '  [/health]', 'group cli', '  file src/boot.ts', 'group job', '  Sync.run']);
    // one path's endpoints by verb (GET before DELETE), whatever the adapter's order
    expect(out.slice(out.indexOf('  [/health]') + 1, out.indexOf('  [/health]') + 3)).toEqual(['    GET /api/health', '    DELETE /api/health']);
    expect(out.filter((l) => l.startsWith('    GET /api/catalog'))).toHaveLength(26);
    expect(entriesUnder(tree[0], list)).toHaveLength(28);
    expect((tree[0] as Extract<EntryPointListNode, { type: 'group' }>).children[0]).toMatchObject({ type: 'folder', path: '/api/catalog' });
  });

  it('FR-16.8 several projects: projects first, the test projects together under Tests; a folder of classes is a leaf', () => {
    const tests = Array.from({ length: 26 }, (_, i) => ({ ...ep('test', `T${i}.it`, `tests/Unit/T${i % 2}.cs#T${i % 2}.it${i}`), project: i < 13 ? 'Shop.UnitTests' : 'Shop.IntegrationTests' }) as EntryPoint);
    const list = [{ ...ep('http', 'GET /a', 'src/A.cs#A.get'), project: 'Shop.Web' } as EntryPoint, ...tests];
    const out = lines(entryPointTree(list, 'Shop'), list);
    expect(out.slice(0, 5)).toEqual(['project Shop.Web', '  group http', '    GET /a', 'project Tests (tests)', '  project Shop.IntegrationTests']);
    expect(out.some((l) => l.endsWith(' C]'))).toBe(false); // 13 per project: no folders
    const one = tests.map((t) => ({ ...t, project: undefined }));
    expect(lines(entryPointTree(one), one).slice(0, 3)).toEqual(['group test', '  [T0 C]', '    T0.it']);
    expect(sortForDisplay([{ ...ep('http', 'OPTIONS /a', 'a#A.o'), verb: 'OPTIONS' } as EntryPoint, ep('route', '/a', 'a#A.r')]).map((e) => e.label)).toEqual(['/a', 'OPTIONS /a']);
  });
});
