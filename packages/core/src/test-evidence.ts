import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EntryPoint } from '@seqcall/protocol';
import type { ProjectLanguage } from './languages';

/**
 * FR-22.5 what static paths cannot see about tests, read from the test code's text:
 * - tests that reach a method **over HTTP** (web integration tests, BDD steps): a string literal in test code that is
 *   one of the routes the method is reached from (`$"{version}/orders/{id}/confirm"` matches
 *   `POST /v1.3|1.4/Orders/{publicId}/confirm`), or the route's name (`route('api.cart.checkout')`);
 * - tests that **mock** a type on their way to the method (`new Mock<IOrderStore>()`, `createMock(X::class)`,
 *   in the test file or in a helper it uses): they do not run the real code below it.
 * Matched by text — reported as such.
 */

export interface HttpRoute {
  /** `POST /v1.3|1.4/Orders/{publicId}/confirm` */
  label: string;
  verb?: string;
  path: string;
  name?: string;
}

export interface HttpTestCall {
  route: string;
  /** Project-relative test file and 1-based line of the URL / route name. */
  file: string;
  line: number;
  /** The line, trimmed. */
  code: string;
  by: 'url' | 'name';
}

const SOURCE: Record<ProjectLanguage, RegExp> = {
  csharp: /\.cs$/,
  php: /\.php$/,
  typescript: /\.(ts|tsx|js|jsx|mjs|cjs)$/,
};
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'bin', 'obj', '.git', 'dist', 'build', 'coverage', '.idea', '.vs', 'storage', 'public']);

/** Project-relative test files of the language (`isTest` decides), with their text. */
export function testSources(root: string, language: ProjectLanguage, isTest: (rel: string) => boolean): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 12) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) visit(abs, depth + 1);
      } else if (SOURCE[language].test(e.name)) {
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        if (!isTest(rel)) continue;
        try {
          out.push({ rel, src: fs.readFileSync(abs, 'utf8') });
        } catch {
          // unreadable: skipped
        }
      }
    }
  };
  visit(root, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** The HTTP routes among entry points (`GET /users/:id`), with their names. */
export function httpRoutes(entryPoints: EntryPoint[]): HttpRoute[] {
  const out = new Map<string, HttpRoute>();
  for (const e of entryPoints) {
    if (e.kind !== 'http') continue;
    const m = /^([A-Z|]+)\s+(\S+)/.exec(e.label);
    const verb = e.verb ?? m?.[1];
    const p = m ? m[2] : e.label;
    out.set(e.label, { label: e.label, ...(verb && verb !== 'ANY' ? { verb } : {}), path: p, ...(e.routeName ? { name: e.routeName } : {}) });
  }
  return [...out.values()];
}

/** A route segment that stands for any value: `{id}`, `{id?}`, `:id`, API versions (`v1.4`, `v1.3|1.4`: tests pass `{version}`). */
const VERSION = /^v\d+(\.\d+)*$/i;
const hasPlaceholder = (s: string) => s.includes('{') && s.indexOf('}', s.indexOf('{')) > -1;
const variableRouteSegment = (s: string) => (s.startsWith('{') && s.endsWith('}')) || /^:\w+\??$/.test(s) || s.includes('|') || hasPlaceholder(s) || VERSION.test(s);
/** A URL segment built at run time: `{version}` (C# / JS interpolation), `$id`, `${id}`, `' . $id . '`. */
const variableUrlSegment = (s: string) => /[{}$]/.test(s);

/** Does a URL written in a test (`/{version}/orders/{id}/confirm?x=1`) hit the route path? */
export function urlMatchesRoute(url: string, routePath: string): boolean {
  const noHost = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const cut = noHost.search(/[?#]/);
  const clean = cut >= 0 ? noHost.slice(0, cut) : noHost;
  const u = clean.split('/').filter(Boolean);
  const r = routePath.split('/').filter(Boolean);
  if (!u.length || u.length !== r.length) return false;
  let literal = 0;
  for (let i = 0; i < r.length; i++) {
    // an API version takes a version or a run-time value (`{version}`), not a fixed word (`/api/…` is another URL)
    if (VERSION.test(r[i]) || /\|/.test(r[i])) {
      if (!variableUrlSegment(u[i]) && !VERSION.test(u[i])) return false;
      continue;
    }
    if (variableRouteSegment(r[i])) continue;
    if (variableUrlSegment(u[i]) || u[i].toLowerCase() !== r[i].toLowerCase()) return false;
    literal++;
  }
  return literal > 0;
}

/** String literals of a line: "…", '…', `…` (C# `$"…"` / `@"…"` included). */
function literals(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  // each alternative is one group: the one that matched is set (possibly empty)
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const VERB_ON_LINE = /\b(get|post|put|patch|delete)(?:json|asjson|async|asjsonasync|jsonasync)?\s*[(<]|HttpMethod\.(Get|Post|Put|Patch|Delete)\b/i;

/** Lines of test code that call one of the routes over HTTP, by URL or by route name. */
export function httpTestCalls(sources: { rel: string; src: string }[], routes: HttpRoute[]): HttpTestCall[] {
  const out: HttpTestCall[] = [];
  const names = new Map(routes.filter((r) => r.name).map((r) => [r.name!, r]));
  for (const { rel, src } of sources) {
    // Pact consumer tests describe requests *to another service* (`.UponReceiving(…).WithRequest(HttpMethod.Post, "/api/…")`)
    if (/\.\s*(UponReceiving|uponReceiving|WithRequest|withRequest)\s*\(/.test(src)) continue;
    if (!routes.some((r) => src.toLowerCase().includes(lastLiteral(r.path))) && ![...names.keys()].some((n) => src.includes(n))) continue;
    src.split('\n').forEach((line, i) => {
      const lits = literals(line);
      if (!lits.length) return;
      const verb = VERB_ON_LINE.exec(line);
      const verbOnLine = (verb?.[1] ?? verb?.[2])?.toUpperCase();
      for (const r of routes) {
        const byName = !!r.name && lits.includes(r.name);
        const byUrl = !byName && lits.some((l) => l.includes('/') && urlMatchesRoute(l, r.path));
        if (!byName && !byUrl) continue;
        // another verb on the same line is another route (`GET /x` vs `POST /x`)
        if (verbOnLine && r.verb && !r.verb.split('|').includes(verbOnLine)) continue;
        out.push({ route: r.label, file: rel, line: i + 1, code: line.trim().slice(0, 160), by: byName ? 'name' : 'url' });
      }
    });
  }
  return out;
}

/** The route's last fixed segment, lower case (a quick filter for files that cannot match). */
function lastLiteral(routePath: string): string {
  const fixed = routePath.split('/').filter((s) => s && !variableRouteSegment(s));
  return (fixed[fixed.length - 1] ?? '').toLowerCase();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Which of the type names the test code mocks (Moq, NSubstitute, FakeItEasy, PHPUnit, Mockery, Laravel, jest-mock-extended). */
export function mockedTypes(src: string, names: string[]): string[] {
  return names.filter((n) => {
    const t = escape(n);
    return new RegExp(
      [
        `\\b(?:Mock|Mock\\.Of|Substitute\\.For|A\\.Fake|Fake)\\s*<\\s*(?:[\\w.]+\\.)?${t}\\b`,
        `\\b(?:createMock|createStub|getMockBuilder|createPartialMock|mock|partialMock|spy|instance|Mockery::mock|Mockery::spy)\\s*\\(\\s*['"]?\\\\?(?:[\\w\\\\]+\\\\)?${t}(?:::class|['"])`,
        `\\b(?:mock|mockDeep|createMock)\\s*<\\s*${t}\\s*>`,
      ].join('|'),
    ).test(src);
  });
}

/**
 * The mocks a test file depends on: the type names mocked in the file itself or in a test-code file whose main class
 * (its file name) the file uses (`TestHelper.SetupMock…` → TestHelper.cs mocks IOrderStore).
 */
export function mocksUsedBy(file: { rel: string; src: string }, sources: { rel: string; src: string }[], names: string[]): string[] {
  const found = new Set(mockedTypes(file.src, names));
  for (const h of sources) {
    if (h.rel === file.rel) continue;
    const cls = path.basename(h.rel).split('.')[0];
    if (!cls || !new RegExp(`\\b${escape(cls)}\\b`).test(file.src)) continue;
    for (const n of mockedTypes(h.src, names)) found.add(n);
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}
