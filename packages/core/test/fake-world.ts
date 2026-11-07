
import type { CallerInfo, ClassRef, EntryPoint, MethodRef, SourceRange } from '@seqcall/protocol';
import type { CallSite, ClassInfo, LanguageAdapter } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { DiagramSession, type DiagramSessionDeps } from '../src/session';

/**
 * A language adapter answering from tables written per test (no parser): for session states the sample projects
 * cannot produce — an adapter that fails, answers late, or whose methods disappear between two calls.
 */
export const at = (file: string, line: number, character = 0): SourceRange => ({ file: `/p/${file}`, start: { line, character }, end: { line, character: character + 5 } });
export const cls = (file: string, name: string, kind: ClassRef['kind'] = 'class'): ClassRef => ({ key: `${file}#${name}`, name, kind });
export const meth = (owner: ClassRef, name: string, extra: Partial<MethodRef> = {}): MethodRef =>
  ({ key: `${owner.key}.${name}`, name, owner, isStatic: false, hasBody: true, declaration: at(owner.key.slice(0, owner.key.indexOf('#')), 1), ...extra }) as MethodRef;
let line = 0;
export const call = (ordinal: number, target: MethodRef | undefined, extra: Partial<CallSite> = {}): CallSite => {
  line++;
  return { ordinal, kind: 'call', range: at('x.ts', line), methodName: target?.name ?? 'x', expressionText: `${target?.name ?? 'x'}()`, args: [], receiver: { kind: 'field', name: 'f' }, target, isAsync: false, isLibrary: false, ...extra } as CallSite;
};
export const info = (ref: ClassRef, extra: Partial<ClassInfo> = {}): ClassInfo =>
  ({ ref, decorators: [], implements: [], fields: [], constructorParams: [], hasPrivateConstructor: false, hasStaticInstance: false, allMembersStatic: false, isExportedInstance: false, methods: [], ...extra }) as ClassInfo;

export interface World {
  methods: MethodRef[];
  calls?: Record<string, CallSite[]>;
  impls?: Record<string, MethodRef[]>;
  infos?: ClassInfo[];
  callers?: Record<string, CallerInfo[]>;
  entryPoints?: EntryPoint[];
  /** Replaces or adds adapter members (a failing getEntryPoints, a getMethod that forgets …). */
  adapter?: Partial<Record<keyof LanguageAdapter, unknown>>;
}

export function fakeAdapter(w: World): LanguageAdapter {
  const methods = new Map(w.methods.map((m) => [m.key, m]));
  const infos = new Map((w.infos ?? []).map((i) => [i.ref.key, i]));
  return {
    projectRoot: '/p',
    findEnclosingCallable: async () => undefined,
    getMethod: async (k: string) => methods.get(k),
    getOutgoingCalls: async (m: MethodRef) => w.calls?.[m.key] ?? [],
    getImplementations: async (m: MethodRef) => w.impls?.[m.key] ?? [],
    getCallers: async (m: MethodRef) => w.callers?.[m.key] ?? [],
    getClassInfo: async (k: string) => infos.get(k),
    ...(w.entryPoints ? { getEntryPoints: async () => w.entryPoints! } : {}),
    updateFile: async () => undefined,
    dispose: async () => undefined,
    ...w.adapter,
  } as unknown as LanguageAdapter;
}

export function fakeSession(w: World, opts: { options?: Record<string, unknown>; classifier?: Classifier; deps?: Partial<DiagramSessionDeps> } = {}): DiagramSession {
  return new DiagramSession({
    ...opts.deps,
    adapter: fakeAdapter(w),
    classifier: opts.classifier ?? new DefaultClassifier('/nowhere', {}),
    initialState: { options: { showArguments: true, maxArgumentLength: 30, showLibraryCalls: false, followCursor: false, ...opts.options } as never },
  });
}

/** One line per message: `id from→to` with the participants' labels. */
export const flow = (d: { messages: { id: string; from?: string | null; to: string }[]; participants: { id: string; label: string }[] } | undefined) =>
  (d?.messages ?? []).map((m) => `${m.id} ${d!.participants.find((p) => p.id === m.from)?.label ?? '-'}→${d!.participants.find((p) => p.id === m.to)?.label}`);
