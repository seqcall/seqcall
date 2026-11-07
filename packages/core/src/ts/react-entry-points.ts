import ts from 'typescript';
import { type CallableNode, type TsModel, skipOuter } from './model';
import { trimChar } from '../text';

/** FR-16.6 a client route: its full path and the page component that renders it. */
export interface ReactRoute {
  path: string;
  component: CallableNode;
  detail: string;
}

/** FR-16.7 a render root: where the app mounts (`#cart-app`) and the component it shows. */
export interface ReactRoot {
  label: string;
  component: CallableNode;
}

const COMPONENT_PROPS = ['component', 'Component', 'element'];
const TANSTACK = /^@tanstack\/react-router$/;

/**
 * FR-16.6 TanStack Router's routes at `n`: file routes `createFileRoute('/_authed/priorities')({ component })`
 * (also `createLazyFileRoute`) — the path without pathless layout segments (`_authed`) and route groups (`(app)`),
 * `/_authed/` → `/` — and code routes `createRoute({ getParentRoute: () => parent, path: 'posts', component })`, joined
 * with their parents' paths. Only routes whose `component` is a project component that renders JSX (a layout route
 * with only `beforeLoad` is no page); the root route (`createRootRoute`) is the app's frame, not a page.
 */
export function tanstackRoutes(model: TsModel, n: ts.Node): ReactRoute[] {
  if (!ts.isCallExpression(n)) return [];
  const detail = () => `client route (${model.rel(n.getSourceFile().fileName)})`;
  const page = (path: string | undefined, opts: ts.Expression | undefined): ReactRoute[] => {
    const o = opts && skipOuter(opts);
    const component = o && ts.isObjectLiteralExpression(o) ? prop(o, 'component') : undefined;
    if (path === undefined || !component) return [];
    return pageComponents(model, component).map((c) => ({ path, component: c, detail: detail() }));
  };
  const callee = skipOuter(n.expression);
  if (ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && /^create(Lazy)?FileRoute$/.test(callee.expression.text) && importedFrom(model, callee.expression, TANSTACK, callee.expression.text)) {
    const id = callee.arguments[0];
    return page(id && ts.isStringLiteralLike(id) ? fileRoutePath(id.text) : undefined, n.arguments[0]);
  }
  if (ts.isIdentifier(callee) && callee.text === 'createRoute' && importedFrom(model, callee, TANSTACK, 'createRoute')) {
    return page(codeRoutePath(model, n, 0), n.arguments[0]);
  }
  return [];
}

/**
 * `/_authed/_admin/users` → `/users`, `/(app)/posts/$postId` → `/posts/$postId`, `/_authed/` → `/`; a layout route keeps
 * its own segment (`/_authed/_admin` → `/_admin`): it has no path of its own, and `/` would read as the home page.
 */
function fileRoutePath(id: string): string {
  const segs = id.split('/').filter(Boolean);
  const layout = !id.endsWith('/') && segs.at(-1)?.startsWith('_');
  const parts = segs.filter((s, i) => (layout && i === segs.length - 1) || (!s.startsWith('_') && !/^\(.*\)$/.test(s))).map((s, i, all) => (layout && i === all.length - 1 ? s : s.replace(/_$/, '')));
  return `/${parts.join('/')}`;
}

/** A code route's full path: its `path` after its parents' (`getParentRoute: () => postsRoute`); `id` routes add none. */
function codeRoutePath(model: TsModel, call: ts.CallExpression, depth: number): string | undefined {
  if (depth > 8) return undefined;
  const opts = call.arguments[0] && skipOuter(call.arguments[0]);
  if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
  const own = prop(opts, 'path');
  const ownText = own && ts.isStringLiteralLike(own) ? own.text : own ? undefined : '';
  if (ownText === undefined) return undefined;
  let parentPath = '';
  const getParent = prop(opts, 'getParentRoute');
  const fn = getParent && skipOuter(getParent);
  // `() => parentRoute` (a block body is no identifier below)
  const returned = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? skipOuter(fn.body as ts.Expression) : undefined;
  if (returned && ts.isIdentifier(returned)) {
    const decl = declarationOf(model, returned);
    const init = decl && ts.isVariableDeclaration(decl) && decl.initializer ? skipOuter(decl.initializer) : undefined;
    const parent = init && ts.isCallExpression(init) ? init : undefined;
    const parentCallee = parent && skipOuter(parent.expression);
    if (parent && parentCallee && ts.isIdentifier(parentCallee) && parentCallee.text === 'createRoute') {
      const p = codeRoutePath(model, parent, depth + 1);
      if (p === undefined) return undefined;
      parentPath = p; // (a `/` parent: the double slash is joined below)
    }
  }
  const joined = `${parentPath}/${trimChar(ownText, '/')}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : '/';
}
const NESTING_PROPS = new Set(['routes', 'children']);

/**
 * FR-16.6 client routes at `n`, by shape, not by library: an object literal with a `path` (or `index: true`) and a
 * page (`component` / `Component` / `element`) — react-router's `createBrowserRouter([{ path, element }])` and route
 * tables of an app's own shape (`{ path, component, routes }`) alike — and react-router's `<Route path element>`.
 * Nested routes (`routes` / `children` arrays, `<Route>` inside `<Route>`) join their parent's path unless they
 * start with `/`. A hit counts only when its page resolves to a project component that renders JSX (a menu or a
 * breadcrumb config has a `path` too).
 */
export function reactRoutes(model: TsModel, n: ts.Node): ReactRoute[] {
  const detail = () => `client route (${model.rel(n.getSourceFile().fileName)})`;
  if (ts.isObjectLiteralExpression(n)) {
    // TanStack Router's code routes join their parent through getParentRoute (tanstackRoutes)
    if (!isRouteObject(n) || prop(n, 'getParentRoute')) return [];
    const path = objectRoutePath(model, n);
    const page = COMPONENT_PROPS.map((p) => prop(n, p)).find(Boolean);
    if (path === undefined || !page) return [];
    return pageComponents(model, page).map((component) => ({ path, component, detail: detail() }));
  }
  if ((ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) && isRouteTag(n)) {
    const path = jsxRoutePath(model, n);
    const page = COMPONENT_PROPS.map((p) => attr(n, p)).find(Boolean);
    if (path === undefined || !page) return [];
    return pageComponents(model, page).map((component) => ({ path, component, detail: detail() }));
  }
  return [];
}

/**
 * FR-16.7 render roots at `n`: `createRoot(el).render(<App />)` (also through a variable), `hydrateRoot(el, <App />)`,
 * `ReactDOM.render(<App />, el)` — by their import from `react-dom` / `react-dom/client`. The component is the one
 * the JSX shows, through wrappers (`<GlobalProvider><Header /></GlobalProvider>` → Header); a root that only shows
 * providers (`<RouterProvider>`: its routes are listed) or a component chosen at run time is not listed.
 */
export function reactRoots(model: TsModel, n: ts.Node): ReactRoot[] {
  if (!ts.isCallExpression(n)) return [];
  let jsx: ts.Expression | undefined;
  let container: ts.Expression | undefined;
  const callee = skipOuter(n.expression);
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
  if (name !== 'render' && name !== 'hydrateRoot') return [];
  if (ts.isIdentifier(callee) && fromReactDom(model, callee, 'hydrateRoot')) {
    [container, jsx] = n.arguments;
  } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'render') {
    const target = skipOuter(callee.expression);
    const created = rootCreation(model, target);
    if (created) {
      container = created.arguments[0];
      jsx = n.arguments[0];
    } else if (ts.isIdentifier(target) && fromReactDom(model, target)) {
      [jsx, container] = n.arguments;
    }
  } else if (ts.isIdentifier(callee) && callee.text === 'render' && fromReactDom(model, callee, 'render')) {
    [jsx, container] = n.arguments;
  }
  if (!jsx || !container) return [];
  const component = mainComponent(model, skipOuter(jsx));
  if (!component || /(Provider|Boundary)$/.test(componentName(component))) return [];
  return [{ label: containerLabel(container), component }];
}

// ───────────── route paths ─────────────

function isRouteObject(o: ts.ObjectLiteralExpression): boolean {
  const index = prop(o, 'index');
  return (!!prop(o, 'path') || index?.kind === ts.SyntaxKind.TrueKeyword) && COMPONENT_PROPS.some((p) => prop(o, p));
}

/** Full path of a route object: its own path joined with the route objects it is nested in. */
function objectRoutePath(model: TsModel, o: ts.ObjectLiteralExpression): string | undefined {
  const own = prop(o, 'path');
  const text = own ? pathText(model, own) : '';
  if (text === undefined) return undefined;
  const parent = parentRouteObject(o);
  return joinPath(parent ? objectRoutePath(model, parent) ?? '' : '', text);
}

/** `{ path, routes: [ <o> ] }` → the outer object. */
function parentRouteObject(o: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression | undefined {
  let p: ts.Node = o.parent;
  while (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) p = p.parent;
  // in an array (not: the object of a `routes:` property itself, whose parent is no property assignment)
  const assign = p.parent;
  if (!ts.isPropertyAssignment(assign) || !(ts.isIdentifier(assign.name) && NESTING_PROPS.has(assign.name.text))) return undefined;
  // the object holding the property (a path-less layout route passes its parent's path on)
  return assign.parent;
}

function isRouteTag(n: ts.JsxSelfClosingElement | ts.JsxOpeningElement): boolean {
  return ts.isIdentifier(n.tagName) && n.tagName.text === 'Route';
}

function jsxRoutePath(model: TsModel, n: ts.JsxSelfClosingElement | ts.JsxOpeningElement): string | undefined {
  const own = attr(n, 'path');
  const text = own ? pathText(model, own) : '';
  if (text === undefined) return undefined;
  // <Route path="a"><Route path="b" /></Route>: the element's parent is the outer <Route>'s JsxElement
  const element = ts.isJsxOpeningElement(n) ? n.parent : n;
  const outer = element.parent;
  const parentPath = ts.isJsxElement(outer) && isRouteTag(outer.openingElement) ? jsxRoutePath(model, outer.openingElement) ?? '' : '';
  return joinPath(parentPath, text);
}

/** A route path as text: literals, templates with `{name}` for their parts, constants by their value. */
function pathText(model: TsModel, e: ts.Expression): string | undefined {
  const x = skipOuter(e);
  if (ts.isStringLiteralLike(x)) return x.text;
  if (ts.isTemplateExpression(x)) {
    return x.head.text + x.templateSpans.map((s) => `${pathText(model, s.expression) ?? `{${nameOf(s.expression)}}`}${s.literal.text}`).join('');
  }
  if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
    const decl = declarationOf(model, x);
    const init = decl && (ts.isVariableDeclaration(decl) || ts.isPropertyAssignment(decl) || ts.isEnumMember(decl)) ? decl.initializer : undefined;
    if (init && ts.isStringLiteralLike(skipOuter(init))) return (skipOuter(init) as ts.StringLiteralLike).text;
    return `{${nameOf(x)}}`;
  }
  return undefined;
}

function nameOf(e: ts.Expression): string {
  const x = skipOuter(e);
  if (ts.isIdentifier(x)) return x.text;
  if (ts.isPropertyAccessExpression(x)) return x.name.text;
  return '…';
}

/**
 * A child path starting with `/` is absolute (react-router v6 and route tables written with full paths), so is one
 * that already starts with its parent's path (`${accountPath}/bank` under `${accountPath}`); else it is relative.
 */
function joinPath(parent: string, child: string): string {
  const trim = (p: string) => trimChar(p, '/');
  if (child.startsWith('/') || (trim(parent) && `${trim(child)}/`.startsWith(`${trim(parent)}/`))) return `/${trim(child)}`;
  return `/${[parent, child].map(trim).filter(Boolean).join('/')}`;
}

// ───────────── components ─────────────

/** The project components a route's page can be: `Page`, `observer(Page)`, `a ? A : B`, `<Suspense><Page /></Suspense>`. */
function pageComponents(model: TsModel, page: ts.Expression): CallableNode[] {
  const x = skipOuter(page);
  if (ts.isConditionalExpression(x)) return [...pageComponents(model, x.whenTrue), ...pageComponents(model, x.whenFalse)];
  if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) {
    const c = mainComponent(model, x);
    return c ? [c] : [];
  }
  const c = componentOf(model, x, 0);
  return c ? [c] : [];
}

/**
 * The component a JSX tree shows: down through wrappers (an element's last child element is its content), the
 * deepest project component on the way — none when that content is a library component (`<RouterProvider>`,
 * `<Navigate>`) or one chosen at run time.
 */
function mainComponent(model: TsModel, e: ts.Expression | ts.JsxChild): CallableNode | undefined {
  return shown(model, e).component;
}

/** `blocked`: the content ends in a component that is not project code. */
function shown(model: TsModel, e: ts.Expression | ts.JsxChild): { component?: CallableNode; blocked?: boolean } {
  let tag: ts.JsxTagNameExpression | undefined;
  let children: readonly ts.JsxChild[] = [];
  if (ts.isJsxSelfClosingElement(e)) tag = e.tagName;
  else if (ts.isJsxElement(e)) {
    tag = e.openingElement.tagName;
    children = e.children;
  } else if (ts.isJsxFragment(e)) children = e.children;
  // (callers pass the expression without parentheses, children are elements)
  else return {};
  const last = [...children].reverse().find((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxFragment(c));
  const inner = last ? shown(model, last) : {};
  if (inner.component || inner.blocked) return inner;
  const isComponent = !!tag && !(ts.isIdentifier(tag) && !/^[A-Z]/.test(tag.text)) && !ts.isJsxNamespacedName(tag);
  if (!isComponent) return {};
  if (ts.isPropertyAccessExpression(tag!) && ts.isIdentifier(tag.expression) && tag.expression.text === 'React') return {}; // React.Fragment, React.Suspense
  const component = tagComponent(model, tag!);
  return component ? { component } : { blocked: true };
}

export function tagComponent(model: TsModel, tag: ts.JsxTagNameExpression): CallableNode | undefined {
  // lower-case tags are DOM elements
  if (ts.isIdentifier(tag) && !/^[A-Z]/.test(tag.text)) return undefined;
  return ts.isIdentifier(tag) || ts.isPropertyAccessExpression(tag) ? componentOf(model, tag, 0) : undefined;
}

/**
 * A component reference → the callable that renders it: a function component, a class component's `render`,
 * through `observer(X)` / `memo(X)` / `forwardRef(X)`, `const X = observer(Inner)` and `lazy(() => import(…))`. Only
 * project code that renders JSX; an inline `observer(() => …)` is not a keyed callable.
 */
function componentOf(model: TsModel, e: ts.Expression, depth: number): CallableNode | undefined {
  if (depth > 5) return undefined;
  const x = skipOuter(e);
  if (ts.isCallExpression(x)) {
    const arg = x.arguments[0] && skipOuter(x.arguments[0]);
    if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) return lazyComponent(model, arg, depth);
    return arg ? componentOf(model, arg, depth + 1) : undefined;
  }
  if (!ts.isIdentifier(x) && !ts.isPropertyAccessExpression(x)) return undefined;
  const decl = declarationOf(model, x);
  return decl && componentOfDeclaration(model, decl, depth);
}

function componentOfDeclaration(model: TsModel, decl: ts.Declaration, depth: number): CallableNode | undefined {
  if (model.isLibraryFile(decl.getSourceFile())) return undefined;
  if (ts.isClassLike(decl)) {
    const render = decl.members.find((m) => m.name && ts.isIdentifier(m.name) && m.name.text === 'render');
    const c = render && model.asCallable(render);
    return c && rendersJsx(render!) ? c : undefined;
  }
  const c = model.asCallable(decl);
  if (c) return rendersJsx(decl) ? c : undefined;
  if (ts.isVariableDeclaration(decl) && decl.initializer) return componentOf(model, decl.initializer, depth + 1);
  if (ts.isExportAssignment(decl)) return componentOf(model, decl.expression, depth + 1);
  return undefined;
}

/**
 * `lazy(() => import('./page'))` (also through an app's own wrapper, `lazyWithRetry(() => import(…))`) → the
 * module's default export; `import('./x').then((m) => ({ default: m.Page }))` → its `Page`.
 */
function lazyComponent(model: TsModel, fn: ts.ArrowFunction | ts.FunctionExpression, depth: number): CallableNode | undefined {
  let importCall: ts.CallExpression | undefined;
  let exported = 'default';
  const visit = (n: ts.Node): void => {
    if (importCall) return;
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) importCall = n;
    else ts.forEachChild(n, visit);
  };
  visit(fn.body);
  if (!importCall?.arguments[0]) return undefined;
  const then = importCall.parent;
  if (ts.isPropertyAccessExpression(then) && then.name.text === 'then' && ts.isCallExpression(then.parent)) {
    const pick = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'default' && ts.isPropertyAccessExpression(skipOuter(n.initializer))) {
        exported = (skipOuter(n.initializer) as ts.PropertyAccessExpression).name.text;
      } else ts.forEachChild(n, pick);
    };
    then.parent.arguments.forEach(pick);
  }
  const module = model.checker.getSymbolAtLocation(importCall.arguments[0]);
  if (!module) return undefined;
  let symbol = model.checker.getExportsOfModule(module).find((m) => m.name === exported);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = model.checker.getAliasedSymbol(symbol);
  const decl = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return decl && componentOfDeclaration(model, decl, depth + 1);
}

function componentName(c: CallableNode): string {
  const n = ts.isMethodDeclaration(c) && ts.isClassLike(c.parent) ? c.parent.name : (c as { name?: ts.Node }).name;
  return n && ts.isIdentifier(n) ? n.text : '';
}

export function rendersJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

// ───────────── roots ─────────────

/** `createRoot(el)` written at the call, or the variable it was stored in. */
function rootCreation(model: TsModel, target: ts.Expression): ts.CallExpression | undefined {
  const isCreate = (c: ts.Expression): c is ts.CallExpression => {
    const x = skipOuter(c);
    return ts.isCallExpression(x) && ts.isIdentifier(skipOuter(x.expression)) && fromReactDom(model, skipOuter(x.expression) as ts.Identifier, 'createRoot');
  };
  if (isCreate(target)) return skipOuter(target) as ts.CallExpression;
  if (ts.isIdentifier(target)) {
    const decl = declarationOf(model, target);
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isCreate(decl.initializer)) return skipOuter(decl.initializer) as ts.CallExpression;
  }
  return undefined;
}

/** Is `id` imported from `react-dom` / `react-dom/client` (by name, or the namespace `ReactDOM`)? */
function fromReactDom(model: TsModel, id: ts.Identifier, name?: string): boolean {
  return importedFrom(model, id, /^react-dom(\/client)?$/, name);
}

/** Is `id` imported from a module matching `module` (by name, or a default / namespace import when no name)? */
function importedFrom(model: TsModel, id: ts.Identifier, module: RegExp, name?: string): boolean {
  const symbol = model.checker.getSymbolAtLocation(id);
  for (const d of symbol?.declarations ?? []) {
    let imp: ts.Node = d;
    while (imp && !ts.isImportDeclaration(imp)) imp = imp.parent;
    if (!imp || !ts.isStringLiteral(imp.moduleSpecifier) || !module.test(imp.moduleSpecifier.text)) continue;
    if (ts.isImportSpecifier(d)) return !name || (d.propertyName ?? d.name).text === name;
    return !name; // default / namespace import: ReactDOM.render
  }
  return false;
}

/** `document.querySelector('#app')` → `#app`, `getElementById('root')` → `#root`, else the expression. */
function containerLabel(e: ts.Expression): string {
  const x = skipOuter(e);
  if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.arguments[0] && ts.isStringLiteralLike(x.arguments[0])) {
    const fn = x.expression.name.text;
    if (fn === 'getElementById') return `#${x.arguments[0].text}`;
    if (fn === 'querySelector') return x.arguments[0].text;
  }
  const text = x.getText().replace(/\s+/g, ' ');
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

// ───────────── helpers ─────────────

function declarationOf(model: TsModel, e: ts.Identifier | ts.PropertyAccessExpression | ts.JsxTagNameExpression): ts.Declaration | undefined {
  const at = ts.isPropertyAccessExpression(e) ? e.name : e;
  let symbol = ts.isShorthandPropertyAssignment(at.parent) ? model.checker.getShorthandAssignmentValueSymbol(at.parent) : model.checker.getSymbolAtLocation(at);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = model.checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function prop(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return skipOuter(p.initializer);
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

function attr(n: ts.JsxSelfClosingElement | ts.JsxOpeningElement, name: string): ts.Expression | undefined {
  for (const a of n.attributes.properties) {
    if (!ts.isJsxAttribute(a) || !ts.isIdentifier(a.name) || a.name.text !== name || !a.initializer) continue;
    if (ts.isStringLiteral(a.initializer)) return a.initializer;
    // `={page}` (`={}`: undefined), or an element without braces `=<Page />`
    return ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
  }
  return undefined;
}
