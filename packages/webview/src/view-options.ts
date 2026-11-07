/**
 * FR-14.2 the View ▾ options, shared by both views: the sequence view lists them all, the class view its section of
 * marks drawn in both diagrams (design findings, review changes) — the same words, order and tooltips.
 */
import type { DiagramOptions } from '@seqcall/protocol';
import type { MenuItem } from './menu';

/** FR-14.2 display options of the View ▾ menu: preferences set once, so they are not buttons. */
export interface ViewOption {
  option: keyof DiagramOptions;
  label: string;
  title: string;
  /** Built-in default (the View button shows a dot when an option differs). */
  default: boolean;
  /** Changes how the panel behaves, not what is drawn (listed after a separator). */
  behaviour?: boolean;
  /** marks drawn in both diagrams — the same section in both View ▾ menus. */
  mark?: true;
}

export const VIEW_OPTIONS: ViewOption[] = [
  { option: 'showArguments', label: 'Arguments', title: 'Show call arguments', default: false },
  { option: 'showResults', label: 'Results', title: 'Show where results go: user = findUser(id), ↩ for returned values (return types in the hover card)', default: false },
  { option: 'showReturnTypes', label: 'Return types', title: 'Show the short return type after a call whose value goes elsewhere: isValid(value): boolean (an argument, a condition, a chain)', default: false },
  { option: 'showSideEffects', label: 'I/O badges', title: 'Mark calls and classes that do I/O: DB, CACHE, HTTP, FILE, MQ (queues), CLOUD, PROC (processes)', default: true },
  { option: 'showLibraryCalls', label: 'Library calls', title: 'Show calls into libraries and the runtime', default: false },
  { option: 'mergeHelpers', label: 'One lifeline per helper type', title: 'Objects of one class created in the drawn calls and never stored in a field share one lifeline (×n, each «create» numbered #1, #2 …): fewer columns, but they may be different objects', default: false },
  { option: 'showFragments', label: 'Fragments', title: 'Show alt / opt / loop frames around conditional and repeated calls', default: true },
  { option: 'showPipeline', label: 'Pipeline', title: "Before an entry point's action: the middleware the request passes first (one collapsed row)", default: true },
  { option: 'foldErrors', label: 'Fold errors', title: 'Fold the error branches (catch, throw, early return) into one-line markers at every depth; ⊕ on a marker shows one (the ↯ toolbar button)', default: true },
  { option: 'layerZoom', label: 'Layer zoom', title: 'One lifeline per layer: only the calls that cross a layer are drawn, the calls inside a layer fold into them (+n); the class diagram shows one package per layer', default: false },
  { option: 'showFindings', label: 'Design issues', title: 'Mark likely design flaws: I/O in loops, I/O in Domain, layer ping-pong, cycles', default: true, mark: true },
  { option: 'showReviewMarks', label: 'Review changes', title: 'While a branch review is on: mark new / changed / removed calls, objects, classes and members (both diagrams)', default: true, mark: true },
  { option: 'autoTidy', label: 'Tidy up after expanding', title: 'After every expand or collapse, and after hiding / unhiding, pack the participants close together (keeps their order)', default: true, behaviour: true },
  { option: 'followCursor', label: 'Follow cursor', title: 'Redraw when the cursor moves to another method', default: false, behaviour: true },
];

/**
 * Effective value of a boolean option; fragments, the pipeline, results, return types and I/O badges are on when absent (the
 * protocol's rule, for old shared diagrams and saved state). The core always sends every option, with its defaults.
 */
export function optionEnabled(options: DiagramOptions, key: keyof DiagramOptions): boolean {
  const v = options[key];
  return key === 'showFragments' || key === 'showPipeline' || key === 'showResults' || key === 'showReturnTypes' || key === 'showSideEffects' || key === 'showFindings' || key === 'showReviewMarks' || key === 'autoTidy' || key === 'foldErrors' ? v !== false : v === true;
}

/** View options that differ from their built-in default. */
export function changedViewOptions(options: DiagramOptions): ViewOption[] {
  return VIEW_OPTIONS.filter((o) => optionEnabled(options, o.option) !== o.default);
}

/** The section of marks drawn in both diagrams, as View ▾ rows (heading first). */
export function markItems(options: DiagramOptions, set: (option: keyof DiagramOptions, value: boolean) => void, disabled = false): MenuItem[] {
  return [
    { id: 'view:marks-head', label: 'Marks · both diagrams', disabled: true },
    ...VIEW_OPTIONS.filter((o) => o.mark).map((o): MenuItem => {
      const on = optionEnabled(options, o.option);
      return { id: `view:${o.option}`, label: o.label, title: o.title, role: 'checkbox', checked: on, keepOpen: true, disabled, action: () => set(o.option, !on) };
    }),
  ];
}
