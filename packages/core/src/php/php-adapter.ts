import type { CallerInfo, ClassRef, EntryPoint, MethodRef, Position } from '@seqcall/protocol';
import type { CallSite, ClassInfo, ContainerBinding, EarlyExit, FileType, LanguageAdapter, ModuleFacts, ReturnFact, TypeUse } from '../adapter';
import { containerBindings } from './bindings';
import { TestFileMatcher } from '../test-files';
import { nameOf, offsetAt } from './ast';
import { outgoingCalls } from './calls';
import { type CallsByName, findCallers, findImplementations } from './callers';
import { classInfo, moduleFacts } from './class-info';
import { phpEntryPoints } from './entry-points';
import { earlyExits } from './fragments';
import { returnFacts } from './returns';
import { phpTypeUses } from './type-uses';
import { PhpModel } from './model';
import { PhpProject } from './project';
import { bladeCallNames } from './templates';

/**
 * FR-18 LanguageAdapter for PHP, in-process (no PHP runtime needed): php-parser + a declaration-based
 * type resolver (typed parameters / properties / promoted constructor parameters, return types,
 * PHPDoc). The resolver sits behind `PhpTypeResolver` so a stronger engine can replace it later.
 */
export class PhpAdapter implements LanguageAdapter {
  readonly projectRoot: string;
  private readonly project: PhpProject;
  private readonly model: PhpModel;
  private readonly testFiles: TestFileMatcher;
  private readonly isTest = (rel: string): boolean => this.testFiles.isTest(rel);
  private readonly classInfoCache = new Map<string, ClassInfo | undefined>();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
    this.project = new PhpProject(this.projectRoot);
    this.model = new PhpModel(this.project);
    this.testFiles = new TestFileMatcher(this.projectRoot);
  }

  /** FR-16.10 parses and indexes the project's files now (else the first request does). */
  async warmUp(): Promise<void> {
    this.project.allFiles();
  }

  async findEnclosingCallable(file: string, position: Position): Promise<MethodRef | undefined> {
    const f = this.project.file(file);
    if (!f) return undefined;
    const c = this.model.callableAt(f, offsetAt(f.src, position));
    return c && this.model.refOfCallable(c);
  }

  /** FR-31.1 the file's classes (and its module for functions) with their methods. */
  async getFileTypes(file: string): Promise<FileType[]> {
    const f = this.project.file(file);
    if (!f) return [];
    const out: FileType[] = f.classes.map((c) => ({ type: this.model.classRef(c), methods: [...c.methods.values()].map((n) => this.model.methodRef(c, n)) }));
    if (f.functions.length) out.push({ type: this.model.moduleRef(f), methods: f.functions.map((fn) => this.model.functionRef(fn)) });
    return out;
  }

  /** FR-31.3 */
  async getTemplateCallNames(): Promise<Map<string, number>> {
    return bladeCallNames(this.projectRoot);
  }

  /** FR-31.1 */
  async getProjectTypes(): Promise<FileType[]> {
    const out: FileType[] = [];
    for (const f of this.project.projectFiles()) out.push(...(await this.getFileTypes(f.abs)));
    return out;
  }

  async getMethod(key: string): Promise<MethodRef | undefined> {
    const c = this.model.callableByKey(key);
    return c && this.model.refOfCallable(c);
  }

  /**
   * Per-method query results, until a file changes or package files load on demand (their types can resolve calls
   * that did not resolve before): the design-issue scan, the unreachable-code search (FR-31) and the diagrams ask
   * the same methods again.
   */
  private readonly memo = new Map<string, unknown[]>();
  private memoFiles = -1;

  /** `compute`, once per method while no file changes or loads; lists come back as copies (callers may sort them). */
  private cached<T>(query: string, method: MethodRef, compute: () => T[]): T[] {
    // (counted before: files the query loads drop its answer at the next query)
    if (this.project.loadedFiles !== this.memoFiles) this.memo.clear();
    this.memoFiles = this.project.loadedFiles;
    const slot = `${query}\0${method.key}`;
    let value = this.memo.get(slot) as T[] | undefined;
    if (value === undefined) this.memo.set(slot, (value = compute()));
    return [...value];
  }

  async getOutgoingCalls(method: MethodRef): Promise<CallSite[]> {
    return this.cached('calls', method, () => {
      const c = this.model.callableByKey(method.key);
      return c ? outgoingCalls(this.model, c) : [];
    });
  }

  async getImplementations(method: MethodRef): Promise<MethodRef[]> {
    return this.cached('impl', method, () => findImplementations(this.model, method, this.isTest));
  }

  /**
   * The calls found per name by the callers search, until a file changes or package files load on demand (their
   * types can resolve calls that did not resolve before).
   */
  private readonly callsByName: CallsByName = new Map();
  private callsByNameFiles = -1;

  async getCallers(method: MethodRef): Promise<CallerInfo[]> {
    // (counted before the search: files it loads clear the scans at the next search)
    if (this.project.loadedFiles !== this.callsByNameFiles) this.callsByName.clear();
    this.callsByNameFiles = this.project.loadedFiles;
    return findCallers(this.model, method, this.isTest, this.callsByName);
  }

  async getClassInfo(classKey: string): Promise<ClassInfo | undefined> {
    if (!this.classInfoCache.has(classKey)) this.classInfoCache.set(classKey, classInfo(this.model, classKey));
    return this.classInfoCache.get(classKey);
  }

  async getParameterNames(method: MethodRef): Promise<string[]> {
    const c = this.model.callableByKey(method.key);
    return (c?.node.arguments ?? []).map((p: { name?: unknown }) => nameOf(p as never));
  }

  /** FR-7.7 */
  async getLibraryBase(classKey: string): Promise<ClassRef | null | undefined> {
    const fqn = classKey.replace(/^lib:\\?/, '');
    // PHP's own classes (`stdClass`, `Exception`): no model base
    if (!fqn.includes('\\')) return null;
    const c = this.project.libraryClass(fqn);
    if (!c) return undefined;
    return c.extends[0] ? this.model.refOfFqn(c.extends[0]) : null;
  }

  async getModuleFacts(classKey: string): Promise<ModuleFacts | undefined> {
    return moduleFacts(this.model, classKey);
  }

  /** FR-16.1 / FR-18.7: routes, Artisan commands, queued jobs, event listeners, PHPUnit tests. */
  async getEntryPoints(): Promise<EntryPoint[]> {
    return phpEntryPoints(this.model, this.isTest);
  }

  /** FR-1.15 */
  /** FR-8.6 Laravel container bindings (read once; a changed provider re-reads them). */
  private bindings: ContainerBinding[] | undefined;
  async getBindings(): Promise<ContainerBinding[]> {
    this.bindings ??= containerBindings(this.model);
    return this.bindings;
  }

  async getEarlyExits(method: MethodRef): Promise<EarlyExit[]> {
    return this.cached('exits', method, () => {
      const c = this.model.callableByKey(method.key);
      return c ? earlyExits(c.node.body ?? undefined, c.file) : [];
    });
  }

  /** FR-5.8 */
  async getReturns(method: MethodRef): Promise<ReturnFact[]> {
    return this.cached('returns', method, () => {
      const c = this.model.callableByKey(method.key);
      return c ? returnFacts(c.node, c.file) : [];
    });
  }

  /** FR-12.12 */
  async getTypeUses(method: MethodRef): Promise<TypeUse[]> {
    return this.cached('uses', method, () => {
      const c = this.model.callableByKey(method.key);
      return c ? phpTypeUses(this.model, c) : [];
    });
  }

  async updateFile(file: string, content?: string): Promise<void> {
    this.project.update(file, content);
    this.classInfoCache.clear();
    this.callsByName.clear();
    this.memo.clear();
    this.bindings = undefined;
  }

  async dispose(): Promise<void> {
    this.classInfoCache.clear();
    this.memo.clear();
  }
}

export function createPhpAdapter(projectRoot: string): LanguageAdapter {
  return new PhpAdapter(projectRoot);
}
