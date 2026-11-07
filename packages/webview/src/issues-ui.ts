/**
 * FR-19.17 the flow's issues, presented alike in both diagrams: the same toolbar button (⚠ N) and the same menu. Only what "show it" does differs per view.
 */
import type { Finding, IgnoredPatterns, IssuesBelow } from '@seqcall/protocol';
import { html } from './dom';
import { FINDING_ICON } from './finding-guide';
import type { MenuItem } from './menu';
import { cutFrom } from './text';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A toolbar button with an icon, a count badge and a caret (hidden while the count is 0). */
function countButton(cmd: string, icon: string): HTMLButtonElement {
  return html('button', { type: 'button', class: 'tb-btn keep-label tb-count', 'data-cmd': cmd, 'aria-haspopup': 'menu', hidden: '' }, [
    html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, [icon]),
    html('span', { class: 'tb-badge' }),
    html('span', { class: 'tb-more' }),
    html('span', { class: 'tb-caret', 'aria-hidden': 'true' }, ['▾']),
  ]) as HTMLButtonElement;
}

export const issuesButton = (): HTMLButtonElement => countButton('findings', '⚠');

function setCount(b: HTMLButtonElement, n: number, title: string, keepAtZero = false): void {
  b.hidden = n === 0 && !keepAtZero;
  b.classList.toggle('tb-zero', n === 0);
  b.querySelector('.tb-badge')!.textContent = n ? String(n) : '';
  b.title = title;
  b.setAttribute('aria-label', title);
}

export const NO_ISSUES = 'No design issues or layer violations in the shown calls';

/**
 * ⚠ N: design findings and layer violations of the flow. Shown for every flow, muted at 0 (a hidden ⚠ is not
 * found, though the Design issues list points to it); `flow` false (no diagram, the codebase map) hides it.
 */
export function updateIssuesButton(b: HTMLButtonElement, findings: Finding[] | undefined, flow = true, typeUseViolations = 0, below?: IssuesBelow, scope = 'the shown calls'): void {
  const all = findings ?? [];
  const violations = all.filter((f) => f.kind === 'layer-violation').length;
  const design = all.length - violations;
  const parts = [design ? plural(design, 'design issue') : '', violations ? violationsText(all) : ''].filter(Boolean);
  const none = `No design issues or layer violations in ${scope}`;
  // only folded ones: the +n comes first (a tooltip starting "No design issues" beside +1 reads as a contradiction)
  const onlyBelow = !parts.length && below;
  const title = parts.length
    ? `${parts.join(', ')} in ${scope} — click for the list`
    : onlyBelow
      ? `${below.count} inside folded calls, none in ${scope} — Expand all shows ${below.count === 1 ? 'it' : 'them'}`
      : `${none} — expand calls to look deeper`;
  const lines = [title, below && !onlyBelow ? belowNote(below.count) : '', typeUseViolations ? typeUsesNote(typeUseViolations) : ''].filter(Boolean);
  setCount(b, all.length, lines.join('\n'), flow);
  // what the folded calls hide, beside the count (not muted: there is something to see)
  b.querySelector('.tb-more')!.textContent = below ? `+${below.count}` : '';
  if (below) b.classList.remove('tb-zero');
}

const belowNote = (n: number) => `+ ${n} more inside folded calls — Expand all shows ${n === 1 ? 'it' : 'them'}`;

/** Uses on draws more red relations; they are no issues (the same count with Uses on or off). */
const typeUsesNote = (n: number) => `+ ${n} only through type uses (dotted red, not counted)`;

/** FR-19.22 Stop ignoring: what .seqcall.json silences and how to bring one back. */
export type IgnoredMenu = { patterns: IgnoredPatterns | undefined; stop(section: 'findings' | 'layerHints', pattern: string): void };

/** The issues menu: design findings, then the layer violations under their heading, then what is ignored. */
export function issuesMenu(findings: Finding[] | undefined, pick: (f: Finding) => void, typeUseViolations = 0, below?: { issues: IssuesBelow; expand?: () => void }, ignored?: IgnoredMenu): MenuItem[] {
  const items = below && !findings?.length ? [] : issueItems(findings, pick);
  const more: MenuItem[] = [];
  // the issues inside folded calls: named, one click opens them (the sequence diagram's Expand all)
  if (below) more.push({ id: 'issues-below', label: belowNote(below.issues.count), title: below.issues.titles.join('\n'), disabled: !below.expand, ...(below.expand ? { action: below.expand } : {}) });
  if (typeUseViolations) more.push({ id: 'type-use-violations', label: typeUsesNote(typeUseViolations), disabled: true });
  more.push(...ignoredItems(ignored));
  return more.length ? [...items, ...(items.length ? [{ separator: true, label: '' }] : []), ...more] : items;
}

/** Ignore writes to the team's config; one row per pattern undoes it in the view. */
function ignoredItems(ignored: IgnoredMenu | undefined): MenuItem[] {
  const findings = ignored?.patterns?.findings ?? [];
  const hints = ignored?.patterns?.layerHints ?? [];
  if (!findings.length && !hints.length) return [];
  const row = (section: 'findings' | 'layerHints', pattern: string): MenuItem => ({
    id: `unignore:${section}:${pattern}`,
    label: `↺ ${pattern}`,
    hint: section === 'findings' ? 'finding' : '⚑ layer hint',
    title: `Stop ignoring ${pattern}: remove it from ${section}.ignore in .seqcall.json`,
    action: () => ignored!.stop(section, pattern),
  });
  const head: MenuItem = { id: 'ignored-head', label: `${findings.length + hints.length} ignored in .seqcall.json — click to stop ignoring`, disabled: true };
  return [head, ...findings.map((p) => row('findings', p)), ...hints.map((p) => row('layerHints', p))];
}

function issueItems(findings: Finding[] | undefined, pick: (f: Finding) => void): MenuItem[] {
  const all = findings ?? [];
  if (!all.length) return [{ id: 'no-issues', label: NO_ISSUES, hint: 'expand calls to look deeper', disabled: true }];
  const item = (f: Finding): MenuItem => ({ id: `finding:${f.id}`, label: `${FINDING_ICON[f.kind]} ${f.title}`, title: f.detail, action: () => pick(f) });
  const design = all.filter((f) => f.kind !== 'layer-violation').map(item);
  // FR-7.16 the certain ones first; a possible one says so (it rests on a guessed layer)
  const broken = all.filter((f) => f.kind === 'layer-violation').sort((a, b) => Number(!!a.possible) - Number(!!b.possible));
  const violations = broken.map((f) => {
    const rule = f.detail === undefined ? undefined : cutFrom(f.detail, ':');
    return { ...item(f), label: f.title.replace(/^Layer violation: /, ''), hint: f.possible ? `possible${rule ? ` · ${rule}` : ''}` : rule, ...(f.possible ? { title: [f.detail, ...f.possible].filter(Boolean).join('\n') } : {}) };
  });
  if (!violations.length) return design;
  const head: MenuItem = { id: 'violations-head', label: `⚠ ${violationsText(broken)}`, disabled: true };
  return [...design, ...(design.length ? [{ separator: true, label: '' }] : []), head, ...violations];
}

/** FR-7.16 `3 layer violations (2 possible)`: of a list's layer violations, those resting on a guessed layer. */
export function violationsText(findings: readonly Finding[]): string {
  const broken = findings.filter((f) => f.kind === 'layer-violation');
  const possible = broken.filter((f) => f.possible).length;
  return `${plural(broken.length, 'layer violation')}${possible ? ` (${possible === broken.length && possible > 1 ? 'all' : possible} possible)` : ''}`;
}
