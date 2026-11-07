import type { SourceRange } from '@seqcall/protocol';
import type { CallSite, EarlyExit, FragmentScope } from './adapter';
import { LOGGING, LOGGING_CLASS } from './smart-expand';

/**
 * FR-3.9 the main path of a body: which branches (operands of its `if` / `switch` / `try` constructs) handle a
 * failure or bail out — a `catch`; a branch that throws; a guard clause (a branch that returns early — unless the
 * return is inside a loop or the branch is a dispatch on a variant, `kind == Kind.A`, `x is Foo`, a `switch` case,
 * which still counts when it returns a failure: `null`, `false`, `NotFound()`, `Result.Fail(…)`, a 4xx status); a
 * branch that builds an error (`new FooError(…)`, `Failure(…)`, `NotFound(…)`) or whose guard checks for one
 * (`!result.ok`, `status != Ok`, `IsFailure`, `x instanceof FooError`); the `else` of a success check and the other
 * branch of one that calls `Success(…)` / `Ok(…)`. Judged from guards, early exits and the calls of each branch
 * (no data flow). A missing value without an exit (`if (x is null) x = Create()`) is no failure. Loops, callbacks
 * and try blocks are the main path.
 */

const FAILURE_GUARD =
  /!\s*\(?[\w.?$>:-]*?(IsSuccess\w*|isSuccess\w*|\bok|\bsuccess|Succeeded|IsValid|isValid|\bvalid|Try\w+|is_valid|passes)\b|IsFailure|isFailure|HasError(?!\s*==\s*false)|hasError|\bFailed\b|isError\w*|instanceof \w*(Error|Exception)\b|\bis \w*(Error|Exception)\b|\binvalid|Invalid|\bfails?\(|denied|Denied|expired|Expired|blocked|Blocked|!==?\s*[\w.:$>-]*\b(Ok|OK|Success|SUCCESS|Succeeded)\b/;
const SUCCESS_GUARD =
  /^[^!]*\b(IsSuccess\w*|isSuccess\w*|ok|success|Succeeded)\b(?!\s*===?\s*false)|HasError\s*==\s*false|===?\s*[\w.:$>-]*\b(Ok|OK|Success|SUCCESS|Succeeded)\b|^[\w.$>-]*(error|Error|failure|Failure)\w*\s*(===?|is)\s*(null|undefined|nil)$|^!\s*[\w.$>-]*(err|Err)(or)?s?$/;
const FAILURE_VALUE =
  /^(null|undefined|false|default|\[\]|nil)$|NotFound|BadRequest|Unauthorized|Forbid|Problem|Conflict|UnprocessableEntity|StatusCode\(\s*[45]|\b[45]\d\d\b|\bFail|Failure|\berror|Error|abort|Invalid/i;
const SUCCESS_VALUE = /succe(ss|eded)|\bOk\(|['"](ok|OK)['"]|\.Ok\b/i;
/** A dispatch on a variant: a switch case (`kind = A`), equality with a constant, a type pattern. */
const VARIANT_GUARD = /\s=\s|^[^!|&]*\s===?\s*(([A-Z][\w.]*|self|static|parent)(\.|::)[A-Z_]\w*|'[^']*'|"[^"]*"|\d+)\s*$|\bis\s+[A-Z]\w*(\s+\w+)?\s*$/;
/** A call that builds a failure result (`Result.Failure(…)`, `NotFound()`, `abort(404)`). */
const FAILURE_CALL = /^(Fail|Failure|Failed|Error|Problem|NotFound|BadRequest|Unauthorized|Forbid|Conflict|UnprocessableEntity|abort|abort_if|abort_unless)$/i;
const SUCCESS_CALL = /^(Success|Succeed|Ok)$/i;
const ERROR_CLASS = /(Error|Exception)$/;

const isFailureGuard = (g: string) => FAILURE_GUARD.test(g);
const isSuccessGuard = (g: string) => SUCCESS_GUARD.test(g) && !FAILURE_GUARD.test(g);

interface Operand {
  scope: FragmentScope;
  throws: string[];
  returns: string[];
  /** Direct calls (innermost construct = this operand): "Failure", "new FooError". */
  builds: string[];
  succeeds: boolean;
  /** Returns what project code answers (`return await _callbacks.Process(…)`, `return Prepare(…)`): a dispatch. */
  delegates: boolean;
  /** Does work of its own before it returns (calls outside its returns, not logging, not building an error). */
  works: boolean;
}

/** Off-path operands of a body: `<construct id>#<operand>` → why ("catch Exception", "throws NotFound", …). */
export function offPathOperands(
  calls: readonly CallSite[],
  exits: readonly EarlyExit[],
  /** A project helper that only builds a failure (`UnsupportedCarrier()` → `Failure(new …Error)`); default: none. */
  failingHelper: (c: CallSite) => boolean = () => false,
): Map<string, string> {
  const operands = new Map<string, Operand>();
  const operand = (s: FragmentScope) => {
    const key = `${s.id}#${s.operand}`;
    let o = operands.get(key);
    if (!o) operands.set(key, (o = { scope: s, throws: [], returns: [], builds: [], succeeds: false, delegates: false, works: false }));
    return o;
  };
  for (const c of calls) {
    for (const s of c.fragments ?? []) operand(s);
    const inner = c.fragments?.at(-1);
    if (!inner) continue;
    const name = c.methodName.slice(c.methodName.lastIndexOf('.') + 1);
    const created = c.kind === 'create' ? (c.target?.owner.name ?? c.receiverType?.name ?? '') : '';
    if (ERROR_CLASS.test(created)) operand(inner).builds.push(`new ${created}`);
    else if (c.kind !== 'create' && FAILURE_CALL.test(name)) operand(inner).builds.push(name);
    else if (c.kind !== 'create' && SUCCESS_CALL.test(name)) operand(inner).succeeds = true;
    const logging = LOGGING.test(name) || LOGGING_CLASS.test(c.target?.owner.name ?? '');
    const returned = exits.some((e) => e.kind === 'return' && e.fragments?.at(-1)?.id === inner.id && within(c.range, e.range));
    if (!returned && !logging && c.kind !== 'create' && !FAILURE_CALL.test(name) && !c.isLibrary && c.target?.hasBody) operand(inner).works = true;
  }
  for (const e of exits) {
    const inner = e.fragments?.at(-1);
    if (!inner) continue;
    if (e.kind === 'return' && calls.some((c) => within(c.range, e.range) && delegation(c) && !failingHelper(c))) operand(inner).delegates = true;
    if (e.kind === 'throw') operand(inner).throws.push(e.exception ?? 'rethrow');
    // a return inside a loop / callback is often the success (found, done): judged by its value only
    else operand(inner).returns.push(e.fragments!.some((f) => f.kind === 'loop' || f.kind === 'callback') ? `loop:${e.value ?? '?'}` : (e.value ?? '?'));
  }
  const off = new Map<string, string>();
  const constructs = new Map<string, Operand[]>();
  for (const o of operands.values()) (constructs.get(o.scope.id) ?? constructs.set(o.scope.id, []).get(o.scope.id)!).push(o);
  for (const group of constructs.values()) {
    for (const o of group) {
      const why = reason(o);
      if (why) off.set(`${o.scope.id}#${o.scope.operand}`, why);
    }
    const [first, second] = [...group].sort((a, b) => a.scope.operand - b.scope.operand);
    if (group.length !== 2 || first.scope.kind !== 'alt') continue;
    const k1 = `${first.scope.id}#${first.scope.operand}`;
    const k2 = `${second.scope.id}#${second.scope.operand}`;
    // if (ok) … else …: the else handles the failure; `x ? Failure() : Success()` — the other side of a success
    if (second.scope.guard === 'else' && isSuccessGuard(first.scope.guard ?? '') && !off.has(k1)) off.set(k2, `else of [${first.scope.guard}]`);
    else if (first.succeeds && !second.succeeds && !off.has(k1)) off.set(k2, 'the other branch succeeds');
    else if (second.succeeds && !first.succeeds && !off.has(k2)) off.set(k1, 'the other branch succeeds');
  }
  return off;
}

function reason(o: Operand): string | undefined {
  const { scope } = o;
  if (scope.kind === 'loop' || scope.kind === 'callback') return undefined;
  if (scope.kind === 'try') return scope.operand > 0 ? (scope.guard ?? 'catch') : undefined;
  if (o.throws.length) return `throws ${o.throws[0]}`;
  // an else branch is judged by the negated condition of its if
  const guard = scope.guard === 'else' ? (scope.negatedGuard ?? '') : (scope.guard ?? '');
  const values = o.returns.map((v) => v.replace(/^loop:/, ''));
  const failure = values.find((v) => v !== '' && v !== '?' && FAILURE_VALUE.test(v) && !SUCCESS_VALUE.test(v));
  if (failure !== undefined) return `returns ${failure}`;
  // a guard clause: the method bails out here — it does nothing but return (no work of its own, no hand-over to project
  // code but a helper that builds a failure, no success), not on a dispatch on a variant, not on a success check
  // (`if (sent.IsSuccess) return;`: what follows handles the failure), not inside a loop
  const bails = o.returns.some((v) => !v.startsWith('loop:')) && !values.some((v) => SUCCESS_VALUE.test(v));
  if (bails && !o.works && !o.delegates && !VARIANT_GUARD.test(scope.guard ?? '') && !isSuccessGuard(guard)) return `returns early [${guard}]`;
  if (o.builds.length) return o.builds[0].startsWith('new ') ? `creates ${o.builds[0].slice(4)}` : `calls ${o.builds[0]}`;
  if (isFailureGuard(guard)) return `[${guard}]`;
  return undefined;
}

/** A call into project code (a method with a body), not one that builds a failure. */
function delegation(c: CallSite): boolean {
  return !c.isLibrary && !!c.target?.hasBody && c.kind !== 'create' && !FAILURE_CALL.test(c.methodName.slice(c.methodName.lastIndexOf('.') + 1));
}

/** FR-3.9 a helper whose body only builds a failure: `Failure(new FooError(…))`, `new FooException(…)`. */
export function onlyBuildsFailure(body: readonly CallSite[]): boolean {
  return body.length > 0 && body.every((c) => {
    const name = c.methodName.slice(c.methodName.lastIndexOf('.') + 1);
    return c.kind === 'create' ? ERROR_CLASS.test(c.target?.owner.name ?? c.receiverType?.name ?? '') : FAILURE_CALL.test(name);
  });
}

function within(inner: SourceRange, outer: SourceRange): boolean {
  const before = (a: { line: number; character: number }, b: { line: number; character: number }) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  return inner.file === outer.file && before(outer.start, inner.start) && before(inner.end, outer.end);
}

/** FR-3.11 an `opt` whose condition is a success check (`if (result.IsSuccess)`): on the main path it holds. */
export function holdsOnMainPath(scope: FragmentScope): boolean {
  return scope.kind === 'opt' && isSuccessGuard(scope.guard ?? '');
}

/** Why a call with these enclosing constructs is off the main path, or undefined when it is on it. */
export function offPathReason(scopes: readonly FragmentScope[] | undefined, off: ReadonlyMap<string, string>): string | undefined {
  for (const s of scopes ?? []) {
    const why = off.get(`${s.id}#${s.operand}`);
    if (why) return why;
  }
  return undefined;
}
