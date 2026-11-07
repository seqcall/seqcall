import * as vscode from 'vscode';
import type { SourceRange } from '@seqcall/protocol';
import { fromProtocolPath } from './paths';

const HIGHLIGHT_MS = 2000;

/**
 * FR-2.1/2.2/2.3/12.5: reveal a source range in a text editor (never in the diagram's
 * column), select it and flash a temporary highlight. The focus stays on the diagram: the arrow
 * keys keep walking the diagram, not the code.
 */
export class Navigator implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
    borderRadius: '2px',
  });
  private lastTextColumn: vscode.ViewColumn | undefined;
  private highlighted: vscode.TextEditor | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscription: vscode.Disposable;
  private lastRevealed: { uri: string; selection: vscode.Selection } | undefined;

  constructor() {
    this.lastTextColumn = vscode.window.activeTextEditor?.viewColumn;
    this.subscription = vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e?.viewColumn) this.lastTextColumn = e.viewColumn;
    });
  }

  async reveal(range: SourceRange, avoidColumn?: vscode.ViewColumn): Promise<vscode.TextEditor> {
    this.clearHighlight();
    const doc = await vscode.workspace.openTextDocument(fromProtocolPath(range.file));
    const selection = new vscode.Range(
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
    );
    let column = this.lastTextColumn ?? vscode.ViewColumn.One;
    if (avoidColumn !== undefined && column === avoidColumn) {
      column = avoidColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One;
    }
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: true });
    editor.selection = new vscode.Selection(selection.start, selection.end);
    this.lastRevealed = { uri: doc.uri.toString(), selection: editor.selection };
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.setDecorations(this.decoration, [selection]);
    this.highlighted = editor;
    this.timer = setTimeout(() => this.clearHighlight(), HIGHLIGHT_MS);
    return editor;
  }

  /** True while the editor's selection is still the one set by the last reveal. */
  isLastRevealed(editor: vscode.TextEditor): boolean {
    const last = this.lastRevealed;
    return !!last && last.uri === editor.document.uri.toString() && last.selection.isEqual(editor.selection);
  }

  private clearHighlight(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.highlighted?.setDecorations(this.decoration, []);
    this.highlighted = undefined;
  }

  dispose(): void {
    this.clearHighlight();
    this.decoration.dispose();
    this.subscription.dispose();
  }
}
