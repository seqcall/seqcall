import picomatch from 'picomatch';
import type { ClassKind, Importance, Message, Participant, SideEffectKind } from '@seqcall/protocol';
import { SIDE_EFFECT_LABEL } from './side-effects';

/**
 * FR-3.6 Smart expand: which calls matter for the dynamic behaviour. A call scores up when it
 * crosses a layer, reaches a port/service/repository…, has an implementation choice, does I/O
 * (FR-17) or fans out;
 * it scores down when it is a getter, a mapping, logging, a constructor or a library call.
 * Expanding a call is worth what it *reveals*: its own score plus the positive scores of the calls
 * in its body (scored from cached call sites — no extra analysis). The session expands the most
 * valuable calls first until nothing worth opening is left (FR-3.10: up to a cap of messages), and the view dims
 * the low ones. Projects tune it in `.seqcall.json`:
 *
 *   "smartExpand": { "budget": 30, "important": ["*.charge"], "unimportant": ["*Mapper.*", "Audit*.*"] }
 *
 * Patterns are globs on `Class.method` (case-sensitive).
 */
export interface SmartExpandConfig {
  /** FR-3.10 maximum number of messages of the diagram (or of the subtree for "from here"). Default 100. */
  budget?: number;
  important?: string[];
  unimportant?: string[];
}

/** FR-3.10 a cap, not a target: Smart stops earlier when nothing worth opening is left. */
export const DEFAULT_SMART_BUDGET = 100;
/** A call is expanded when own score + revealed value reaches this (and it reveals something). */
export const SMART_EXPAND_THRESHOLD = 3;
/** Revealed value counts at most this much (one fat method must not outrank everything). */
const MAX_REVEAL = 8;

export interface CompiledSmartConfig {
  budget: number;
  important: (name: string) => boolean;
  unimportant: (name: string) => boolean;
}

/** One side of a call, as far as importance is concerned. */
export interface CallEnd {
  /** Participant id or class key: equal ends = a self call. */
  id: string;
  className: string;
  layer?: string;
  stereotypes: string[];
  kind: ClassKind;
}

/** A call reduced to what scoring looks at (built message or raw call site). */
export interface CallFacts {
  methodName: string;
  kind: 'call' | 'self' | 'create';
  argCount: number;
  isLibrary: boolean;
  from?: CallEnd;
  to?: CallEnd;
  /** Number of implementations when the call needs a choice (FR-8). */
  implementations?: number;
  /** Calls in the target's body (0 when unknown / not expandable). */
  childCount: number;
  expandable: boolean;
  /** FR-17: I/O the call does (its target's body, or already analysed calls below). */
  io?: SideEffectKind[];
}

/** Stereotypes of collaborators whose calls carry the flow (role names from the classifier or config). */
const ROLE_STEREOTYPES = ['port', 'repository', 'gateway', 'adapter', 'service', 'controller', 'client', 'notifier', 'handler', 'usecase'];

const GETTER = /^(get|is|has)[A-Z_]/;
const MAPPING = /^(to|map|as|from|convert|format|serialize|deserialize|parse|stringify)([A-Z_]|$)/;
const MAPPING_CLASS = /(Mapper|Mapping|Converter|Formatter|Serializer|Dto|DTO)(Util|Utils|Helper|Helpers|Extensions)?$/;
export const LOGGING = /^(log|trace|debug|info|warn|warning|error|fatal|verbose)([A-Z_]|$)/i;
export const LOGGING_CLASS = /(Logger|Log|Logging|Telemetry|Metrics)$/;

export function compileSmartConfig(config: SmartExpandConfig | undefined): CompiledSmartConfig {
  const matcher = (globs: unknown) => {
    const list = Array.isArray(globs) ? globs.filter((g): g is string => typeof g === 'string' && g.length > 0) : [];
    return list.length ? picomatch(list, { dot: true }) : () => false;
  };
  const budget = Number(config?.budget);
  return {
    budget: Number.isFinite(budget) && budget >= 2 ? Math.floor(budget) : DEFAULT_SMART_BUDGET,
    important: matcher(config?.important),
    unimportant: matcher(config?.unimportant),
  };
}

/** Importance of one call by itself. */
export function scoreCall(f: CallFacts, config: CompiledSmartConfig = compileSmartConfig(undefined)): Importance {
  let score = 0;
  const reasons: string[] = [];
  const up = (n: number, why: string) => {
    score += n;
    reasons.push(`↑ ${why}`);
  };
  const down = (n: number, why: string) => {
    score -= n;
    reasons.push(`↓ ${why}`);
  };
  const { from, to } = f;
  // unresolved calls carry the expression (`_logger.LogError`): judge the member name
  const name = f.methodName.slice(f.methodName.lastIndexOf('.') + 1);
  // C# / PHP static style names start upper-case (`GetName`, `MapToResponse`): the name rules see `getName`
  const camel = name.charAt(0).toLowerCase() + name.slice(1);
  const className = to?.className ?? '';
  const create = f.kind === 'create';
  const other = !!to && to.id !== from?.id;

  if (config.important(`${className}.${name}`)) up(3, 'configured as important');
  if (config.unimportant(`${className}.${name}`)) down(3, 'configured as unimportant');
  if (f.isLibrary) down(3, 'library call');

  // creating an object is a step of the flow, not a hand-over to another layer
  if (!create && other && from?.layer && to?.layer && from.layer !== to.layer) up(3, `crosses ${from.layer} → ${to.layer}`);
  const role = !create && other ? ROLE_STEREOTYPES.find((r) => to!.stereotypes.includes(r)) : undefined;
  if (role) up(2, `«${role}»`);
  else if (!create && other && (to!.kind === 'interface' || to!.kind === 'abstract')) up(2, 'interface (port)');
  if (f.implementations) up(2, `implementation choice (${f.implementations})`);
  if (f.io?.length) up(2, `does I/O: ${f.io.map((k) => SIDE_EFFECT_LABEL[k]).join(', ')}`);
  if (f.childCount >= 4) up(2, `${f.childCount} calls below`);
  else if (f.childCount >= 2) up(1, `${f.childCount} calls below`);

  if (create) down(1, 'constructor');
  else if (LOGGING.test(name) || LOGGING_CLASS.test(className)) down(3, 'logging');
  else if (MAPPING.test(camel) || MAPPING_CLASS.test(className)) down(2, 'mapping / formatting');
  else if (GETTER.test(camel) && f.argCount === 0) down(2, 'getter');

  return { score, reasons, low: score < 0 };
}

/** Facts of a built message (participants from the same build). */
export function messageFacts(m: Message, from: Participant | undefined, to: Participant | undefined, childCount: number): CallFacts {
  const end = (p: Participant | undefined): CallEnd | undefined =>
    p && { id: p.id, className: p.className, layer: p.layer, stereotypes: p.stereotypes, kind: p.kind };
  return {
    methodName: m.methodName,
    kind: m.kind === 'found' ? 'call' : m.kind,
    argCount: m.args.length,
    isLibrary: m.isLibrary,
    from: end(from),
    to: end(to) && { ...end(to)!, className: m.className ?? to!.className },
    implementations: m.polymorphic?.implementations.length,
    childCount,
    expandable: m.expandable,
    ...(m.sideEffects ? { io: m.sideEffects.kinds } : {}),
  };
}

/** Value of expanding a call: the scores of the notable calls (≥ 2) it reveals (best first, for the reasons). */
export function revealValue(children: { name: string; importance: Importance }[]): { value: number; top: string[] } {
  const positive = children.filter((c) => c.importance.score >= 2).sort((a, b) => b.importance.score - a.importance.score);
  const value = Math.min(MAX_REVEAL, positive.reduce((sum, c) => sum + c.importance.score, 0));
  return { value, top: [...new Set(positive.map((c) => c.name))].slice(0, 3) };
}

/** Priority of expanding a call; undefined when it reveals nothing worth showing. */
export function expansionPriority(own: Importance, reveal: { value: number; top: string[] }): Importance | undefined {
  if (reveal.value <= 0) return undefined;
  const score = own.score + reveal.value;
  if (score < SMART_EXPAND_THRESHOLD) return undefined;
  return { score, reasons: [...own.reasons, `↑ reveals ${reveal.top.join(', ')}`], low: false };
}
