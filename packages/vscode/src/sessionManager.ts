import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  DiagramSession,
  DEFAULT_OPTIONS,
  createClassifier,
  createAdapter,
  type CSharpAdapterOptions,
  type Classifier,
  type LanguageAdapter,
} from '@seqcall/core';
import type { DiagramOptions } from '@seqcall/protocol';
import { readConfig } from './config';
import { isInside, languageOf, locateProject, pathKey, fromProtocolPath, type ProjectLanguage, type ProjectLocation } from './paths';
import type { StateStore } from './state';

/** One analysed project: adapter + classifier + exploration session. */
export interface ProjectEntry {
  readonly root: string;
  readonly language: ProjectLanguage;
  readonly adapter: LanguageAdapter;
  readonly classifier: Classifier;
  readonly session: DiagramSession;
}

export interface SessionManagerOptions {
  /** Directory of the installed extension (the bundled C# sidecar lives in dist/csharp). */
  extensionPath?: string;
  /** Diagnostics (e.g. the C# sidecar's stderr). */
  log?: (message: string) => void;
}

const entryKey = (loc: ProjectLocation): string => `${loc.language}:${pathKey(loc.root)}`;

/**
 * Lazily creates one DiagramSession per project (root + language). All analysis logic lives in
 * core; this class only picks the adapter and wires configuration and workspace-state persistence.
 */
export class SessionManager implements vscode.Disposable {
  private readonly entries = new Map<string, ProjectEntry>();

  constructor(
    private readonly store: StateStore,
    private readonly opts: SessionManagerOptions = {},
  ) {}

  /** Project root and language for a file; `language` overrides the extension-based choice. */
  locate(file: string, language?: ProjectLanguage): ProjectLocation {
    return locateProject(file, language);
  }

  get(loc: ProjectLocation): ProjectEntry | undefined {
    return this.entries.get(entryKey(loc));
  }

  all(): ProjectEntry[] {
    return [...this.entries.values()];
  }

  /** Existing entries whose project contains the file (and analyses its language). */
  owning(file: string): ProjectEntry[] {
    const language = languageOf(file);
    return this.all().filter((e) => e.language === language && isInside(file, e.root));
  }

  /**
   * Returns the entry for the project containing `file`, creating it when needed. `firstUse`
   * runs inside a progress notification for a new project, so the expensive first analysis
   * (building the TypeScript program / loading the C# workspace in the sidecar) is covered too.
   */
  async ensure<T>(file: string, firstUse: (entry: ProjectEntry) => Promise<T> | T, language?: ProjectLanguage, quiet = false): Promise<T> {
    const loc = this.locate(file, language);
    const existing = this.get(loc);
    if (existing) return firstUse(existing);
    // FR-16.10 the background load at startup: the status bar says it, not a notification
    if (quiet) return firstUse(this.create(loc));
    const name = loc.root.split('/').pop() || loc.root;
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: loc.language === 'csharp' ? `Seqcall: loading C# workspace ${name}…` : `Seqcall: analysing ${name}…`,
      },
      async () => {
        // Let the notification paint before the synchronous program build.
        await new Promise((r) => setTimeout(r, 10));
        const entry = this.get(loc) ?? this.create(loc);
        return firstUse(entry);
      },
    );
  }

  private create(loc: ProjectLocation): ProjectEntry {
    const { root, language } = loc;
    const config = readConfig(fromProtocolPath(root));
    const persisted = this.store.getSessionState(root);
    const options: DiagramOptions = {
      ...DEFAULT_OPTIONS,
      ...config.options,
      ...(persisted?.options ?? {}),
      followCursor: this.store.getFollowCursor(),
    };
    const adapter = createAdapter(language, root, { csharp: this.csharpOptions() });
    const classifier = createClassifier(root);
    const session = new DiagramSession({
      adapter,
      classifier,
      initialState: { filters: persisted?.filters ?? [], options },
      defaultDepth: config.defaultDepth,
      autoSelectSingleImplementation: config.autoSelectSingleImplementation,
      createBaseAdapter: () => createAdapter(language, root, { csharp: this.csharpOptions() }),
    });
    const entry: ProjectEntry = { root, language, adapter, classifier, session };
    this.entries.set(entryKey(loc), entry);
    return entry;
  }

  private csharpOptions(): CSharpAdapterOptions {
    // Packaged extension: dist/csharp/Seqcall.CSharp.dll; otherwise core's resolution (env, dev build).
    const bundled = this.opts.extensionPath && path.join(this.opts.extensionPath, 'dist', 'csharp', 'Seqcall.CSharp.dll');
    const sidecarPath = bundled && fs.existsSync(bundled) && !process.env.SEQCALL_CSHARP_SIDECAR ? bundled : undefined;
    const log = this.opts.log;
    return { sidecarPath, log: log && ((line) => log(`[C#] ${line}`)) };
  }

  /** FR-11.2: persist filters + options after every mutation. */
  persist(entry: ProjectEntry): void {
    void this.store.setSessionState(entry.root, entry.session.getPersistentState());
  }

  dispose(): void {
    for (const e of this.entries.values()) {
      e.adapter.dispose().catch(() => undefined);
      e.session.dispose().catch(() => undefined);
    }
    this.entries.clear();
  }
}
