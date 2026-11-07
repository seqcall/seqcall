import type { CallerInfo, DiagramOptions, HideFilter, Message, SourceRange } from '@seqcall/protocol';
import { splitTrimmed } from '../text';

/** Collapses whitespace/newlines of a source snippet to a single line. */
export function normalizeSource(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncates to at most `max` characters (ellipsis included) — FR-9.2. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  return text.slice(0, max - 1).trimEnd() + '…';
}

// ───────────── argument abbreviation (FR-9, clutter-free by default) ─────────────

const QUOTES = '\'"`';

/** Index just past the string/template literal starting at `i` (`s[i]` is the quote). */
function skipString(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    if (q === '`' && c === '$' && s[i + 1] === '{') {
      const close = matchClose(s, i + 1);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    i++;
  }
  return s.length;
}

/** Index of the bracket closing the one at `open`, skipping literals; -1 if unbalanced. */
function matchClose(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (QUOTES.includes(c)) {
      i = skipString(s, i);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Removes `//` and block comments outside string/template literals. */
export function stripComments(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (QUOTES.includes(c)) {
      const j = skipString(s, i);
      out += s.slice(i, j);
      i = j;
    } else if (c === '/' && s[i + 1] === '/') {
      // Without a newline the comment's end is unknown (source already compacted): keep it.
      const nl = s.indexOf('\n', i);
      if (nl < 0) {
        out += s.slice(i);
        break;
      }
      i = nl;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
      out += ' ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Replaces every non-empty `{ … }` block (object literals, function bodies) by `{…}`. */
function collapseBlocks(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (QUOTES.includes(c)) {
      const j = skipString(s, i);
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === '{') {
      const close = matchClose(s, i);
      if (close > 0) {
        out += s.slice(i + 1, close).trim() ? '{…}' : '{}';
        i = close + 1;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const FUNCTION_RE = /^(?:async\s+)?function\b/;
const ARROW_RE = /^(?:async\s+)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*(?::[^=]*?)?=>/;

/**
 * Abbreviates one call argument for display: structurally noisy arguments are replaced
 * before length truncation — object literals → `{…}`, long array literals → `[…]`,
 * functions → `() => …` / `fn`, string/template literals truncated inside their quotes,
 * comments dropped and multi-line text collapsed to one line.
 */
export function abbreviateArgument(raw: string, max: number): string {
  const text = normalizeSource(stripComments(raw))
    .replace(/([([{])\s+/g, '$1')
    .replace(/(?<!\s)\s+([)\]}])/g, '$1');
  if (FUNCTION_RE.test(text)) return 'fn';
  const arrow = ARROW_RE.exec(text);
  if (arrow) {
    const params = (arrow[1] ?? arrow[2]).trim();
    if (params === '') return '() => …';
    if (params.length > 12) return '(…) => …';
    return arrow[2] !== undefined ? `${params} => …` : `(${params}) => …`;
  }
  const first = text[0];
  const close = matchClose(text, 0);
  const last = text[text.length - 1];
  // Unbalanced (-1) happens with quotes inside compacted comments; trust the outer brackets then.
  const enclosed = close === text.length - 1 || (close < 0 && ((first === '{' && last === '}') || (first === '[' && last === ']')));
  if (first === '{' && enclosed) return text === '{}' ? '{}' : '{…}';
  if (first === '[' && enclosed && text.length > max) return '[…]';
  if (QUOTES.includes(first) && skipString(text, 0) === text.length && text.length > max) {
    return text.slice(0, Math.max(1, max - 2)).trimEnd() + '…' + first;
  }
  if (text.length <= max) return text;
  return truncate(collapseBlocks(text), max);
}

export interface MessageLabel {
  /** FR-9.4 where the result goes, before everything else: "user =", "↩". */
  result?: string;
  /** Small marker before the name: "«create»", "async". */
  prefix?: string;
  /** Emphasised method name. */
  name: string;
  /** De-emphasised argument list incl. parentheses: "(id, …)". */
  args: string;
  /** Untruncated call for the tooltip. */
  full: string;
}

function displayName(m: Message): string {
  if (m.kind === 'create' && (m.methodName === 'constructor' || m.methodName === 'new')) return m.className ?? m.methodName;
  return m.methodName;
}

/** an unresolved call named by its expression: its type arguments say nothing on a label (the card has them). */
const withoutTypeArgs = (name: string): string => (name.includes('<') ? name.replace(/<(?:[^<>]|<[^<>]*>)*>/g, '<…>') : name);

/** Longest assignment target drawn before a call (the tooltip has the full text). */
const MAX_RESULT_TARGET = 16;

/** FR-9.4: "user =", "{a, b} =", "cache ??=", "↩" (returned); undefined when the result is unused. */
export function resultText(m: Message): string | undefined {
  const r = m.result;
  if (!r) return undefined;
  if (r.kind === 'return') return '↩';
  return `${truncate(normalizeSource(r.target), MAX_RESULT_TARGET)} ${r.operator}`;
}

/** Full call text in UML form, e.g. "user = UserRepository.findById(id): User" (tooltip). */
export function fullCallText(m: Message): string {
  const args = m.args.map(normalizeSource).join(', ');
  const owner = m.className && m.kind !== 'create' ? `${m.className}.` : m.kind === 'create' ? 'new ' : '';
  const result = m.result?.kind === 'return' ? 'return ' : m.result ? `${normalizeSource(m.result.target)} ${m.result.operator} ` : '';
  // FR-1.18 a property read / assignment that runs a getter / setter: no argument list
  const call = m.accessor
    ? `${result}«${m.accessor}» ${owner}${displayName(m)}${m.returnType ? `: ${m.returnType}` : ''}`
    : m.render
    ? `«render» <${m.methodName}${m.args.map((a) => ` ${a.startsWith('...') ? `{${normalizeSource(a)}}` : a}`).join('')} />` // FR-1.20
    : `${result}${m.isAsync ? 'async ' : ''}${owner}${displayName(m)}(${args})${m.returnType ? `: ${m.returnType}` : ''}`;
  if (m.viaParameter === undefined) return call;
  if (m.continuesPipeline) return `${call}\nvia parameter ${m.viaParameter}: passes the request on — to the next middleware, after the last one to the action`;
  if (m.methodKey) return `${call}\nvia parameter ${m.viaParameter}: the method the caller passed`;
  return `${call}\nparameter ${m.viaParameter} is a function: ${m.viaLambda ? 'the caller passed a lambda (its body is not drawn)' : 'what runs depends on the caller (show callers)'}`;
}

/**
 * FR-9: fits a whole argument list into `budget` characters (separators included). Arguments
 * are abbreviated structurally first; if the list is still too long the budget is shared fairly
 * ("water-filling"): short arguments stay whole, the rest is split among the long ones, so each
 * argument stays recognisable — `(coupon, allowMu…, token)`. When even 3 characters per
 * argument don't fit, the leading arguments are kept and the rest becomes `…`.
 */
export function fitArgumentList(raw: string[], budget: number): string[] {
  const args = raw.map((a) => abbreviateArgument(a, Math.max(3, budget)));
  const sep = 2;
  const total = args.reduce((n, a) => n + a.length, 0) + sep * Math.max(0, args.length - 1);
  if (total <= budget || !args.length) return args;
  const MIN = 3;
  let n = args.length;
  // Too many arguments for the budget: keep the leading ones and end with "…".
  while (n > 1 && n * MIN + sep * (n - 1) + (n < args.length ? sep + 1 : 0) > budget) n--;
  const kept = raw.slice(0, n);
  const ellipsis = n < args.length;
  const avail = budget - sep * (n - 1) - (ellipsis ? sep + 1 : 0);
  const lengths = args.slice(0, n).map((a) => a.length);
  const alloc = new Array<number>(n).fill(0);
  let remaining = avail;
  const order = lengths.map((len, i) => ({ len, i })).sort((a, b) => a.len - b.len);
  order.forEach(({ len, i }, k) => {
    const share = Math.floor(remaining / (n - k));
    alloc[i] = Math.max(MIN, Math.min(len, share));
    remaining -= alloc[i];
  });
  const out = kept.map((a, i) => (lengths[i] <= alloc[i] ? args[i] : abbreviateArgument(a, alloc[i])));
  return ellipsis ? [...out, '…'] : out;
}

/** FR-9: name emphasised, args abbreviated to a total budget, `name(…)` when args are off. */
export function formatMessageLabel(m: Message, options: Pick<DiagramOptions, 'showArguments' | 'maxArgumentLength' | 'showReturnTypes'>): MessageLabel {
  let args: string;
  if (m.accessor) args = '';
  else if (!options.showArguments) args = m.args.length ? '(…)' : '()';
  else args = `(${fitArgumentList(m.args, options.maxArgumentLength).join(', ')})`;
  const prefix = [m.kind === 'create' ? (m.instance ? `«create» #${m.instance}` : '«create»') : m.accessor ? `«${m.accessor}»` : m.render ? '«render»' : m.isAsync ? 'async' : undefined, delegatePrefix(m)].filter(Boolean).join(' ') || undefined;
  // FR-9.8: the short return type where the label shows no `x =` / ↩ (an argument, a condition, a chain)
  const type = !m.result && m.returnType && (m.kind === 'call' || m.kind === 'self') && !m.render && options.showReturnTypes !== false ? shortType(m.returnType) : undefined;
  if (type) args += `: ${type}`;
  return { result: resultText(m), prefix, name: withoutTypeArgs(displayName(m)), args, full: fullCallText(m) };
}

/** Types that tell nothing about the value (PHP `static` / `$this` / `mixed`, TS `any` / `unknown`): no label. */
const SILENT_TYPES = new Set(['void', 'never', 'any', 'unknown', 'mixed', 'static', 'self', '$this', 'object', 'dynamic', 'null', 'undefined']);

/**
 * FR-9.8 a return type short enough for a label: `Promise<T>` / `Task<T>` → T, namespaces dropped, `Foo<…>`, `{…}`,
 * more than two union members → `A | …`, cut at 16 characters; undefined when it tells nothing.
 */
export function shortType(t: string): string | undefined {
  const x = t.trim().replace(/^(Promise|Task|ValueTask)<(.*)>$/s, '$2').replace(/(?<!\w)\\?([A-Za-z_]\w*\\)+/g, '');
  const bare = splitTrimmed(x.replace(/^\?/, ''), '|').filter((p) => p !== 'null' && p !== 'undefined');
  if (bare.every((p) => SILENT_TYPES.has(p.toLowerCase()))) return undefined;
  let out = '';
  let depth = 0;
  for (let i = 0; i < x.length; i++) {
    const ch = x[i];
    if (ch === '{' || ch === '<') {
      if (depth++ === 0) out += ch === '{' ? '{…}' : '<…>';
      continue;
    }
    if ((ch === '}' || ch === '>') && depth > 0 && !(ch === '>' && x[i - 1] === '=')) {
      depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  const parts = splitTrimmed(out, '|');
  if (parts.length > 2) out = `${parts[0]} | …`;
  return out.length > 16 ? `${out.slice(0, 15)}…` : out;
}

/** FR-1.13: "format ⇒" before the method the caller passed; "ƒ" for an unresolved function parameter. */
function delegatePrefix(m: Message): string | undefined {
  if (m.viaParameter === undefined) return undefined;
  return m.methodKey ? `${m.viaParameter} ⇒` : 'ƒ';
}

export function describeHideFilter(f: HideFilter): string {
  switch (f.kind) {
    case 'methodName':
      return `All calls to ${f.methodName}`;
    case 'classMethod':
      return `Calls to ${f.className}.${f.methodName}`;
    case 'class':
      return `Class ${f.className}`;
    case 'classPattern':
      return `Classes named ${f.pattern}`;
    case 'stereotype':
      return `Every «${f.stereotype}» class`;
  }
}

export function baseName(file: string): string {
  const i = file.lastIndexOf('/');
  return i >= 0 ? file.slice(i + 1) : file;
}

/** "user-service.ts:42" (1-based line). */
export function formatLocation(r: SourceRange): string {
  return `${baseName(r.file)}:${r.start.line + 1}`;
}

export function callerTitle(c: CallerInfo): string {
  const owner = c.enclosing.owner;
  return owner && owner.kind !== 'module' && owner.name ? `${owner.name}.${c.enclosing.name}` : c.enclosing.name;
}
