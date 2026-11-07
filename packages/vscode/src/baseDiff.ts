import * as vscode from 'vscode';
import type { DiffTarget } from '@seqcall/protocol';

const SCHEME = 'seqcall-base';

/**
 * FR-24.7 the side-by-side diff of a reviewed call: the file's merge-base content (served read-only from
 * memory under its own scheme) against the file on disk, at the call's line.
 */
export class BaseDiff implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly registration: vscode.Disposable;
  private seq = 0;

  constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.texts.get(uri.toString()) ?? '';
  }

  async show(target: DiffTarget, viewColumn?: vscode.ViewColumn, preserveFocus = false): Promise<void> {
    const file = vscode.Uri.file(target.file);
    const base = vscode.Uri.from({ scheme: SCHEME, path: file.path, query: `v${++this.seq}` });
    this.texts.set(base.toString(), target.baseText);
    const at = new vscode.Range(target.line, 0, target.line, 0);
    await vscode.commands.executeCommand('vscode.diff', base, file, target.title, { selection: at, ...(viewColumn ? { viewColumn } : {}), ...(preserveFocus ? { preserveFocus } : {}) });
  }

  dispose(): void {
    this.registration.dispose();
    this.texts.clear();
  }
}
