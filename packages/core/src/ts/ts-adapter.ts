import ts from 'typescript';
import type { CallerInfo, EntryPoint, MethodRef, Position } from '@seqcall/protocol';
import type { CallSite, ClassInfo, EarlyExit, FileType, LanguageAdapter, ModuleFacts, ReturnFact, TypeUse } from '../adapter';
import { moduleCalls, outgoingCalls } from './calls';
import { countValueUses, findCallers, findImplementations } from './callers';
import { extractClassInfo } from './class-info';
import { earlyExits } from './exits';
import { returnFacts } from './returns';
import { entryPoints } from './entry-points';
import { moduleFacts } from './module-facts';
import { discoverProject, JSDOC_PARSING, ProjectHost } from './host';
import { type CallableNode, TsModel } from './model';
import { normalizePath } from './paths';
import { typeUses } from './type-uses';
import { TestFileMatcher } from '../test-files';

/**
 * LanguageAdapter for JavaScript/TypeScript on top of the TypeScript LanguageService.
 * Works synchronously in-process; the async methods only satisfy the adapter contract.
 */
export class TsAdapter implements LanguageAdapter {
  readonly projectRoot: string;
  private readonly host: ProjectHost;
  private readonly ls: ts.LanguageService;
  private model: TsModel | undefined;
  private readonly classInfoCache = new Map<string, ClassInfo | undefined>();
  /**
   * Per-method query results of the current program (dropped with it): the design-issue scan, the unreachable-code
   * search (FR-31) and the diagrams ask the same methods again (an implementation query is a reference search).
   */
  private readonly memo = new Map<string, unknown>();
  private readonly testFiles: TestFileMatcher;
  private readonly isTestFile = (relPath: string): boolean => this.testFiles.isTest(relPath);

  constructor(projectRoot: string) {
    this.projectRoot = normalizePath(projectRoot);
    this.host = new ProjectHost(this.projectRoot, discoverProject(this.projectRoot));
    this.ls = ts.createLanguageService(this.host, ts.createDocumentRegistry(undefined, undefined, JSDOC_PARSING));
    this.testFiles = new TestFileMatcher(this.projectRoot);
  }

  /** Current program-bound model (rebuilt incrementally after updates). */
  private get m(): TsModel {
    // undefined only for a syntactic-only language service (LanguageServiceMode.Syntactic), never created here
    const program = this.ls.getProgram()!;
    if (!this.model || this.model.program !== program) {
      this.model = new TsModel(program, this.projectRoot);
      this.classInfoCache.clear();
      this.memo.clear();
    }
    return this.model;
  }

  /** `compute` of the method's node, once per program; lists come back as copies (callers may sort them). */
  private cached<T>(query: string, method: MethodRef, none: T, compute: (model: TsModel, node: CallableNode) => T): T {
    const model = this.m;
    const slot = `${query}\0${method.key}`;
    let value = this.memo.get(slot) as T | undefined;
    if (value === undefined) {
      const node = model.findCallableByKey(method.key);
      value = node ? compute(model, node) : none;
      this.memo.set(slot, value);
    }
    return (Array.isArray(value) ? [...value] : value) as T;
  }

  /** Builds the program eagerly (optional; all queries build it lazily). */
  async warmUp(): Promise<void> {
    void this.m.checker;
  }

  /** FR-31.1 the file's classes / interfaces with their methods, and its module for top-level functions. */
  async getFileTypes(file: string): Promise<FileType[]> {
    const model = this.m;
    const sf = model.getSourceFile(file);
    if (!sf || model.isLibraryFile(sf)) return [];
    const out: FileType[] = [];
    const functions: MethodRef[] = [];
    for (const st of sf.statements) {
      if ((ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st)) && st.name) {
        const methods: MethodRef[] = [];
        for (const member of st.members) {
          if (!(ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isMethodSignature(member) || ts.isGetAccessorDeclaration(member))) continue;
          // overload signatures: the method once, by its implementation (as getMethod finds it)
          if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && !member.body && !model.isAbstract(member)) continue;
          // a member of a class / interface always has an owner, so a MethodRef; overloaded interface methods once
          const ref = model.methodRef(member as CallableNode)!;
          if (!methods.some((m) => m.key === ref.key)) methods.push(ref);
        }
        out.push({ type: model.classRef(st), methods });
      } else if (ts.isFunctionDeclaration(st) && st.name && st.body) {
        functions.push(model.methodRef(st)!); // module-level: the module owns it
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
            functions.push(model.methodRef(d)!); // module-level: the module owns it
          }
        }
      }
    }
    if (functions.length) out.push({ type: model.moduleRef(sf), methods: functions });
    return out;
  }

  /** FR-31.1 */
  async getProjectTypes(): Promise<FileType[]> {
    const out: FileType[] = [];
    for (const sf of this.m.program.getSourceFiles()) if (!this.m.isLibraryFile(sf) && !sf.isDeclarationFile) out.push(...(await this.getFileTypes(sf.fileName)));
    return out;
  }

  /** FR-31.1 module-level calls of the project's own files (not test files). */
  async getModuleCalls(): Promise<CallSite[]> {
    const model = this.m;
    return model.program.getSourceFiles().filter((sf) => !model.isLibraryFile(sf) && !sf.isDeclarationFile && !this.isTestFile(model.rel(sf.fileName))).flatMap((sf) => moduleCalls(model, sf));
  }

  async findEnclosingCallable(file: string, position: Position): Promise<MethodRef | undefined> {
    const model = this.m;
    const sf = model.getSourceFile(file);
    if (!sf || model.isLibraryFile(sf)) return undefined;
    let offset: number;
    try {
      offset = sf.getPositionOfLineAndCharacter(position.line, position.character);
    } catch {
      return undefined;
    }
    const node = model.enclosingCallable(sf, offset);
    return node && model.methodRef(node);
  }

  async getMethod(key: string): Promise<MethodRef | undefined> {
    const model = this.m;
    const node = model.findCallableByKey(key);
    return node && model.methodRef(node);
  }

  async getOutgoingCalls(method: MethodRef): Promise<CallSite[]> {
    return this.cached('outgoing', method, [], outgoingCalls);
  }

  /** FR-7.7 */
  async getModuleFacts(classKey: string): Promise<ModuleFacts> {
    return moduleFacts(this.m, classKey);
  }

  /** FR-16.1 */
  async getEntryPoints(): Promise<EntryPoint[]> {
    return entryPoints(this.m, this.isTestFile);
  }

  /** FR-1.15 */
  async getEarlyExits(method: MethodRef): Promise<EarlyExit[]> {
    return this.cached('exits', method, [], earlyExits);
  }

  /** FR-5.8 */
  async getReturns(method: MethodRef): Promise<ReturnFact[]> {
    return this.cached('returns', method, [], returnFacts);
  }

  async getImplementations(method: MethodRef): Promise<MethodRef[]> {
    return this.cached('impls', method, [], (model, node) => findImplementations(model, this.ls, node, method, this.isTestFile));
  }

  async getCallers(method: MethodRef): Promise<CallerInfo[]> {
    return this.cached('callers', method, [], (model, node) => findCallers(model, this.ls, node, method, this.isTestFile));
  }

  /** FR-31.1 */
  async getValueUses(method: MethodRef): Promise<number> {
    return this.cached('valueUses', method, 0, (model, node) => countValueUses(model, this.ls, node, this.isTestFile));
  }

  async getParameterNames(method: MethodRef): Promise<string[]> {
    const model = this.m;
    const node = model.findCallableByKey(method.key);
    const fn = node && model.functionOf(node);
    if (!fn) return [];
    return fn.parameters
      .filter((p) => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
      .map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
  }

  /** FR-12.12 */
  async getTypeUses(method: MethodRef): Promise<TypeUse[]> {
    const model = this.m;
    const node = model.findCallableByKey(method.key);
    return node ? typeUses(model, node) : [];
  }

  async getClassInfo(classKey: string): Promise<ClassInfo | undefined> {
    const model = this.m;
    if (!this.classInfoCache.has(classKey)) this.classInfoCache.set(classKey, extractClassInfo(model, classKey));
    return this.classInfoCache.get(classKey);
  }

  async updateFile(file: string, content?: string): Promise<void> {
    this.host.updateFile(file, content);
  }

  async dispose(): Promise<void> {
    this.ls.dispose();
    this.model = undefined;
  }
}

export function createTsAdapter(projectRoot: string): LanguageAdapter {
  return new TsAdapter(projectRoot);
}
