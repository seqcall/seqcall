import type { ClassRef, MethodRef } from '@seqcall/protocol';
import { nameOf, rangeOf, type PNode } from './ast';
import { shortName, type ClassDecl, type FunctionDecl, type NameScope, type PhpFile, type PhpProject } from './project';
import { DeclarationTypeResolver, type PhpContext, type PhpTypeResolver } from './types';

/**
 * Keys (FR-18, same shape as TypeScript): class `src/Pay/Service.php#Service`, method
 * `src/Pay/Service.php#Service.create`, constructor `….#Service.constructor`, function
 * `src/helpers.php#<module>.money`. Library classes (not declared in the project): owner key
 * `lib:Illuminate\Support\Facades\Log`, method `lib:Illuminate\Support\Facades\Log#Log.info`;
 * built-in functions `lib:php#<global>.json_encode`.
 */
export const MODULE = '<module>';

/** A method / function of the project, with what is needed to analyse its body. */
export interface Callable {
  node: PNode;
  file: PhpFile;
  scope: NameScope;
  cls?: ClassDecl;
  fn?: FunctionDecl;
}

const lower = (s: string) => s.toLowerCase();
const methodName = (node: PNode) => (lower(nameOf(node)) === '__construct' ? 'constructor' : nameOf(node));

export class PhpModel {
  readonly types: PhpTypeResolver & DeclarationTypeResolver;

  constructor(readonly project: PhpProject, types?: PhpTypeResolver & DeclarationTypeResolver) {
    this.types = types ?? new DeclarationTypeResolver(project);
  }

  classRef(c: ClassDecl): ClassRef {
    const kind = c.kind === 'interface' ? 'interface' : c.isAbstract ? 'abstract' : 'class';
    return { key: `${c.file.rel}#${c.name}`, name: c.name, kind, declaration: rangeOf(c.file.abs, c.node.name) };
  }

  moduleRef(file: PhpFile): ClassRef {
    return { key: `${file.rel}#${MODULE}`, name: file.rel.replace(/^.*\//, '').replace(/\.php$/, ''), kind: 'module' };
  }

  /** A class that is not declared in the project (a library / framework / PHP class). */
  libraryClassRef(fqn: string): ClassRef {
    return { key: `lib:${fqn}`, name: shortName(fqn), kind: 'external' };
  }

  /** Project class by FQN, or a library ref. */
  refOfFqn(fqn: string): ClassRef {
    const c = this.project.classByFqn(fqn);
    return c ? this.classRef(c) : this.libraryClassRef(fqn);
  }

  /** "Illuminate", "Acme\Core" (two segments when there are more), "php" for global names. */
  libraryName(fqn: string): string {
    const parts = fqn.replace(/^\\/, '').split('\\');
    if (parts.length <= 1) return 'php';
    return parts.length > 2 ? `${parts[0]}\\${parts[1]}` : parts[0];
  }

  methodRef(c: ClassDecl, node: PNode): MethodRef {
    const name = methodName(node);
    const isInterface = c.kind === 'interface';
    return {
      key: `${c.file.rel}#${c.name}.${name}`,
      name,
      owner: this.classRef(c),
      isStatic: !!node.isStatic,
      declaration: rangeOf(c.file.abs, node.name),
      hasBody: !isInterface && !node.isAbstract && !!node.body,
    };
  }

  /** `new X()` for a class without a constructor in the project: nothing to expand, but a target to draw. */
  implicitConstructorRef(c: ClassDecl): MethodRef {
    const owner = this.classRef(c);
    return { key: `${owner.key}.constructor`, name: 'constructor', owner, isStatic: false, declaration: owner.declaration, hasBody: false };
  }

  functionRef(f: FunctionDecl): MethodRef {
    return {
      key: `${f.file.rel}#${MODULE}.${f.name}`,
      name: f.name,
      owner: this.moduleRef(f.file),
      isStatic: true,
      declaration: rangeOf(f.file.abs, f.node.name),
      hasBody: !!f.node.body,
    };
  }

  libraryMethodRef(fqn: string, name: string, isStatic: boolean): MethodRef {
    const owner = this.libraryClassRef(fqn);
    return { key: `${owner.key}#${owner.name}.${name}`, name, owner, isStatic, hasBody: false };
  }

  libraryFunctionRef(fqn: string): MethodRef {
    const lib = this.libraryName(fqn);
    const owner: ClassRef = { key: `lib:${lib}`, name: lib, kind: 'external' };
    return { key: `lib:${lib}#<global>.${shortName(fqn)}`, name: shortName(fqn), owner, isStatic: true, hasBody: false };
  }

  refOfCallable(c: Callable): MethodRef {
    return c.cls ? this.methodRef(c.cls, c.node) : this.functionRef(c.fn!);
  }

  /** `thisCls`: the class a trait method runs on (the one class using the trait, or the caller's choice). */
  context(c: Callable, thisCls?: ClassDecl): PhpContext {
    const self = thisCls ?? (c.cls?.kind === 'trait' ? this.project.soleTraitUser(c.cls) : undefined);
    return { file: c.file, scope: c.scope, cls: c.cls, ...(self ? { thisCls: self } : {}), callable: c.node };
  }

  /** `rel#Class.method` / `rel#<module>.fn` → the declaration. */
  callableByKey(key: string): Callable | undefined {
    const hash = key.indexOf('#');
    if (hash < 0 || key.startsWith('lib:')) return undefined;
    const file = this.project.fileByRel(key.slice(0, hash));
    if (!file) return undefined;
    const rest = key.slice(hash + 1);
    const dot = rest.lastIndexOf('.');
    if (dot < 0) return undefined;
    const owner = rest.slice(0, dot);
    const name = rest.slice(dot + 1);
    if (owner === MODULE) {
      const fn = file.functions.find((f) => f.name === name);
      return fn && { node: fn.node, file, scope: fn.scope, fn };
    }
    const cls = file.classes.find((c) => c.name === owner);
    const node = cls?.methods.get(name === 'constructor' ? '__construct' : lower(name));
    return cls && node ? { node, file, scope: cls.scope, cls } : undefined;
  }

  /** The innermost method / function of the file whose declaration contains the offset. */
  callableAt(file: PhpFile, offset: number): Callable | undefined {
    let best: Callable | undefined;
    const contains = (n: PNode) => !!n.loc && n.loc.start.offset <= offset && offset <= n.loc.end.offset;
    for (const cls of file.classes) {
      if (!contains(cls.node)) continue;
      for (const m of cls.methods.values()) if (contains(m)) best = { node: m, file, scope: cls.scope, cls };
    }
    for (const fn of file.functions) if (contains(fn.node)) best = { node: fn.node, file, scope: fn.scope, fn };
    return best;
  }

  /** All callables of the project (for callers / entry points). */
  *allCallables(): Generator<Callable> {
    // the project's own files only: first-party package files are loaded on demand (FR-18.9)
    yield* this.callablesIn(this.project.projectFiles());
  }

  /** Every method and function of the given files. */
  *callablesIn(files: Iterable<PhpFile>): Generator<Callable> {
    for (const file of files) {
      for (const cls of file.classes) for (const m of cls.methods.values()) yield { node: m, file, scope: cls.scope, cls };
      for (const fn of file.functions) yield { node: fn.node, file, scope: fn.scope, fn };
    }
  }
}
