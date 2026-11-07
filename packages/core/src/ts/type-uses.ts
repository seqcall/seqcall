import ts from 'typescript';
import type { ClassRef } from '@seqcall/protocol';
import type { TypeUse } from '../adapter';
import { type CallableNode, type TsModel, instancePropertyInitializers } from './model';

/**
 * FR-12.12: project types a callable references — parameter / return types and every name in
 * the body that resolves to a project type (type annotations, `as`, `instanceof`, `typeof`,
 * generic arguments, `new X()`), an enum (member), a static member (→ its class) or a
 * module-level variable / function of another file (→ that module). Instance members, locals,
 * parameters and type parameters are not types; library declarations are skipped; the
 * callable's own class is skipped. One entry per type, at its first reference (source order).
 */
export function typeUses(model: TsModel, node: CallableNode): TypeUse[] {
  const own = model.ownerOf(node)?.key;
  const sf = node.getSourceFile();
  const out = new Map<string, TypeUse>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const ref = referencedType(model, n);
      if (ref && ref.key !== own && !out.has(ref.key)) out.set(ref.key, { type: ref, range: model.range(n, sf) });
      return;
    }
    // import("./x").T and JSDoc are not followed
    if (ts.isImportTypeNode(n)) return;
    ts.forEachChild(n, visit);
  };
  for (const root of rootsOf(model, node)) visit(root);
  return [...out.values()];
}

/** Signature and body of the callable (the whole declaration), field initialisers for constructors. */
function rootsOf(model: TsModel, node: CallableNode): ts.Node[] {
  if (ts.isClassLike(node)) return instancePropertyInitializers(node);
  const roots: ts.Node[] = [];
  if ((ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) && node.type) roots.push(node.type);
  const fn = model.functionOf(node);
  if (fn) roots.push(fn);
  if (ts.isConstructorDeclaration(node)) roots.push(...instancePropertyInitializers(node.parent));
  return roots;
}

export function referencedType(model: TsModel, id: ts.Identifier): ClassRef | undefined {
  let sym: ts.Symbol | undefined;
  try {
    sym = model.checker.getSymbolAtLocation(id);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = model.checker.getAliasedSymbol(sym);
    /* v8 ignore start -- TypeScript's checker throws on some broken code; no known input throws here, an unknown one must not fail the whole request */
  } catch {
    return undefined;
  }
  /* v8 ignore stop */
  if (!sym) return undefined;
  for (const decl of sym.declarations ?? []) {
    const sf = decl.getSourceFile();
    if (model.isLibraryFile(sf)) return undefined;
    const ref = declarationRef(model, decl, sf);
    if (ref) return ref;
  }
  return undefined;
}

function declarationRef(model: TsModel, decl: ts.Declaration, sf: ts.SourceFile): ClassRef | undefined {
  if (ts.isClassLike(decl) || ts.isInterfaceDeclaration(decl)) return model.classRef(decl);
  if (ts.isTypeAliasDeclaration(decl)) {
    const ref = model.classRef(decl);
    // object / function shapes are interfaces (ports); unions and other aliases are value types
    return ts.isTypeLiteralNode(decl.type) || ts.isFunctionTypeNode(decl.type) ? ref : { ...ref, kind: 'class' };
  }
  if (ts.isEnumDeclaration(decl)) return enumRef(model, decl, sf);
  if (ts.isEnumMember(decl)) return enumRef(model, decl.parent, sf);
  if (ts.isPropertyDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl)) {
    const isStatic = (ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Static) !== 0;
    return isStatic && ts.isClassLike(decl.parent) ? model.classRef(decl.parent) : undefined;
  }
  if (ts.isFunctionDeclaration(decl) && isModuleLevel(decl)) return model.moduleRef(sf);
  if (ts.isVariableDeclaration(decl) && ts.isVariableDeclarationList(decl.parent) && ts.isVariableStatement(decl.parent.parent) && isModuleLevel(decl.parent.parent)) {
    // an object literal of functions (a functional port implementation) is its own participant
    // a symbol's VariableDeclaration names an identifier (destructured names are declared by BindingElements)
    const name = (decl.name as ts.Identifier).text;
    const key = `${model.rel(sf.fileName)}#${name}`;
    if (model.isSyntheticOwner(key)) return { key, name, kind: 'class', declaration: model.range(decl.name, sf) };
    return model.moduleRef(sf);
  }
  return undefined;
}

function enumRef(model: TsModel, decl: ts.EnumDeclaration, sf: ts.SourceFile): ClassRef {
  return { key: `${model.rel(sf.fileName)}#${decl.name.text}`, name: decl.name.text, kind: 'class', declaration: model.range(decl.name, sf) };
}

function isModuleLevel(n: ts.Node): boolean {
  return ts.isSourceFile(n.parent) || ts.isModuleBlock(n.parent);
}
