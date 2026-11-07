import * as vscode from 'vscode';
import { CODE_INFO_ITEM, codeInfoLines } from '@seqcall/core';
import type { CodeInfo, Position } from '@seqcall/protocol';
import { setting } from './config';
import { SUPPORTED_LANGUAGES, isSupportedDocument, toProtocolPath } from './paths';
import type { SessionManager } from './sessionManager';

/** The commands behind the hover's links (registered in extension.ts). */
export const OPEN_FROM_HOVER = 'seqcall.openFromHover';
/** FR-33.7 an entry point's flow down to the method, or the list of all of them. */
export const OPEN_REACH = 'seqcall.openReach';

/**
 * FR-33 Seqcall's lines in the editor's hover: on a call what runs there and its I/O, on a method's name who reaches
 * it — only for a project already loaded (a hover never starts the analysis), only for a saved file (the analysis reads
 * what is on disk), and nothing when there is nothing to say.
 */
export class SeqcallHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly sessions: SessionManager,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    if (!setting('hover', true)) return undefined;
    if (!isSupportedDocument(doc) || doc.isDirty) return undefined;
    const file = toProtocolPath(doc.uri);
    const entry = this.sessions.get(this.sessions.locate(file));
    if (!entry) return undefined;
    const wordRange = doc.getWordRangeAtPosition(pos);
    if (!wordRange) return undefined;
    const position: Position = { line: pos.line, character: pos.character };
    let info: CodeInfo | undefined;
    try {
      info = await entry.session.describeAt(file, position, { word: doc.getText(wordRange) });
    } catch (e) {
      this.log(`hover: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
    if (!info) return undefined;
    const lines = codeInfoLines(info, entry.root);
    if (!lines.length) return undefined;
    return new vscode.Hover(hoverMarkdown(lines, file, position, info.call ? undefined : doc.getText(wordRange)), wordRange);
  }
}

/**
 * The lines, then the links: the sequence diagram of the method at `position`, and on a method's name (`name`) its
 * paths to here; there each entry point opens its flow down to the method, `+n more` the list of all of them.
 */
export function hoverMarkdown(lines: string[], file: string, position: Position, name?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: [OPEN_FROM_HOVER, OPEN_REACH] };
  const link = (label: string, command: string, args: unknown[]) => `[${label}](command:${command}?${encodeURIComponent(JSON.stringify(args))})`;
  md.appendMarkdown('**Seqcall**  \n');
  // (appendText would turn every space into &nbsp;)
  const escape = (text: string) => text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
  let inList = false;
  let items = 0;
  for (const line of lines) {
    if (line.startsWith(CODE_INFO_ITEM)) {
      // an item of the line above: a list entry; an entry point's label in code font (routes read better that way)
      const item = line.slice(CODE_INFO_ITEM.length);
      const more = /^\+\d+ more$/.test(item);
      const text = more ? escape(item) : `\`${item.replace(/`/g, "'")}\``;
      // FR-33.7 on a method's name the items are its entry points (in the order of `reach.routes`)
      const linked = name === undefined ? text : link(text, OPEN_REACH, more ? [file, position, name] : [file, position, name, items]);
      if (!more) items++;
      md.appendMarkdown(`${inList ? '' : '\n'}- ${linked}\n`);
      inList = true;
      continue;
    }
    // a blank line ends the list (else the line would continue its last item)
    md.appendMarkdown(`${inList ? '\n' : ''}${escape(line)}  \n`);
    inList = false;
  }
  const links = [link('Sequence diagram', OPEN_FROM_HOVER, [file, position])];
  if (name !== undefined) links.push(link('Paths to here', OPEN_FROM_HOVER, [file, position, 'paths']));
  md.appendMarkdown(`\n${links.join(' · ')}`);
  return md;
}

/** The languages the provider answers for (files on disk only). */
export const HOVER_SELECTOR: vscode.DocumentSelector = SUPPORTED_LANGUAGES.map((language) => ({ language, scheme: 'file' }));
