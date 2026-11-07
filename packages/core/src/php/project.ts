import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { configFileOf, stripJsonComments } from '../classifier-impl';
import { childrenOf, nameOf, parsePhp, type PNode } from './ast';

/**
 * The PHP project: every `.php` file under the root (not `vendor/`, `node_modules/`, `storage/`,
 * caches), parsed once and indexed by declared class / interface / trait / enum and function.
 * PHP names are case-insensitive: the index is keyed by lower-case fully qualified names.
 * Classes that are not declared in the project (Laravel, other packages, PHP itself) are
 * libraries, recognised by name only — `vendor/` is not needed (FR-18).
 *
 * First-party packages (FR-18.9): classes of the Composer packages matching `packages` (default:
 * the project's own vendor, `acme/*` for `acme/shop`) are project code too. They
 * are loaded on demand — when a lookup misses, through Composer's PSR-4 map in
 * `vendor/composer/autoload_psr4.php` — so a large `vendor/` costs nothing up front.
 */

const SKIP_DIRS = new Set(['vendor', 'node_modules', 'storage', '.git', '.idea', '.vscode', '.phpunit.cache', 'cache']);

/** Name resolution context of a namespace block: `namespace A\B; use X\Y as Z; use function f;` */
export interface NameScope {
  namespace: string;
  /** alias (lower case) → fully qualified class name */
  classes: Map<string, string>;
  functions: Map<string, string>;
}

export interface PropertyDecl {
  name: string;
  /** Declared type node (typed property or promoted constructor parameter). */
  type?: PNode;
  /** `@var` type text from the doc comment. */
  docType?: string;
  isStatic: boolean;
  node: PNode;
  /** Promoted constructor parameter (dependency injection). */
  promoted: boolean;
}

export interface ClassDecl {
  fqn: string;
  name: string;
  kind: 'class' | 'interface' | 'trait' | 'enum';
  isAbstract: boolean;
  file: PhpFile;
  node: PNode;
  scope: NameScope;
  extends: string[];
  implements: string[];
  traits: string[];
  /** lower-case method name → method node */
  methods: Map<string, PNode>;
  properties: Map<string, PropertyDecl>;
  /** `@property Type $name` / `@method Type name()` from the class doc comment (magic members). */
  docProperties: Map<string, string>;
  docMethods: Map<string, string>;
  /** `@template TValue` names of the class doc: type variables, not classes. */
  templates?: Set<string>;
}

/** A method found through library declarations (FR-18.10). */
export interface LibraryMethod {
  owner: ClassDecl;
  node?: PNode;
  /** `@method` return type text (facades, magic `__call`). */
  docReturn?: string;
}

export interface FunctionDecl {
  fqn: string;
  name: string;
  file: PhpFile;
  node: PNode;
  scope: NameScope;
}

export interface PhpFile {
  abs: string;
  rel: string;
  /** A file of a first-party package in `vendor/` (loaded on demand, FR-18.9). */
  vendor?: boolean;
  src: string;
  ast: PNode;
  classes: ClassDecl[];
  functions: FunctionDecl[];
}

const lower = (s: string) => s.toLowerCase();
export const shortName = (fqn: string) => fqn.slice(fqn.lastIndexOf('\\') + 1);

export class PhpProject {
  readonly root: string;
  private readonly files = new Map<string, PhpFile>();
  private readonly classes = new Map<string, ClassDecl>();
  private readonly functions = new Map<string, FunctionDecl>();
  private indexed = false;
  /** PSR-4 prefixes of the first-party packages, longest first (undefined = not read yet). */
  private psr4: { prefix: string; dirs: string[] }[] | undefined;
  private readonly loadedPackages = new Set<string>();

  constructor(root: string) {
    this.root = root.replace(/\\/g, '/').replace(/\/$/, '');
  }

  /** Package globs from `.seqcall.json` → `packages`, else the project's own Composer vendor. */
  private patterns: string[] | undefined;

  private packagePatterns(): string[] {
    this.patterns ??= this.readPackagePatterns();
    return this.patterns;
  }

  private readPackagePatterns(): string[] {
    try {
      const cfg = configFileOf(this.root);
      if (fs.existsSync(cfg)) {
        const parsed = JSON.parse(stripJsonComments(fs.readFileSync(cfg, 'utf8'))) as { packages?: unknown };
        if (Array.isArray(parsed.packages)) return parsed.packages.filter((p): p is string => typeof p === 'string');
      }
    } catch {
      // a broken config is reported by the classifier; fall back to the default
    }
    try {
      const name = (JSON.parse(fs.readFileSync(path.join(this.root, 'composer.json'), 'utf8')) as { name?: string }).name;
      const vendor = name?.includes('/') ? name.split('/')[0] : undefined;
      return vendor ? [`${vendor}/*`] : [];
    } catch {
      return [];
    }
  }

  /** Every `'Acme\\Pay\\' => array($vendorDir . '/acme/pay/src')` entry of Composer's PSR-4 map (vendor dirs only). */
  private allPsr4: { prefix: string; dirs: string[] }[] | undefined;

  private composerPsr4(): { prefix: string; dirs: string[] }[] {
    if (this.allPsr4) return this.allPsr4;
    this.allPsr4 = [];
    let text: string;
    try {
      text = fs.readFileSync(path.join(this.root, 'vendor/composer/autoload_psr4.php'), 'utf8');
    } catch {
      return this.allPsr4;
    }
    for (const m of text.matchAll(/'((?:[^'\\]|\\.)*)'\s*=>\s*array\(([^)]*)\)/g)) {
      const prefix = m[1].replace(/\\\\/g, '\\');
      const dirs = [...m[2].matchAll(/\$vendorDir\s*\.\s*'([^']*)'/g)].map((d) => d[1].replace(/^\//, ''));
      if (dirs.length) this.allPsr4.push({ prefix, dirs });
    }
    this.allPsr4.sort((a, b) => b.prefix.length - a.prefix.length);
    return this.allPsr4;
  }

  /** The PSR-4 entries of the first-party packages (absolute dirs). */
  private firstPartyPsr4(): { prefix: string; dirs: string[] }[] {
    if (this.psr4) return this.psr4;
    this.psr4 = [];
    const patterns = this.packagePatterns();
    if (!patterns.length) return this.psr4;
    const match = picomatch(patterns);
    for (const { prefix, dirs } of this.composerPsr4()) {
      const own = dirs.filter((d) => match(d.split('/').slice(0, 2).join('/'))).map((d) => `${this.root}/vendor/${d}`);
      if (own.length) this.psr4.push({ prefix, dirs: own });
    }
    return this.psr4;
  }

  /**
   * Library declarations (FR-18.10), for types only: classes of the other Composer packages
   * (Laravel's `Collection`, `Builder`, facades), read on demand through the PSR-4 map so that
   * `->map()->filter()` keeps the type its `@return static` declares. They are never project
   * classes — `classByFqn` does not see them, calls to them stay library calls.
   */
  private readonly libClasses = new Map<string, ClassDecl | null>();

  libraryClass(fqn: string): ClassDecl | undefined {
    const key = lower(fqn.replace(/^\\/, ''));
    const known = this.libClasses.get(key);
    if (known !== undefined) return known ?? undefined;
    let found: ClassDecl | undefined;
    for (const { prefix, dirs } of this.composerPsr4()) {
      if (found || !key.startsWith(lower(prefix))) continue;
      const rest = fqn.replace(/^\\/, '').slice(prefix.length).replace(/\\/g, '/');
      for (const dir of dirs) {
        const abs = `${this.root}/vendor/${dir}/${rest}.php`;
        if (!fs.existsSync(abs)) continue;
        let src: string;
        try {
          src = fs.readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const file: PhpFile = { abs, rel: path.relative(this.root, abs).replace(/\\/g, '/'), vendor: true, src, ast: parsePhp(src, abs), classes: [], functions: [] };
        indexFile(file);
        for (const c of file.classes) if (!this.libClasses.has(lower(c.fqn))) this.libClasses.set(lower(c.fqn), c);
        found = file.classes.find((c) => lower(c.fqn) === key);
        if (found) break;
      }
    }
    if (!found) this.libClasses.set(key, null);
    return found;
  }

  /**
   * A method inherited from library code: on the class or its ancestors, project classes and
   * library declarations alike (`$user->newQuery()` on a model, `->map()` on a Collection);
   * concrete declarations before interfaces, `@method` docs (facades) last.
   */
  libraryMethod(fqn: string, name: string): LibraryMethod | undefined {
    const key = `${lower(fqn)}::${lower(name)}`;
    const cached = this.libMethods.get(key);
    if (cached !== undefined) return cached ?? undefined;
    const found = this.findLibraryMethod(fqn, name);
    this.libMethods.set(key, found ?? null);
    return found;
  }

  /** `class::method` → libraryMethod's answer; cleared when a project file changes (its ancestry may have). */
  private readonly libMethods = new Map<string, LibraryMethod | null>();

  private findLibraryMethod(fqn: string, name: string): LibraryMethod | undefined {
    const all: ClassDecl[] = [];
    const seen = new Set<string>();
    const visit = (n: string) => {
      if (seen.has(lower(n))) return;
      seen.add(lower(n));
      const c = this.classByFqn(n) ?? this.libraryClass(n);
      if (!c) return;
      all.push(c);
      for (const t of c.traits) visit(t);
      for (const p of c.extends) visit(p);
      for (const i of c.implements) visit(i);
    };
    visit(fqn);
    const m = lower(name);
    const concrete = all.find((c) => c.kind !== 'interface' && c.methods.has(m)) ?? all.find((c) => c.methods.has(m));
    if (concrete) return { owner: concrete, node: concrete.methods.get(m) };
    const doc = all.find((c) => c.docMethods.has(m));
    return doc ? { owner: doc, docReturn: doc.docMethods.get(m) } : undefined;
  }

  /** Loads the file of a first-party package class (PSR-4), if there is one. */
  private loadFirstParty(fqn: string): ClassDecl | undefined {
    // (a name no package file declares is asked for again and again: a library class, a typo)
    if (this.firstPartyMisses.has(lower(fqn))) return undefined;
    for (const { prefix, dirs } of this.firstPartyPsr4()) {
      if (!lower(fqn).startsWith(lower(prefix))) continue;
      const rest = fqn.slice(prefix.length).replace(/\\/g, '/');
      for (const dir of dirs) {
        const abs = `${dir}/${rest}.php`;
        if (this.files.has(abs) || !fs.existsSync(abs)) continue;
        this.load(abs, undefined, true);
        const c = this.classes.get(lower(fqn));
        if (c) return c;
      }
    }
    this.firstPartyMisses.add(lower(fqn));
    return undefined;
  }

  /** Class names no first-party package file declares (cleared when a file changes). */
  private readonly firstPartyMisses = new Set<string>();

  /** The first-party package directory of a vendor file (`<root>/vendor/acme/pay`). */
  private packageDirOf(abs: string): string | undefined {
    const m = new RegExp(`^${this.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/vendor/([^/]+/[^/]+)/`).exec(abs);
    if (!m) return undefined;
    const patterns = this.packagePatterns();
    return patterns.length && picomatch(patterns)(m[1]) ? `${this.root}/vendor/${m[1]}` : undefined;
  }

  /**
   * Loads every source file of the first-party package a vendor file belongs to (once) — for
   * questions about the whole package, such as the implementations of one of its interfaces.
   */
  loadPackageOf(file: PhpFile): void {
    const dir = file.vendor ? this.packageDirOf(file.abs) : undefined;
    if (!dir || this.loadedPackages.has(dir)) return;
    this.loadedPackages.add(dir);
    const srcDirs = this.firstPartyPsr4().flatMap((e) => e.dirs).filter((d) => d === dir || d.startsWith(`${dir}/`));
    for (const src of srcDirs) for (const abs of listPhp(src)) if (!this.files.has(abs)) this.load(abs, undefined, true);
  }

  /** Every source file of every first-party package (FR-18.11: the routes they register), once. */
  loadFirstPartyPackages(): void {
    this.ensureIndex();
    for (const { dirs } of this.firstPartyPsr4()) {
      for (const dir of dirs) {
        if (this.loadedPackages.has(dir)) continue;
        for (const abs of listPhp(dir)) if (!this.files.has(abs)) this.load(abs, undefined, true);
        this.loadedPackages.add(dir);
      }
    }
  }

  /** The same, giving way between files (`slice`, see timeSlicer): a large project parses many package files here. */
  async loadFirstPartyPackagesSliced(slice: () => Promise<void>): Promise<void> {
    this.ensureIndex();
    for (const { dirs } of this.firstPartyPsr4()) {
      for (const dir of dirs) {
        if (this.loadedPackages.has(dir)) continue;
        for (const abs of listPhp(dir)) {
          if (!this.files.has(abs)) this.load(abs, undefined, true);
          await slice();
        }
        // marked when complete: a caller between two slices loads the rest itself
        this.loadedPackages.add(dir);
      }
    }
  }

  /** `acme/billing` for a file of that package in `vendor/` (callers pass vendor files only). */
  packageOf(file: PhpFile): string | undefined {
    return /^vendor\/([^/]+\/[^/]+)\//.exec(file.rel)?.[1];
  }

  private ensureIndex(): void {
    if (this.indexed) return;
    this.indexed = true;
    for (const abs of this.discover()) this.load(abs);
    // content given before the index existed (FR-24.6: the base version of the branch's files)
    for (const [file, content] of this.pending) this.update(file, content);
    this.pending.clear();
  }

  /** Content updates that arrived before the index was built. */
  private readonly pending = new Map<string, string>();

  private discover(): string[] {
    return listPhp(this.root);
  }

  /** Grows on every file loaded, changed or dropped: what was derived from the files before may be stale. */
  revision = 0;

  private load(abs: string, content?: string, vendor = false): PhpFile | undefined {
    this.revision++;
    this.traitUserCache.clear();
    let src: string;
    try {
      src = content ?? fs.readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
    const file: PhpFile = { abs, rel: path.relative(this.root, abs).replace(/\\/g, '/'), ...(vendor ? { vendor: true } : {}), src, ast: parsePhp(src, abs), classes: [], functions: [] };
    indexFile(file);
    this.files.set(abs, file);
    for (const c of file.classes) this.classes.set(lower(c.fqn), c);
    for (const f of file.functions) this.functions.set(lower(f.fqn), f);
    return file;
  }

  /** Re-reads (or drops) a changed file. */
  update(abs: string, content?: string): void {
    const file = abs.replace(/\\/g, '/');
    if (!this.indexed) {
      if (content !== undefined) this.pending.set(file, content);
      else this.pending.delete(file);
      return;
    }
    this.revision++;
    this.libMethods.clear();
    this.traitUserCache.clear();
    this.firstPartyMisses.clear();
    const old = this.files.get(file);
    if (old) {
      for (const c of old.classes) if (this.classes.get(lower(c.fqn)) === c) this.classes.delete(lower(c.fqn));
      for (const f of old.functions) if (this.functions.get(lower(f.fqn)) === f) this.functions.delete(lower(f.fqn));
      this.files.delete(file);
    }
    if (file.endsWith('.php') && (content !== undefined || fs.existsSync(file))) this.load(file, content);
  }

  file(abs: string): PhpFile | undefined {
    this.ensureIndex();
    const key = abs.replace(/\\/g, '/');
    const known = this.files.get(key);
    if (known) return known;
    // a first-party package file opened directly (or a key from history): load it on demand
    return this.packageDirOf(key) && fs.existsSync(key) ? this.load(key, undefined, true) : undefined;
  }

  fileByRel(rel: string): PhpFile | undefined {
    return this.file(`${this.root}/${rel}`);
  }

  /** How many files are loaded: grows when package files load on demand (FR-18.9). */
  get loadedFiles(): number {
    return this.files.size;
  }

  /** Every loaded file, first-party package files included. */
  allFiles(): PhpFile[] {
    this.ensureIndex();
    return [...this.files.values()];
  }

  /** The project's own files (not `vendor/`): entry points and callers are searched here. */
  projectFiles(): PhpFile[] {
    return this.allFiles().filter((f) => !f.vendor);
  }

  allClasses(): ClassDecl[] {
    this.ensureIndex();
    return [...this.classes.values()];
  }

  classByFqn(fqn: string | undefined): ClassDecl | undefined {
    if (!fqn) return undefined;
    this.ensureIndex();
    const name = fqn.replace(/^\\/, '');
    return this.classes.get(lower(name)) ?? this.loadFirstParty(name);
  }

  functionByFqn(fqn: string): FunctionDecl | undefined {
    this.ensureIndex();
    return this.functions.get(lower(fqn.replace(/^\\/, '')));
  }

  /** A class name as written (`Foo`, `Sub\Foo`, `\A\Foo`) → fully qualified (no leading `\`). */
  resolveClassName(name: string, scope: NameScope): string {
    if (name.startsWith('\\')) return this.globalAlias(name.slice(1));
    if (/^namespace\\/i.test(name)) return join(scope.namespace, name.slice('namespace\\'.length));
    const [first, ...rest] = name.split('\\');
    const alias = scope.classes.get(lower(first));
    if (alias) return rest.length ? `${alias}\\${rest.join('\\')}` : alias;
    return this.globalAlias(join(scope.namespace, name));
  }

  /** `config/app.php` → `'aliases' => ['Foo' => X::class]` of the project (lower-case name → class). */
  private configAliases: Map<string, string> | undefined;

  /** A global class name: a project class of that name, else a Laravel alias (project config first, then the defaults). */
  private globalAlias(fqn: string): string {
    if (fqn.includes('\\') || this.classes.has(lower(fqn))) return fqn;
    if (!this.configAliases) {
      this.configAliases = new Map();
      try {
        const text = fs.readFileSync(path.join(this.root, 'config', 'app.php'), 'utf8');
        const block = /'aliases'\s*=>[^[]*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
        for (const m of block.matchAll(/'(\w+)'\s*=>\s*\\?([\w\\]+)::class/g)) this.configAliases.set(lower(m[1]), m[2]);
      } catch {
        // no config/app.php: framework defaults only
      }
    }
    return this.configAliases.get(lower(fqn)) ?? laravelAlias(fqn);
  }

  /** A function call name → the project function or the global (built-in / library) one. */
  resolveFunctionName(name: string, scope: NameScope): string {
    if (name.startsWith('\\')) return name.slice(1);
    const alias = scope.functions.get(lower(name));
    if (alias) return alias;
    if (!name.includes('\\')) {
      const local = join(scope.namespace, name);
      return this.functionByFqn(local) ? local : name; // PHP falls back to the global function
    }
    return this.resolveClassName(name, scope);
  }

  /** The class itself, its parents, traits and interfaces (depth-first, each once). */
  ancestors(fqn: string): ClassDecl[] {
    const out: ClassDecl[] = [];
    const seen = new Set<string>();
    const visit = (name: string) => {
      const c = this.classByFqn(name);
      if (!c || seen.has(lower(c.fqn))) return;
      seen.add(lower(c.fqn));
      out.push(c);
      for (const t of c.traits) visit(t);
      for (const p of c.extends) visit(p);
      for (const i of c.implements) visit(i);
    };
    visit(fqn);
    return out;
  }

  private readonly traitUserCache = new Map<string, ClassDecl | null>();

  /**
   * The one class whose `$this` a trait's methods run on: the class using the trait (directly or through another
   * trait), not counting its subclasses. Undefined when no class or several unrelated classes use it.
   */
  soleTraitUser(trait: ClassDecl): ClassDecl | undefined {
    const key = lower(trait.fqn);
    if (!this.traitUserCache.has(key)) {
      const users = this.allClasses().filter((c) => c.kind !== 'trait' && c.kind !== 'interface' && c !== trait && this.ancestors(c.fqn).includes(trait));
      // a subclass of a user inherits the trait: only the topmost users count
      const top = users.filter((u) => !users.some((o) => o !== u && this.isSubtype(u.fqn, o.fqn)));
      this.traitUserCache.set(key, top.length === 1 ? top[0] : null);
    }
    return this.traitUserCache.get(key) ?? undefined;
  }

  /**
   * The classes, interfaces and traits deriving from a class (extends / implements / uses, transitively; not itself),
   * from an index built once per revision of the files.
   */
  subtypesOf(fqn: string): ClassDecl[] {
    if (this.subtypesRevision !== this.revision) {
      this.subtypes = new Map();
      for (const c of this.allClasses()) {
        for (const a of this.ancestors(c.fqn)) {
          if (a === c) continue;
          const k = lower(a.fqn);
          const list = this.subtypes.get(k);
          if (list) list.push(c);
          else this.subtypes.set(k, [c]);
        }
      }
      // (allClasses may load package files: the index is of the files as they are now)
      this.subtypesRevision = this.revision;
    }
    return this.subtypes.get(lower(fqn)) ?? [];
  }

  private subtypes = new Map<string, ClassDecl[]>();
  private subtypesRevision = -1;

  /** Is `sub` the class `sup` or derived from it (extends / implements, transitively)? */
  isSubtype(sub: string, sup: string): boolean {
    return this.ancestors(sub).some((c) => lower(c.fqn) === lower(sup));
  }
}

const join = (ns: string, name: string) => (ns ? `${ns}\\${name}` : name);

/** All `.php` files below a directory (not dependencies, caches, Blade templates), sorted. */
function listPhp(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.') && depth < 30) visit(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && e.name.endsWith('.php') && !e.name.endsWith('.blade.php') && !isIdeStub(e.name)) out.push(path.join(dir, e.name).replace(/\\/g, '/'));
    }
  };
  visit(root, 0);
  return out.sort();
}

function indexFile(file: PhpFile): void {
  const top: PNode[] = file.ast.children;
  const blocks: { scope: NameScope; nodes: PNode[] }[] = [];
  const global: NameScope = { namespace: '', classes: new Map(), functions: new Map() };
  let loose: PNode[] = [];
  for (const n of top) {
    if (n.kind === 'namespace') blocks.push({ scope: scopeOf(nameOf(n), n.children), nodes: n.children });
    else loose.push(n);
  }
  if (loose.length) {
    const s = scopeOf('', loose);
    global.classes = s.classes;
    global.functions = s.functions;
    blocks.unshift({ scope: global, nodes: loose });
  }
  loose = [];
  for (const { scope, nodes } of blocks) {
    for (const n of nodes) {
      if (n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait' || n.kind === 'enum') {
        if (n.isAnonymous || !nameOf(n)) continue;
        file.classes.push(classDecl(file, n, scope));
      } else if (n.kind === 'function') {
        const name = nameOf(n);
        if (!name) continue; // `function` typed, its name not yet
        file.functions.push({ fqn: join(scope.namespace, name), name, file, node: n, scope });
      }
    }
  }
}

export function scopeOf(namespace: string, nodes: PNode[]): NameScope {
  const scope: NameScope = { namespace, classes: new Map(), functions: new Map() };
  for (const n of nodes) {
    if (n.kind !== 'usegroup') continue;
    const prefix = n.name ? String(n.name).replace(/^\\/, '') : '';
    for (const item of n.items) {
      const full = (prefix ? `${prefix}\\${nameOf(item)}` : nameOf(item)).replace(/^\\/, '');
      const alias = item.alias ? nameOf(item.alias) : shortName(full);
      const type = item.type ?? n.type;
      if (type === 'function') scope.functions.set(lower(alias), full);
      else if (type !== 'const') scope.classes.set(lower(alias), full);
    }
  }
  return scope;
}

/** Type names of a doc tag: `@var ?Foo|null` → `?Foo|null`. */
export function docTag(doc: string | undefined, tag: string, variable?: string): string | undefined {
  if (!doc) return undefined;
  const re = new RegExp(`@${tag}\\s+`, 'g');
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    const type = readDocType(doc, m.index + m[0].length);
    if (!type) continue;
    if (!variable) return type;
    // `@param Type $name`: the type must be followed by the variable
    if (new RegExp(`^\\s+\\$${variable}\\b`).test(doc.slice(m.index + m[0].length + type.length))) return type;
  }
  return undefined;
}

/** A doc type at `start`, through generics and shapes with spaces (`Collection<int, Order>`, `array{id: int}`). */
function readDocType(doc: string, start: number): string {
  if (/^\$this\b/.test(doc.slice(start, start + 6))) return '$this'; // `@return $this`
  let depth = 0;
  let i = start;
  for (; i < doc.length; i++) {
    const ch = doc[i];
    if (ch === '<' || ch === '{' || ch === '(') depth++;
    else if ((ch === '>' || ch === '}' || ch === ')') && depth > 0) depth--;
    else if (depth === 0 && (/\s/.test(ch) || ch === '*' || ch === '$')) break;
  }
  return doc.slice(start, i);
}

/** The doc comment directly before a node, if any. */
export function docOf(n: PNode): string | undefined {
  const comments: PNode[] = n.leadingComments ?? [];
  const doc = [...comments].reverse().find((c) => c.kind === 'commentblock' && String(c.value).startsWith('/**'));
  return doc ? String(doc.value) : undefined;
}

function classDecl(file: PhpFile, n: PNode, scope: NameScope): ClassDecl {
  const project = { resolve: (name: string) => resolveIn(name, scope) };
  const kind = n.kind as ClassDecl['kind'];
  const ext = n.extends ? (Array.isArray(n.extends) ? n.extends : [n.extends]) : [];
  const decl: ClassDecl = {
    fqn: join(scope.namespace, nameOf(n)),
    name: nameOf(n),
    kind,
    isAbstract: !!n.isAbstract,
    file,
    node: n,
    scope,
    extends: ext.map((e: PNode) => project.resolve(nameOf(e))),
    implements: (n.implements ?? []).map((e: PNode) => project.resolve(nameOf(e))),
    traits: [],
    methods: new Map(),
    properties: new Map(),
    docProperties: new Map(),
    docMethods: new Map(),
  };
  const classDoc = docOf(n);
  for (const m of classDoc?.matchAll(/@property(?:-read|-write)?\s+([^\s*]+)\s+\$(\w+)/g) ?? []) decl.docProperties.set(m[2], m[1]);
  for (const m of classDoc?.matchAll(/@method\s+(?:static\s+)?([^\s*(]+)\s+(\w+)\s*\(/g) ?? []) decl.docMethods.set(lower(m[2]), m[1]);
  const templates = templateNames(classDoc);
  if (templates.size) decl.templates = templates;
  for (const member of childrenOf(n)) {
    if (member.kind === 'method') {
      decl.methods.set(lower(nameOf(member)), member);
      if (lower(nameOf(member)) === '__construct') {
        for (const p of member.arguments) {
          if (p.flags) decl.properties.set(nameOf(p), { name: nameOf(p), type: p.type ?? undefined, isStatic: false, node: p, promoted: true });
        }
      }
    } else if (member.kind === 'propertystatement') {
      const doc = docOf(member);
      for (const p of member.properties) {
        decl.properties.set(nameOf(p), { name: nameOf(p), type: p.type ?? undefined, docType: docTag(doc, 'var'), isStatic: !!member.isStatic, node: p, promoted: false });
      }
    } else if (member.kind === 'traituse') {
      for (const t of member.traits) decl.traits.push(project.resolve(nameOf(t)));
    }
  }
  return decl;
}

/** `@template T` / `@template-covariant TValue of Foo` names of a doc comment. */
export function templateNames(doc: string | undefined): Set<string> {
  return new Set([...(doc?.matchAll(/@(?:phpstan-|psalm-)?template(?:-covariant|-contravariant)?\s+(\w+)/g) ?? [])].map((m) => m[1]));
}

/** Name resolution without a project (declarations only need the scope). */
function resolveIn(name: string, scope: NameScope): string {
  if (name.startsWith('\\')) return laravelAlias(name.slice(1));
  const [first, ...rest] = name.split('\\');
  const alias = scope.classes.get(lower(first));
  if (alias) return rest.length ? `${alias}\\${rest.join('\\')}` : alias;
  return laravelAlias(join(scope.namespace, name));
}

/**
 * IDE stub files generated by laravel-ide-helper (`_ide_helper.php`, `_ide_helper_models.php`) and
 * PhpStorm's `.phpstorm.meta.php`: fake declarations of library classes (facades with bodies like
 * `$instance->error(…)`), not project code — analysing them turns every facade into a project class.
 */
export const isIdeStub = (fileName: string): boolean => /^_ide_helper.*\.php$/i.test(fileName) || /^\.phpstorm\.meta\.php$/i.test(fileName);

/**
 * Laravel's global class aliases (`\Log::error`, `DB::table` in the global namespace, `extends Eloquent`)
 * → the facade or class behind them (`config/app.php` → `aliases`, the framework defaults).
 */
const LARAVEL_ALIASES: Record<string, string> = Object.fromEntries([
  ...'App Artisan Auth Blade Broadcast Bus Cache Config Cookie Crypt Date DB Event File Gate Hash Http Js Lang Log Mail Notification Password Process Queue RateLimiter Redirect Redis Request Response Route Schema Session Storage URL Validator View Vite'
    .split(' ')
    .map((n) => [lower(n), `Illuminate\\Support\\Facades\\${n}`]),
  ['arr', 'Illuminate\\Support\\Arr'],
  ['str', 'Illuminate\\Support\\Str'],
  ['eloquent', 'Illuminate\\Database\\Eloquent\\Model'],
]);

/** A global (namespace-less) class name that is a Laravel alias → its target; anything else unchanged. */
export function laravelAlias(fqn: string): string {
  return fqn.includes('\\') ? fqn : LARAVEL_ALIASES[lower(fqn)] ?? fqn;
}
