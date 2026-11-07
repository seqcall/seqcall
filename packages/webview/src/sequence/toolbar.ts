/** Sequence view toolbar (FR-14.1). Emits command ids; the view maps them to intents. */
import { SHARE_TITLE, shareIcon } from './share-state';
import type { DiagramOptions, SequenceDiagram } from '@seqcall/protocol';
import { html } from '../dom';
import { observeCompact, setCompact } from '../compact';
import { issuesButton, updateIssuesButton } from '../issues-ui';

export type ToolbarCommand =
  | 'back'
  | 'entryPoints'
  | 'forward'
  | 'expandMenu'
  | 'smartExpand'
  | 'foldErrors'
  | 'layerZoom'
  | 'view'
  | 'findings'
  | 'hidden'
  | 'find'
  | 'image'
  | 'classDiagram';

interface ButtonSpec {
  cmd: ToolbarCommand;
  icon: string | (() => Element);
  label: string;
  title: string;
  /** Opens a menu (▾). */
  menu?: boolean;
  /** Keeps its label in a narrow panel (FR-14.3). */
  keepLabel?: boolean;
}

/** FR-28.11 ◫ Layers: the click folds every layer (off) or opens every layer (on). */
const FOLD_ALL_TITLE = 'Fold all layers: one lifeline per layer, only the calls that cross a layer; the calls inside a layer fold into them (+n). The class diagram shows one package per layer. ⊖ on a band folds one layer';
const OPEN_ALL_TITLE = 'Open all layers: every object on its own lifeline again (⊕ on a layer opens one)';

/** FR-3.12 ↯ Fold errors: a toggle like ◫; the pressed state says it is on. */
const FOLD_ERRORS_TITLE = 'Fold errors: error branches (catch, throw, early return) fold into one-line markers at every depth — ⊕ on a marker shows one. Pressed = on';

// in a narrow panel (FR-14.3) the names stay on Overview and View (Entry points too would take a second row)
const GROUPS: ButtonSpec[][] = [
  [
    { cmd: 'back', icon: '←', label: '', title: 'Back to the previous diagram (expanding and collapsing are not steps)' },
    { cmd: 'forward', icon: '→', label: '', title: 'Forward to the next diagram' },
    { cmd: 'entryPoints', icon: '⌂', label: 'Entry points', title: 'Entry points: where flows start — HTTP endpoints, pages, UI roots, main, jobs, handlers, tests; open one as a diagram' },
  ],
  [
    // FR-3.12 which calls are open: ✦ Overview (the important calls); its ▾ Expand all, Changes, one level, collapse all
    { cmd: 'smartExpand', icon: '✦', label: 'Overview', title: 'Overview: open the important calls on the success path (layer crossings, services, ports, I/O); minor calls dimmed. ▾ Expand all, Changes, levels', keepLabel: true },
    // Collapse all and Tidy up are not on the toolbar (this ▾, View ▾ and the canvas menu have them)
    { cmd: 'expandMenu', icon: '▾', label: '', title: 'Expand: Overview, Expand all, Changes (in a review); one more level, collapse all' },
    // FR-3.12 which paths are drawn, whatever is open: a toggle
    { cmd: 'foldErrors', icon: '↯', label: 'Fold errors', title: FOLD_ERRORS_TITLE },
    // FR-28 a mode, not a preference: on the toolbar (and in View ▾, so it is saved and shared with the diagram)
    { cmd: 'layerZoom', icon: '◫', label: 'Fold layers', title: FOLD_ALL_TITLE },
    // FR-28.9 only while zoomed: fold every opened layer at once, or back to the objects
  ],
  [
    { cmd: 'view', icon: '☷', label: 'View', title: 'View options: arguments, results, I/O badges, library calls, fragments; marks of both diagrams (design findings, review changes); follow cursor', menu: true, keepLabel: true },
    // FR-19.17 the same button as the class diagram's (issues-ui)
    { cmd: 'findings', icon: '⚠', label: '', title: 'Design findings and layer violations of this flow', menu: true, keepLabel: true },
  ],
  [
    { cmd: 'find', icon: '⌕', label: '', title: 'Find (Ctrl+F or /): calls and classes in the diagram and in the collapsed calls' },
    { cmd: 'hidden', icon: '⊘', label: 'Filters', title: "Filters: hidden calls, calls not expanded (Don't expand…)", menu: true },
    { cmd: 'image', icon: shareIcon, label: 'Share', title: SHARE_TITLE, menu: true },
    { cmd: 'classDiagram', icon: '▦', label: 'Class diagram', title: 'Open the class diagram of the visible classes' },
  ],
];

import { changedViewOptions, optionEnabled } from '../view-options';
export { changedViewOptions, optionEnabled, VIEW_OPTIONS, type ViewOption } from '../view-options';

/** Below this toolbar width buttons show icons only (labels move to the tooltips), FR-14.3. */
export const COMPACT_BELOW = 860;

export class Toolbar {
  readonly element: HTMLElement;
  private readonly buttons = new Map<ToolbarCommand, HTMLButtonElement>();

  constructor(onCommand: (cmd: ToolbarCommand, button: HTMLButtonElement) => void) {
    this.element = html('div', { class: 'toolbar', role: 'toolbar' });
    for (const group of GROUPS) {
      const g = html('div', { class: 'toolbar-group' });
      for (const spec of group) {
        const shared = spec.cmd === 'findings' ? issuesButton() : undefined;
        if (shared) {
          shared.addEventListener('click', () => onCommand(spec.cmd, shared));
          this.buttons.set(spec.cmd, shared);
          g.appendChild(shared);
          continue;
        }
        const b = html(
          'button',
          {
            type: 'button',
            class: ['tb-btn', spec.label ? '' : 'icon-only', spec.keepLabel ? 'keep-label' : ''].filter(Boolean).join(' '),
            title: spec.title,
            'aria-label': spec.label || spec.title,
            'data-cmd': spec.cmd,
            'aria-haspopup': spec.menu ? 'menu' : undefined,
            'aria-pressed': spec.cmd === 'layerZoom' || spec.cmd === 'foldErrors' ? 'false' : undefined,
          },
          [
            html('span', { class: 'tb-icon', 'aria-hidden': 'true' }, [typeof spec.icon === 'string' ? spec.icon : spec.icon()]),
            spec.label ? html('span', { class: 'tb-label' }, [spec.label]) : null,
            spec.cmd === 'hidden' ? html('span', { class: 'tb-badge' }) : null,
            spec.cmd === 'view' ? html('span', { class: 'tb-dot', 'aria-hidden': 'true' }) : null,
            spec.menu ? html('span', { class: 'tb-caret', 'aria-hidden': 'true' }, ['▾']) : null,
          ],
        );
        b.addEventListener('click', () => onCommand(spec.cmd, b));
        this.buttons.set(spec.cmd, b);
        g.appendChild(b);
      }
      this.element.appendChild(g);
    }
    this.update(null);
    observeCompact(this.element, COMPACT_BELOW);
  }

  button(cmd: ToolbarCommand): HTMLButtonElement {
    return this.buttons.get(cmd)!;
  }

  /** FR-14.3: icons only below COMPACT_BELOW px (called by a ResizeObserver; tests call it directly). */
  fitWidth(width: number): void {
    setCompact(this.element, width, COMPACT_BELOW);
  }

  update(d: SequenceDiagram | null): void {
    for (const group of GROUPS) {
      for (const spec of group) {
        const b = this.buttons.get(spec.cmd)!;
        let disabled = !d && spec.cmd !== 'entryPoints'; // FR-16.2 also from an empty panel
        if (d && spec.cmd === 'back') disabled = !d.canGoBack;
        if (d && spec.cmd === 'forward') disabled = !d.canGoForward;
        b.disabled = disabled;
      }
    }
    const hidden = this.buttons.get('hidden')!;
    const n = d?.hiddenFilters.length ?? 0;
    hidden.querySelector('.tb-badge')!.textContent = n ? String(n) : '';
    hidden.classList.toggle('has-filters', n > 0);
    // Filters ▾ only once there is a filter (a right-click ▸ Hide adds the first)
    hidden.hidden = n === 0;
    // FR-3.12 ↯ pressed while the error branches fold (on when absent)
    const errors = this.buttons.get('foldErrors')!;
    const folding = !!d && optionEnabled(d.options, 'foldErrors');
    errors.classList.toggle('active', folding);
    errors.setAttribute('aria-pressed', String(folding));
    // FR-28 the zoom button shows the mode
    const zoom = this.buttons.get('layerZoom')!;
    const zoomed = !!d && optionEnabled(d.options, 'layerZoom');
    zoom.classList.toggle('active', zoomed);
    zoom.setAttribute('aria-pressed', String(zoomed));
    // FR-28.11 the label and tooltip say what the click does: fold every layer, or open every layer (no ▾: ◫ and
    // the right-click menus of the lifelines / objects have both)
    const label = zoomed ? 'Open layers' : 'Fold layers';
    zoom.querySelector('.tb-label')!.textContent = label;
    zoom.setAttribute('aria-label', label);
    zoom.title = zoomed ? OPEN_ALL_TITLE : FOLD_ALL_TITLE;
    // FR-19.17 ⚠ N for every flow (muted at 0), as in the class diagram
    updateIssuesButton(this.buttons.get('findings')!, d?.findings, !!d, 0, d?.issuesBelow);
    // FR-14.2: a dot on View ▾ when an option differs from its default; the tooltip says which
    const view = this.buttons.get('view')!;
    const changed = d ? changedViewOptions(d.options) : [];
    view.classList.toggle('changed', changed.length > 0);
    const base = GROUPS.flat().find((s) => s.cmd === 'view')!.title;
    view.title = changed.length ? `${base}\nChanged: ${changed.map((o) => `${o.label} ${optionEnabled(d!.options, o.option) ? 'on' : 'off'}`).join(', ')}` : base;
  }
}
