import type { ClassRef } from '@seqcall/protocol';
import type { ClassInfo, FieldInfo, ModuleFacts } from '../adapter';
import { nameOf, rangeOf, textOf, walk, type PNode } from './ast';
import { MODULE, type PhpModel } from './model';
import type { ClassDecl } from './project';

const lower = (s: string) => s.toLowerCase();

/** A declared type node → the class it names (project or library), else undefined. */
function typeRef(model: PhpModel, c: ClassDecl, t: PNode | string | undefined): ClassRef | undefined {
  const fqn = model.types.typeNodeName(t, c.scope, c);
  return fqn ? model.refOfFqn(fqn) : undefined;
}

function signature(c: ClassDecl, m: PNode): string {
  const src = c.file.src;
  const typeText = (n: PNode) => `${n.nullable ? '?' : ''}${textOf(src, n.type)}`; // `?` is a flag, not in the type node
  const params = m.arguments.map((p: PNode) => `${p.type ? `${typeText(p)} ` : ''}$${nameOf(p)}`).join(', ');
  const name = lower(nameOf(m)) === '__construct' ? 'constructor' : nameOf(m);
  return `${name}(${params})${m.type ? `: ${typeText(m)}` : ''}`;
}

/** Structural info of a PHP class / interface / trait / enum (stereotypes, layers, class diagram). */
export function classInfo(model: PhpModel, classKey: string): ClassInfo | undefined {
  const hash = classKey.indexOf('#');
  const file = model.project.fileByRel(classKey.slice(0, hash));
  const name = classKey.slice(hash + 1);
  if (!file) return undefined;
  if (name === MODULE) {
    return {
      ref: model.moduleRef(file),
      file: file.abs,
      decorators: [],
      implements: [],
      fields: [],
      constructorParams: [],
      hasPrivateConstructor: false,
      hasStaticInstance: false,
      allMembersStatic: true,
      isExportedInstance: false,
      methods: file.functions.map((f) => ({ name: f.name, isStatic: true, signature: `${f.name}()` })),
    };
  }
  const c = file.classes.find((x) => x.name === name);
  if (!c) return undefined;
  const ctor = c.methods.get('__construct');
  const ctorParams: PNode[] = ctor?.arguments ?? [];
  // `$this->repo = $repo` in the constructor: the field is injected
  const assignedFromParam = new Set<string>();
  if (ctor?.body) {
    const names = new Set(ctorParams.map((p) => nameOf(p)));
    walk(ctor.body, (n) => {
      if (n.kind === 'assign' && n.left?.kind === 'propertylookup' && n.left.what?.name === 'this' && n.right?.kind === 'variable' && names.has(n.right.name)) {
        assignedFromParam.add(nameOf(n.left.offset));
      }
    });
  }
  const fields: FieldInfo[] = [...c.properties.values()].map((p) => {
    // FR-12.15 a documented collection (`@var Order[]`, `Collection<int, Order>`): the element, many
    const element = collectionElement(p.docType);
    const elementRef = element ? typeRef(model, c, element) : undefined;
    const type = elementRef ?? typeRef(model, c, p.type) ?? typeRef(model, c, p.docType);
    return { name: p.name, ...(type ? { type } : {}), ...(elementRef ? { collection: true } : {}), isStatic: p.isStatic, injected: p.promoted || assignedFromParam.has(p.name), declaration: rangeOf(c.file.abs, p.node) };
  });
  const methods = [...c.methods.values()];
  const members = [...methods, ...c.properties.values()];
  const own = lower(c.fqn);
  const attrs = (n: PNode) => n.attrGroups.flatMap((g: PNode) => g.attrs.map((a: PNode) => nameOf(a).replace(/^.*\\/, '')));
  return {
    ref: model.classRef(c),
    file: file.abs,
    decorators: attrs(c.node),
    ...(c.extends[0] ? { extends: model.refOfFqn(c.extends[0]) } : {}),
    implements: (c.kind === 'interface' ? c.extends : c.implements).map((i) => model.refOfFqn(i)),
    fields,
    constructorParams: ctorParams.map((p) => {
      const type = typeRef(model, c, p.type);
      return { name: nameOf(p), ...(type ? { type } : {}) };
    }),
    hasPrivateConstructor: ctor?.visibility === 'private',
    hasStaticInstance:
      [...c.properties.values()].some((p) => p.isStatic && lower(model.types.typeNodeName(p.type, c.scope, c) ?? '') === own) ||
      methods.some((m) => m.isStatic && /^(getInstance|instance)$/i.test(nameOf(m))),
    allMembersStatic: members.length > 0 && methods.every((m) => m.isStatic || lower(nameOf(m)) === '__construct') && [...c.properties.values()].every((p) => p.isStatic),
    isExportedInstance: false,
    methods: methods.map((m) => ({
      name: lower(nameOf(m)) === '__construct' ? 'constructor' : nameOf(m),
      isStatic: !!m.isStatic,
      signature: signature(c, m),
      // FR-12.18 private / protected rows are hidden in the class box until shown
      ...(m.visibility === 'private' || m.visibility === 'protected' ? { visibility: m.visibility as 'private' | 'protected' } : {}),
    })),
    ...(isDataOnly(model, c, new Set()) ? { dataOnly: true } : {}),
  };
}

/**
 * FR-7.15 the class's own code (and its traits') only holds data: constants, properties, a constructor that only
 * stores values, methods that only return a field / constant or set a field (`return $this` allowed). Not an enum: a
 * status or a kind is the domain's vocabulary, so it keeps its folder's layer.
 */
function isDataOnly(model: PhpModel, c: ClassDecl, seen: Set<ClassDecl>): boolean {
  if (c.kind === 'enum') return false;
  seen.add(c);
  for (const [name, m] of c.methods) {
    if (!m.body) return false; // abstract: a subclass's behaviour
    const statements: PNode[] = m.body.children;
    if (!(name === '__construct' ? statements.every(storesValue) : isAccessorBody(statements, m.arguments.length))) return false;
  }
  return c.traits.every((t) => {
    const trait = model.project.classByFqn(t);
    return !!trait && (seen.has(trait) || isDataOnly(model, trait, seen));
  });
}

/** `return <plain>` (a getter takes no arguments), `$this->x = <plain>`, or a set followed by `return $this`. */
function isAccessorBody(statements: PNode[], params: number): boolean {
  const [first, second] = statements;
  if (statements.length === 1 && first.kind === 'return') return params === 0 && (!first.expr || isPlain(first.expr));
  if (!storesValue(first) || statements.length > 2) return false;
  return !second || (second.kind === 'return' && second.expr?.kind === 'variable' && second.expr.name === 'this');
}

/** `$this->x = <plain>` or `parent::__construct(<plain>…)`. */
function storesValue(s: PNode | undefined): boolean {
  if (s?.kind !== 'expressionstatement') return false;
  const e = s.expression;
  if (e.kind === 'assign') return e.operator === '=' && isField(e.left) && isPlain(e.right);
  return e.kind === 'call' && e.what.kind === 'staticlookup' && e.what.what.kind === 'parentreference' && lower(nameOf(e.what.offset)) === '__construct' && e.arguments.every(isPlain);
}

function isField(e: PNode): boolean {
  return (e.kind === 'propertylookup' || e.kind === 'nullsafepropertylookup') && e.what.kind === 'variable' && e.what.name === 'this' && e.offset.kind === 'identifier';
}

/** A value read without logic: a variable, a literal, a field, a class constant, an array of those. */
function isPlain(e: PNode | null | undefined): boolean {
  if (!e) return true;
  switch (e.kind) {
    case 'variable':
    case 'string':
    case 'number':
    case 'boolean':
    case 'nullkeyword':
    case 'name':
      return true;
    case 'propertylookup':
    case 'nullsafepropertylookup':
      return isField(e);
    case 'staticlookup':
      return e.offset.kind === 'identifier' && e.what.kind !== 'variable';
    case 'array':
      return e.items.every((i: PNode) => !i.unpack && isPlain(i.key) && isPlain(i.value));
    default:
      return false;
  }
}

/**
 * FR-7.7 facts over the whole file: libraries = fully qualified library classes it references
 * (`Illuminate\Support\Facades\Http`, so FR-17 can tell the kind of I/O), ports = project
 * interfaces / abstract classes it takes as parameter / property types, dependsOn = project types.
 */
export function moduleFacts(model: PhpModel, classKey: string): ModuleFacts | undefined {
  const file = model.project.fileByRel(classKey.slice(0, classKey.indexOf('#')));
  if (!file) return undefined;
  const libraries = new Set<string>();
  const deps = new Map<string, ClassRef>();
  const ports = new Set<string>();
  const self = new Set(file.classes.map((c) => lower(c.fqn)));
  const scopes = file.classes.length ? file.classes.map((c) => c.scope) : file.functions.map((f) => f.scope);
  const note = (fqn: string | undefined) => {
    if (!fqn || self.has(lower(fqn))) return;
    const c = model.project.classByFqn(fqn);
    if (c) deps.set(lower(c.fqn), model.classRef(c));
    else if (fqn.includes('\\')) libraries.add(fqn);
  };
  for (const scope of scopes) for (const fqn of scope.classes.values()) note(fqn);
  for (const c of file.classes) {
    walk(c.node, (n) => {
      if (n.kind === 'name' && n.resolution !== undefined) {
        const parent = n.parent?.kind;
        if (parent === 'call' && n.parent?.what === n) return; // a function name, not a class
        note(model.project.resolveClassName(nameOf(n), c.scope));
      }
      if (n.kind === 'parameter' || n.kind === 'property') {
        const fqn = model.types.typeNodeName(n.type ?? undefined, c.scope, c);
        const t = fqn && model.project.classByFqn(fqn);
        if (t && (t.kind === 'interface' || t.isAbstract)) ports.add(t.name);
      }
    });
  }
  return { ports: [...ports], libraries: [...libraries], dependsOn: [...deps.values()] };
}

/** Doc-type names of collections whose (last) type argument is the element. */
const COLLECTION_TYPES = /(?:^|\\)(?:array|list|non-empty-array|non-empty-list|iterable|Traversable|Iterator|IteratorAggregate|Generator|ArrayAccess|ArrayObject|SplObjectStorage|Collection|LazyCollection|EloquentCollection|ArrayCollection|Set|Map|Vector|Sequence)$/i;

/**
 * FR-12.15 the element type named in a documented collection: `Order[]`, `?Order[]`, `array<Order>`,
 * `array<int, Order>`, `list<Order>`, `Collection<int, Order>`, `Collection|Order[]`; undefined for a
 * single object or scalars (`int[]`, `array<string, mixed>` say nothing about a class).
 */
export function collectionElement(doc: string | undefined): string | undefined {
  if (!doc) return undefined;
  for (let part of splitTopLevel(doc)) {
    part = part.trim().replace(/^\?/, '').replace(/^\(|\)$/g, '');
    const arr = /^([\\A-Za-z_][\\\w]*)\[\]$/.exec(part);
    if (arr) return arr[1];
    const gen = /^([\\A-Za-z_][\\\w-]*)<(.+)>$/.exec(part);
    if (gen && COLLECTION_TYPES.test(gen[1])) {
      const args = splitTopLevel(gen[2], ',');
      const last = args[args.length - 1]?.trim();
      if (last && /^[\\A-Za-z_][\\\w]*$/.test(last)) return last;
    }
  }
  return undefined;
}

/** Splits at `sep` outside `<…>` (`Collection<int, A>|B[]` → two parts). */
function splitTopLevel(text: string, sep = '|'): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

