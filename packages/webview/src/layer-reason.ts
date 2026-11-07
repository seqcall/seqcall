/**
 * FR-7.8 "Why this layer?": the classifier rule that placed a class in its layer (a box's tooltip line,
 * and a card from its menu with the rules that did not apply, what the code suggests, the
 * dependency-rule violations it takes part in, and how to change it). Shared by both views.
 */
import type { LayerHint, LayerReason, StereotypeReason } from '@seqcall/protocol';
import { copyText } from './clipboard';
import { FLASH_MS, html } from './dom';
import { isMovable } from './layer-hint';
import { layerClass } from './layers';

const STRENGTH: Record<LayerReason['strength'], string> = {
  strong: 'a clear signal',
  weak: 'a weak signal: only a name or a folder name decided',
};

/** One tooltip line: "Application — role folder `Services/` (weak signal)". */
export function layerReasonLine(layer: string | undefined, reason: LayerReason | undefined): string | undefined {
  if (!reason) return undefined;
  const text = reason.text.replace(/`/g, '');
  if (!layer) return `No layer — ${reason.notApplied.length ? 'no rule applies' : text}`;
  return `${layer} — ${text}${reason.strength === 'weak' ? ' (weak signal)' : ''}`;
}

/** FR-7.9 one reason per stereotype, plain text: "«service» — name ends in Service". */
export function stereotypeReasonText(r: StereotypeReason): string {
  return `«${r.stereotype}» — ${r.text.replace(/`/g, '')}`;
}

/** Tooltip of a box's «…» line: each stereotype with its reason. */
export function stereotypeReasonsTitle(reasons: StereotypeReason[] | undefined): string | undefined {
  return reasons?.length ? reasons.map(stereotypeReasonText).join('\n') : undefined;
}

/** The menu entry: what the card explains. */
export function whyLabel(t: { layerReason?: LayerReason; stereotypeReasons?: StereotypeReason[] }): string | undefined {
  if (!t.layerReason && !t.stereotypeReasons?.length) return undefined;
  return t.stereotypeReasons?.length ? (t.layerReason ? 'Why this layer and these stereotypes?' : 'Why these stereotypes?') : 'Why this layer?';
}

export interface LayerReasonTarget {
  classKey: string;
  className: string;
  layer?: string;
  layerReason?: LayerReason;
  stereotypeReasons?: StereotypeReason[];
  layerHint?: LayerHint;
  /** The dependency-rule violations it takes part in, in the open diagram. */
  violations?: string[];
}

export interface LayerReasonActions {
  /** Opens the "Move to layer" menu at the given point (writes a rule to .seqcall.json). */
  moveTo?: (x: number, y: number) => void;
  /** Applies the ⚑ suggestion. */
  applyHint?: (layer: string) => void;
  /** FR-7.11 silences the ⚑ hint for the class's file (`layerHints.ignore`, a file glob). */
  ignoreHint?: (pattern: string) => void;
}

/** Inline code spans for `…` in a reason text. */
function withCode(text: string): (string | HTMLElement)[] {
  return text.split(/`([^`]*)`/).map((part, i) => (i % 2 ? html('span', { class: 'code' }, [part]) : part));
}

/**
 * The file path, with the folders that decided highlighted (the innermost occurrence: the classifier reads
 * the path from the inside out; a dotted folder such as `Shop.Infrastructure/` counts by its parts) and the
 * file name highlighted when it decided (an entry file).
 */
export function pathWithDecision(r: LayerReason): HTMLElement | undefined {
  if (!r.path) return undefined;
  const parts = r.path.split('/');
  const hit = new Set<number>();
  for (const f of r.folders ?? []) {
    for (let i = parts.length - 2; i >= 0; i--) {
      if (parts[i] === f || parts[i].split('.').includes(f)) {
        hit.add(i);
        break;
      }
    }
  }
  if (r.rule === 'entry-file') hit.add(parts.length - 1);
  const out = html('span', { class: 'lr-path code' });
  parts.forEach((p, i) => {
    out.appendChild(hit.has(i) ? html('mark', { class: 'lr-hit' }, [p]) : document.createTextNode(p));
    // wrap after a slash, not inside a name
    if (i < parts.length - 1) out.append('/', html('wbr'));
  });
  return out;
}

/** FR-7.11 what to do about a hint whose fix is a code change (FSD: the backend call belongs in an api/ segment). */
const FIX_IN_CODE = 'The fix is in the code: put the backend call in an `api/` segment.';

/** FR-19.13 the card as Markdown (for a colleague or an AI agent): verdict, file, rules checked, hint, stereotypes, violations. */
export function layerReasonMarkdown(t: LayerReasonTarget): string {
  const r = t.layerReason;
  const hint = t.layerHint;
  const out = [t.layer ? `### Why \`${t.className}\` is in ${t.layer}` : `### Why \`${t.className}\` has no layer`, ''];
  if (r?.path) out.push(`**File:** \`${r.path}\``, '');
  if (r) {
    out.push('**Placed by:**');
    for (const n of r.notApplied) out.push(`- ${r.noted?.includes(n) ? '·' : '✗'} ${n}`);
    if (r.rule !== 'none') out.push(`- ✓ ${r.text} — ${STRENGTH[r.strength]}`);
    out.push('');
  }
  out.push(`**What the code suggests:** ${hint ? `${hint.suggested}: ${hint.reasons.join('; ')}${hint.advice ? ` — ${hint.advice}` : ''}` : t.layer ? 'nothing against this layer in the analysed code' : 'no suggestion from the analysed code'}`, '');
  if (hint?.noMove) out.push(`**Fix:** ${FIX_IN_CODE}`, '');
  if (t.stereotypeReasons?.length) out.push('**Stereotypes:**', ...t.stereotypeReasons.map((s) => `- «${s.stereotype}» ${s.text}${s.weak ? ' — weak signal' : ''}`), '');
  if (t.violations?.length) out.push('**Dependency rule in this diagram:**', ...t.violations.map((v) => `- ⚠ ${v}`), '');
  return out.join('\n');
}

/** The card: verdict, rules checked, code evidence, violations, actions. */
export function layerReasonCard(t: LayerReasonTarget, actions: LayerReasonActions): HTMLElement {
  const r = t.layerReason;
  const lc = layerClass(t.layer); // '' without a layer
  const card = html('div', { class: `callers-panel layer-reason-card${lc ? ` ${lc}` : ''}`, role: 'dialog', 'aria-label': `Why ${t.className} is in its layer` });
  card.appendChild(
    html('div', { class: 'callers-title' }, t.layer
      ? ['Why ', html('span', { class: 'code' }, [t.className]), ' is in ', html('span', { class: `lr-layer ${lc}` }, [t.layer])]
      : ['Why ', html('span', { class: 'code' }, [t.className]), ' has no layer']),
  );
  const section = (title: string, rows: HTMLElement[]) => {
    if (!rows.length) return;
    card.appendChild(html('div', { class: 'lr-section' }, [html('div', { class: 'lr-head' }, [title]), ...rows]));
  };
  const row = (mark: string, cls: string, content: (string | HTMLElement)[]) => html('div', { class: `lr-row ${cls}` }, [html('span', { class: 'lr-mark' }, [mark]), html('span', {}, content)]);
  const where = r && pathWithDecision(r);
  if (where) card.appendChild(html('div', { class: 'lr-section lr-file' }, [html('div', { class: 'lr-head' }, ['File']), where]));
  if (r) {
    // the rules in the order they are checked: the ones that did not apply, then the one that decided
    section('Placed by', [
      // FR-7.11 a rule that recognised the file and gave no layer on purpose is a note (·), not a miss (✗)
      ...r.notApplied.map((n) => (r.noted?.includes(n) ? row('·', 'lr-noted', withCode(n)) : row('✗', 'lr-skipped', withCode(n)))),
      ...(r.rule === 'none' ? [] : [row('✓', `lr-decided ${r.strength}`, [...withCode(r.text), html('span', { class: 'lr-strength' }, [` — ${STRENGTH[r.strength]}`])])]),
    ]);
  }
  const hint = t.layerHint;
  section('What the code suggests', hint
    ? [
        row('⚑', 'lr-hint', [`${hint.suggested}: `, hint.reasons.join('; '), ...(hint.advice ? [' — ', ...withCode(hint.advice)] : [])]),
        // FR-7.11 the fix is a code change, not a move: said right under the hint
        ...(hint.noMove ? [row('→', 'lr-fix', withCode(FIX_IN_CODE))] : []),
      ]
    : [row('·', 'lr-none', [t.layer ? 'nothing against this layer in the analysed code' : 'no suggestion from the analysed code'])]);
  // FR-7.9 each stereotype and where it comes from
  section('Stereotypes', (t.stereotypeReasons ?? []).map((s) =>
    row('«»', `lr-stereo${s.weak ? ' weak' : ''}`, [
      html('span', { class: 'lr-stereo-name' }, [`«${s.stereotype}»`]),
      ' ',
      ...withCode(s.text),
      ...(s.weak ? [html('span', { class: 'lr-strength' }, [' — weak signal'])] : []),
    ]),
  ));
  section('Dependency rule in this diagram', (t.violations ?? []).map((v) => row('⚠', 'lr-violation', [v])));
  // how to change it: a rule in .seqcall.json (Move to layer writes one, with Undo)
  const buttons: HTMLElement[] = [];
  // FR-19.13 the card as text, not a screenshot
  const copy = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'lr-copy', title: 'Copy this card as Markdown, to paste into a chat, an issue or an AI agent' }, ['Copy as Markdown']);
  copy.addEventListener('click', () => void copyText(layerReasonMarkdown(t)).then((ok) => {
    copy.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => (copy.textContent = 'Copy as Markdown'), FLASH_MS);
  }));
  buttons.push(copy);
  if (hint && !hint.noMove && actions.applyHint && isMovable(t)) {
    const b = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'lr-apply' }, [`Move to ${hint.suggested}`]);
    b.addEventListener('click', () => actions.applyHint!(hint.suggested));
    buttons.push(b);
  }
  const file = t.classKey.includes('#') && !t.classKey.startsWith('lib:') ? t.classKey.slice(0, t.classKey.indexOf('#')) : undefined;
  if (hint && file && actions.ignoreHint) {
    const b = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'lr-ignore-hint', title: `Add ${file} to layerHints.ignore in .seqcall.json` }, ['Ignore this hint']);
    b.addEventListener('click', () => actions.ignoreHint!(file));
    buttons.push(b);
  }
  if (actions.moveTo && isMovable(t)) {
    const b = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'lr-move' }, ['Move to layer…']);
    b.addEventListener('click', () => {
      const rect = b.getBoundingClientRect();
      actions.moveTo!(rect.left, rect.bottom + 2);
    });
    buttons.push(b);
  }
  card.appendChild(html('div', { class: 'lr-actions' }, buttons)); // never empty: Copy as Markdown is always there
  // a hint whose fix is in the code (FSD: the call belongs in api/): moving only relabels the file
  const note = r?.rule === 'config'
    ? 'Your rule decides: edit it in .seqcall.json.'
    : hint?.noMove
      ? 'Move to layer… only relabels the file (a rule in .seqcall.json).'
      : 'Moving writes a rule to .seqcall.json.';
  card.appendChild(html('div', { class: 'lr-note' }, [note]));
  return card;
}
