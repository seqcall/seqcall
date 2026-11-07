/**
 * FR-25.2 sharing a diagram's state: the paste card that opens one, the card shown when the clipboard refused the
 * text, and the notice saying how far an opened state matches what the sender had (details in a card).
 */
import type { BorrowedConfig, DiagramStateReport } from '@seqcall/protocol';
import { html, svg } from '../dom';
import { download } from '../export-image';
import type { MenuItem } from '../menu';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The Share button's title (both views). */
export const SHARE_TITLE = 'Share: the diagram as an image (PNG / SVG), or as text that opens the same diagram for someone else';

/**
 * FR-25.2 the Share menu's second part (both views): copy the diagram as text to reopen elsewhere, open one.
 * `copy` undefined: nothing to copy here (`why` says so).
 */
export function stateMenuItems(copy: ((save: boolean) => void) | undefined, open: () => void, why?: string): MenuItem[] {
  const what = 'JSON that opens this same diagram for someone else: what is expanded, the implementations chosen, hidden calls, options, your commit';
  return [
    { label: '', separator: true },
    { id: 'state:copy', label: 'Copy to reopen elsewhere', hint: 'paste into an issue or chat', title: why ?? what, ...(copy ? { action: () => copy(false) } : { disabled: true }) },
    { id: 'state:save', label: 'Save to reopen elsewhere…', hint: 'a .seqcall.json to attach', title: why ?? what, ...(copy ? { action: () => copy(true) } : { disabled: true }) },
    { id: 'state:open', label: 'Open a shared diagram…', title: 'Paste the JSON someone copied or saved with Share (or the file\'s content)', action: open },
  ];
}

/**
 * FR-25.2 the host's answer to Copy / Save: done by the host (VS Code), else copied here (a card when the
 * clipboard is refused) or downloaded as a file.
 */
export async function onDiagramState(
  msg: { text?: string; error?: string; save?: boolean; name?: string; done?: boolean },
  ui: { flash(text: string): void; card(el: HTMLElement): void },
): Promise<void> {
  if (msg.error || (!msg.text && !msg.done)) return ui.flash(msg.error ?? 'Nothing to share');
  if (msg.done) return ui.flash(msg.save ? 'Saved ✓' : 'Copied ✓ — paste it into an issue or chat');
  if (msg.save) {
    download(msg.name ?? 'diagram.seqcall.json', msg.text!, 'application/json');
    return ui.flash('Saved ✓');
  }
  if (await copyText(msg.text!)) return ui.flash('Copied ✓ — paste it into an issue or chat');
  ui.card(copyStateCard(msg.text!));
}

/** FR-25 the Share button's icon: a box with an arrow going up out of it (the usual desktop share symbol). */
export function shareIcon(): SVGSVGElement {
  const line = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  return svg('svg', { class: 'share-icon', viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true', focusable: 'false' }, [
    svg('path', { ...line, d: 'M5.5 6.5H4a1 1 0 0 0-1 1V14a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1h-1.5' }),
    svg('path', { ...line, d: 'M8 10V1.5M5.2 4.2 8 1.5l2.8 2.7' }),
  ]);
}

/** FR-25.3 messages that write the project's .seqcall.json: not sent while another config is in use. */
export const CONFIG_WRITES: ReadonlySet<string> = new Set(['setLayer', 'ignoreFinding', 'ignoreLayerHint', 'unignoreFinding', 'unignoreLayerHint', 'openDependencyRule']);

/** FR-25.3 the bar shown while a shared diagram's layer config is in use (both views). */
export function borrowedConfigBar(cfg: BorrowedConfig, back: () => void): HTMLElement {
  const b = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'config-back' }, ['Back to my config']);
  b.addEventListener('click', back);
  return html('div', { class: 'expand-notice borrowed-config', role: 'status' }, [
    html('span', { class: 'notice-text' }, [
      '⚠ Using the shared diagram\'s layer config (',
      html('span', { class: 'code' }, [cfg.source]),
      '), not your .seqcall.json — layers, stereotypes and findings follow it; your file is not changed.',
    ]),
    b,
  ]);
}

/** FR-25.3 a config-writing action while the shared config is in use: why it is not done. */
export function writeBlockedCard(back: () => void): HTMLElement {
  const b = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'config-back' }, ['Back to my config']);
  b.addEventListener('click', back);
  return html('div', { class: 'callers-panel layer-reason-card state-card', role: 'alert' }, [
    html('div', { class: 'callers-title' }, ['Not while the shared layer config is in use']),
    html('div', { class: 'lr-note' }, ['This would change your .seqcall.json, but the diagram shows the shared diagram\'s config. Go back to your config first.']),
    html('div', { class: 'lr-actions' }, [b]),
  ]);
}

/** A card with a text area: paste a state, Open sends it. */
export function pasteStateCard(open: (text: string) => void, cancel: () => void): HTMLElement {
  const area = html('textarea', { class: 'state-text', rows: 8, spellcheck: 'false', placeholder: 'Paste the JSON someone copied with Share → Copy to reopen elsewhere (or the content of their .seqcall.json)', 'aria-label': 'Shared diagram' }) as HTMLTextAreaElement;
  const ok = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'state-open' }, ['Open']);
  const no = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'state-cancel' }, ['Cancel']);
  ok.addEventListener('click', () => {
    if (area.value.trim()) open(area.value);
  });
  no.addEventListener('click', cancel);
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      ok.click();
    }
  });
  const card = html('div', { class: 'callers-panel layer-reason-card state-card', role: 'dialog', 'aria-label': 'Open a shared diagram' }, [
    html('div', { class: 'callers-title' }, ['Open a shared diagram']),
    area,
    html('div', { class: 'lr-actions' }, [ok, no]),
    html('div', { class: 'lr-note' }, ['Opens the same diagram in this project. Works best on the same commit; what differs is reported.']),
  ]);
  setTimeout(() => area.focus(), 0);
  return card;
}

/** The clipboard refused: the text selected in a card, to copy by hand. */
export function copyStateCard(text: string): HTMLElement {
  const area = html('textarea', { class: 'state-text', rows: 8, readonly: true, spellcheck: 'false', 'aria-label': 'Diagram as text' }) as HTMLTextAreaElement;
  area.value = text;
  setTimeout(() => area.select(), 0);
  return html('div', { class: 'callers-panel layer-reason-card state-card', role: 'dialog', 'aria-label': 'Diagram as text' }, [
    html('div', { class: 'callers-title' }, ['Copy this text (Ctrl+C)']),
    area,
    html('div', { class: 'lr-note' }, ['The clipboard is not available here. Paste it into the issue or message.']),
  ]);
}

/** One line for the notice bar. */
export function stateSummary(report: DiagramStateReport): string {
  const parts: string[] = [];
  if (report.differences.length) parts.push(plural(report.differences.length, 'difference'));
  if (report.missing.length) parts.push(`${plural(report.missing.length, 'step')} not found`);
  return `ⓘ Shared diagram ${report.source} — ${parts.length ? parts.join(', ') : 'same as the sender ✓'}`;
}

/** What differs and what was not found, one row each. */
export function stateDetailsCard(report: DiagramStateReport): HTMLElement {
  const rows = (items: string[], mark: string) => items.map((t) => html('div', { class: 'lr-row' }, [html('span', { class: 'lr-mark' }, [mark]), html('span', { class: 'lr-path' }, [t])]));
  return html('div', { class: 'callers-panel layer-reason-card state-card', role: 'dialog', 'aria-label': 'Shared diagram' }, [
    html('div', { class: 'callers-title' }, ['Shared diagram ', html('span', { class: 'code' }, [report.source])]),
    ...(report.differences.length ? [html('div', { class: 'lr-head' }, ['Differs from the sender']), ...rows(report.differences, '≠')] : []),
    ...(report.missing.length ? [html('div', { class: 'lr-head' }, ['Not found in this code']), ...rows(report.missing, '?')] : []),
    ...(!report.differences.length && !report.missing.length ? [html('div', { class: 'lr-note' }, ['Same code, same steps, same number of messages and objects as the sender.'])] : []),
    html('div', { class: 'lr-note' }, [
      // different counts are one of the differences above
      report.seen.messages === report.now.messages && report.seen.participants === report.now.participants ? `${plural(report.now.messages, 'message')}, ${plural(report.now.participants, 'object')}, as the sender saw.` : '',
      report.settingsReplaced ? ' Your hidden calls and view options were replaced by the sender\'s.' : '',
    ]),
  ]);
}

import { copyText } from '../clipboard';
export { copyText };
