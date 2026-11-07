import * as path from 'node:path';
import ts from 'typescript';
import type { ClassRef } from '@seqcall/protocol';
import type { ModuleFacts } from '../adapter';
import type { TsModel } from './model';
import { referencedType } from './type-uses';

/**
 * FR-7.7 facts of a whole source file (TS: a module or a class is judged by its file): the libraries
 * it imports, the project types / modules it references, and the ports it takes — parameter or
 * field types that are records of functions, abstract classes or named function types (dependency
 * injection, functional ports). Domain code takes data, not services.
 */
const memo = new WeakMap<TsModel, Map<string, ModuleFacts>>();

export function moduleFacts(model: TsModel, classKey: string): ModuleFacts {
  const rel = classKey.slice(0, classKey.indexOf('#'));
  let perModel = memo.get(model);
  if (!perModel) memo.set(model, (perModel = new Map()));
  const known = perModel.get(rel);
  if (known) return known;
  const facts = fileFacts(model, rel);
  perModel.set(rel, facts);
  return facts;
}

function fileFacts(model: TsModel, rel: string): ModuleFacts {
  const sf = model.getSourceFile(path.join(model.projectRoot, rel));
  const facts: ModuleFacts = { ports: [], libraries: [], dependsOn: [] };
  if (!sf || model.isLibraryFile(sf)) return facts;
  const libraries = new Set<string>();
  const deps = new Map<string, ClassRef>();
  const ports = new Set<string>();

  for (const st of sf.statements) {
    const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier : undefined;
    if (!spec) continue;
    const target = model.checker.getSymbolAtLocation(spec)?.declarations?.[0]?.getSourceFile();
    if (ts.isImportDeclaration(st) && onlyChecksOrTypes(st)) continue;
    if (target ? model.isLibraryFile(target) : !spec.text.startsWith('.')) libraries.add(spec.text);
  }

  let jsx = false;
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isImportTypeNode(n)) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) jsx = true;
    if (ts.isIdentifier(n)) {
      if (callsGlobalFetch(model, n)) libraries.add('fetch');
      const ref = referencedType(model, n);
      if (ref && !ref.key.startsWith(`${rel}#`)) deps.set(ref.key, ref);
      return;
    }
    if (ts.isTypeReferenceNode(n) && takesAsDependency(n)) {
      const name = portName(model, n);
      if (name) ports.add(name);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { ports: [...ports], libraries: [...libraries], dependsOn: [...deps.values()], ...(jsx ? { jsx } : {}) };
}

/**
 * FR-17.2 a call of the global `fetch` (Node 18+, browsers): HTTP without an import, listed as the library `fetch`
 * (a `ShopApiClient`). A function of the project named `fetch` is not it.
 */
function callsGlobalFetch(model: TsModel, n: ts.Identifier): boolean {
  if (n.text !== 'fetch' || !ts.isCallExpression(n.parent) || n.parent.expression !== n) return false;
  const decls = model.checker.getSymbolAtLocation(n)?.declarations ?? [];
  return decls.every((d) => model.isLibraryFile(d.getSourceFile()));
}

/**
 * FR-7.13 an import that uses none of the library's work: types only (`import type`), or only checks and error
 * classes (`import { isCancel, AxiosError } from 'axios'` — an error helper does no I/O). A default or namespace
 * import counts.
 */
function onlyChecksOrTypes(st: ts.ImportDeclaration): boolean {
  const clause = st.importClause;
  if (!clause) return false; // `import 'x'`: run for its effects
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const named = clause.namedBindings;
  if (!named || !ts.isNamedImports(named) || !named.elements.length) return false;
  return named.elements.every((e) => e.isTypeOnly || /^is[A-Z]\w*$|(Error|Exception)$/.test((e.propertyName ?? e.name).text));
}

/** The type annotation of a parameter or of a class field (directly, or as an array element / union member). */
function takesAsDependency(ref: ts.TypeReferenceNode): boolean {
  let n: ts.Node = ref;
  while (ts.isUnionTypeNode(n.parent) || ts.isArrayTypeNode(n.parent) || ts.isParenthesizedTypeNode(n.parent) || ts.isTypeOperatorNode(n.parent)) n = n.parent;
  const p = n.parent;
  return (ts.isParameter(p) || ts.isPropertyDeclaration(p)) && p.type === n;
}

/** Name of the referenced type when it is a service abstraction (a port), else undefined. */
function portName(model: TsModel, ref: ts.TypeReferenceNode): string | undefined {
  let sym = model.checker.getSymbolAtLocation(ref.typeName);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = model.checker.getAliasedSymbol(sym);
  for (const decl of sym?.declarations ?? []) {
    if (model.isLibraryFile(decl.getSourceFile())) return undefined;
    if (ts.isClassDeclaration(decl)) return (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Abstract) !== 0 ? decl.name?.text : undefined;
    if ((ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl)) && isPortType(model, model.checker.getTypeAtLocation(decl.name), 0)) return decl.name.text;
  }
  return undefined;
}

/**
 * A function type, or a record whose members are all functions or such records (a bundle of
 * ports, `{ listBranches: BranchLister; dispose: Disposal }`) — two levels deep.
 */
function isPortType(model: TsModel, type: ts.Type, depth: number): boolean {
  const props = type.getProperties();
  if (!props.length) return type.getCallSignatures().length > 0;
  if (depth >= 2 || type.getCallSignatures().length) return false;
  return props.every((p) => {
    const decl = p.valueDeclaration ?? p.declarations?.[0];
    // a member of a mapped type over literal keys (`Record<'save' | 'load', Fn>`) has no declaration: its type decides
    if (!decl) return isPortType(model, model.checker.getTypeOfSymbol(p), depth + 1);
    if (model.isLibraryFile(decl.getSourceFile())) return false;
    if (ts.isMethodSignature(decl) || ts.isMethodDeclaration(decl)) return true;
    return isPortType(model, model.checker.getTypeOfSymbolAtLocation(p, decl), depth + 1);
  });
}
