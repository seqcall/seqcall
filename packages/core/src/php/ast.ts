import { Engine } from 'php-parser';
import type { Position, SourceRange } from '@seqcall/protocol';

/**
 * php-parser AST, typed loosely: nodes are plain objects with a `kind` and positions. After
 * parsing every node gets a `parent` link (the parser has none) so that fragments, results and
 * enclosing callables can be found by walking up.
 */
export interface PNode {
  kind: string;
  loc?: { start: { line: number; column: number; offset: number }; end: { line: number; column: number; offset: number } };
  parent?: PNode;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const engine = new Engine({
  parser: { php8: true, extractDoc: true, suppressErrors: true },
  ast: { withPositions: true, withSource: false },
});

/** The part of php-parser's lexer that reads inside `#[ … ]`. */
interface AttributeLexer {
  _input: string;
  offset: number;
  size: number;
  input(): string;
  matchST_ATTRIBUTE(this: AttributeLexer): string | number | null;
}

// php-parser 3.7 loops forever inside an unclosed attribute (`#[Attribute` while it is being typed) when only
// whitespace is left before the end of the text: its whitespace skip reads past the end (input() stays put there),
// steps back one character and starts again. Then the rest is read here, which ends the input.
const lexer = (engine as unknown as { lexer: AttributeLexer }).lexer;
const matchAttribute = lexer.matchST_ATTRIBUTE;
lexer.matchST_ATTRIBUTE = function () {
  for (let i = this.offset; i < this.size; i++) if (!' \t\n\r'.includes(this._input[i])) return matchAttribute.call(this);
  while (this.input());
  return null;
};

/**
 * Parses a file; syntax errors are tolerated (the parser recovers), never thrown. The text gets a trailing newline:
 * php-parser 3.7 also loops forever on a file that ends right after `enum` / `enum Name` (its lexer reads past the
 * end looking for the end of the name) — a file being typed in. Offsets of the file's own text do not change.
 */
export function parsePhp(code: string, file: string): PNode {
  let program: PNode;
  try {
    program = engine.parseCode(`${code}\n`, file) as unknown as PNode;
  } catch {
    // nesting deeper than the parser's recursion allows (generated code): the file counts as empty
    program = { kind: 'program', children: [], errors: [] };
  }
  link(program, undefined);
  return program;
}

const SKIP = new Set(['loc', 'parent', 'leadingComments', 'trailingComments']);

function link(n: PNode, parent: PNode | undefined): void {
  n.parent = parent;
  for (const key of Object.keys(n)) {
    if (SKIP.has(key)) continue;
    let v = n[key];
    if (Array.isArray(v)) {
      // half-typed code leaves holes (`$a->b(` → arguments [null], `match ($a) { => 1 }` → conds [null]): dropped
      if (v.some((c) => c === null || c === undefined)) v = n[key] = v.filter((c) => c !== null && c !== undefined);
      for (const c of v) if (c && typeof c === 'object' && typeof c.kind === 'string') link(c, n);
    } else if (v && typeof v === 'object' && typeof v.kind === 'string') link(v, n);
  }
}

/**
 * The child list kept on a node: the analyses walk the same bodies again and again (every callers search, every
 * flow, type lookups), and listing a node's children is a sort over its keys. A parsed tree is not changed afterwards
 * (an edited file is parsed anew), so the lists stay right; callers only read them. (A symbol on the node, not a
 * WeakMap: faster on a large project.)
 */
const CHILDREN = Symbol('children');

/** Direct child nodes in source order (by offset). (php-parser gives every node a position: `withPositions`.) */
export function children(n: PNode): readonly PNode[] {
  const memo = n as PNode & { [CHILDREN]?: readonly PNode[] };
  let list = memo[CHILDREN];
  if (!list) {
    list = childrenOf(n);
    // (not enumerable: a copy `{ ...n, arguments: [] }` lists its own children)
    Object.defineProperty(n, CHILDREN, { value: list });
  }
  return list;
}

/** `children` without keeping the list: for walks that visit a tree once (the index, the entry points). */
export function childrenOf(n: PNode): PNode[] {
  const out: PNode[] = [];
  for (const key of Object.keys(n)) {
    if (SKIP.has(key)) continue;
    const v = n[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c === 'object' && typeof c.kind === 'string') out.push(c);
    } else if (v && typeof v === 'object' && typeof v.kind === 'string') out.push(v);
  }
  return out.sort((a, b) => a.loc!.start.offset - b.loc!.start.offset);
}

/**
 * Pre-order walk; `visit` returns false to skip a node's children. (Whole-file walks — the index, the entry points —
 * run once per tree: the children are not kept, which would cost more than it saves there.)
 */
export function walk(n: PNode, visit: (n: PNode) => boolean | void): void {
  if (visit(n) === false) return;
  for (const c of childrenOf(n)) walk(c, visit);
}

/** Functions that are not part of the enclosing body (closures, arrow functions, nested classes). */
export const isNestedFunction = (n: PNode): boolean => n.kind === 'closure' || n.kind === 'arrowfunc' || n.kind === 'function' || n.kind === 'class' || n.kind === 'interface' || n.kind === 'trait' || n.kind === 'enum';

/** 0-based position of a node's start (php-parser lines are 1-based). */
export function startOf(n: PNode): Position {
  return { line: n.loc!.start.line - 1, character: n.loc!.start.column };
}

export function rangeOf(file: string, n: PNode): SourceRange {
  return {
    file,
    start: startOf(n),
    end: { line: n.loc!.end.line - 1, character: n.loc!.end.column },
  };
}

/** Range from the start of `a` to the end of `b`. */
export function spanOf(file: string, a: PNode, b: PNode): SourceRange {
  return { file, start: startOf(a), end: rangeOf(file, b).end };
}

/** Name text of an identifier / name node (a node's `name` is a string or another such node). */
export function nameOf(n: PNode | null | undefined): string {
  if (!n) return '';
  if (typeof n.name === 'string') return n.name;
  if (n.name && typeof n.name === 'object') return nameOf(n.name);
  return '';
}

/** Source text of a node (whitespace collapsed). */
export function textOf(src: string, n: PNode | undefined): string {
  if (!n?.loc) return '';
  return src.slice(n.loc.start.offset, n.loc.end.offset).replace(/\s+/g, ' ').trim();
}

/** Offset of a 0-based position in a source text. */
export function offsetAt(src: string, pos: Position): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const nl = src.indexOf('\n', offset);
    if (nl < 0) return src.length;
    offset = nl + 1;
  }
  return offset + pos.character;
}
