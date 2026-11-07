/**
 * FR-19.10 guidance for a design finding: why it was flagged,
 * what it costs, how to fix it, when it is fine — as a small card with actions. Static text per kind,
 * filled with the finding's own names; no analysis, no runtime cost. Plain DOM (every host).
 */
import type { Finding, FindingKind } from '@seqcall/protocol';
import { copyText } from './clipboard';
import { FLASH_MS, html } from './dom';

export interface Guide {
  /** One or two sentences: the rule, in words. */
  why: string;
  consequences: string;
  fixes: string[];
  ok: string;
}

export type GuideKind = FindingKind | 'layer-violation';

const GUIDES: Record<GuideKind, Guide> = {
  'io-in-loop': {
    why: 'A call inside a loop over a collection does remote I/O (database, HTTP, queue, cloud) — once per element.',
    consequences: 'N+1 round trips: response time and database / API load grow with the number of items; each remote call can fail on its own, leaving partial work behind.',
    fixes: [
      'Load in bulk before the loop: one query for all ids (whereIn, eager loading with() / Include), a batch endpoint.',
      'Cache per request: memoize the lookup by key.',
      'Pass already-loaded data into the loop body instead of fetching inside it.',
      'Queue the work when it does not have to finish within the request.',
    ],
    ok: 'The collection is always small (a handful of items), or the call is served from a cache after the first item — "Possible I/O" cannot see caches.',
  },
  'io-in-domain': {
    why: 'A class in the Domain layer does I/O: its file uses a database / HTTP / file library, or it calls code that does.',
    consequences: 'Business rules can no longer be tested without infrastructure, become slow and tied to a storage or a service; a change of the database or API ripples into the domain.',
    fixes: [
      'Put the I/O behind a port: an interface the domain owns, implemented in Infrastructure.',
      'Let an application service load the data and pass it in; keep the domain object free of I/O.',
      'If the class really is infrastructure (a repository, a client), move it to that layer (⚑ / Move to layer).',
    ],
    ok: 'Active Record models do I/O by design (Eloquent models are already exempt), or a deliberate pragmatic choice.',
  },
  'layer-ping-pong': {
    why: 'Along one call path the layers call back and forth: A → B → A → B. Callbacks (lambdas, functions passed in or handed out as props) do not count as a step back.',
    consequences: 'The flow is hard to follow, the outer layer leaks into the inner one, and a change in one layer forces changes in the other.',
    fixes: [
      'Fetch what the inner layer needs up front and pass it in — one call per layer.',
      'Give the port one richer operation instead of several fine-grained calls.',
      'Gather the logic on one side (an aggregate, a service).',
    ],
    ok: 'Callbacks the framework requires (events, middleware). To turn the kind off: "findings": { "disable": ["layer-ping-pong"] } in .seqcall.json.',
  },
  'cyclic-collaboration': {
    why: 'Along one call path a class is reached again through others (A → B → … → A): the classes call each other. Callbacks (lambdas, functions passed in, inner functions handed out) do not count.',
    consequences: 'None of them can be understood, tested or changed alone; cycles tend to grow and block splitting the code into modules.',
    fixes: [
      'Invert one direction: the caller owns an interface the other side implements.',
      'Replace the call back with an event or a callback parameter.',
      'Merge responsibilities that belong together, or extract the shared part into a third class.',
    ],
    ok: 'A deliberate double dispatch (visitor). To accept cycles: "findings": { "disable": ["cyclic-collaboration"] }.',
  },
  'dependency-cycle': {
    why: 'Among the classes shown, each depends on the next and the last on the first (fields, calls, creations, type uses). Calls into the inner functions of a function (its own helpers or callbacks it handed out) do not count.',
    consequences: 'They can only be built, tested and reasoned about together; a change anywhere in the cycle can affect all of them.',
    fixes: [
      'Dependency inversion: let the inner class depend on an interface, not on the outer class.',
      'Move the piece both need into a class of its own.',
      'Pass data instead of the object (a callback or a value), so one direction disappears.',
    ],
    ok: 'Data classes that reference each other (an order and its lines) — usually fine. To accept cycles: "findings": { "disable": ["dependency-cycle"] }.',
  },
  'god-class': {
    why: 'Many methods, a long file, and much state or many collaborators — all three (defaults: 20 methods, 500 lines, 10 fields or 7 injected dependencies).',
    consequences: 'It knows and does too much: most changes touch it, every test needs a large setup, and it collects merge conflicts and bugs.',
    fixes: [
      'Find the groups of methods that use the same fields: each group is a class waiting to be extracted.',
      'Move behaviour to the data it works on (the classes it reads from most).',
      'Put a narrow interface in front for each kind of caller, then move the implementation behind it piece by piece.',
    ],
    ok: 'Generated code, framework facades and large but simple mappers. Silence one: "findings": { "ignore": ["JsonMapper"] }; tune: "findings": { "godClass": { "methods": 30, "lines": 800 } }. Active Record models (Eloquent …) are not checked unless "godClass": { "models": true }.',
  },
  'too-many-dependencies': {
    why: 'The class gets more collaborators injected than the threshold (default 6).',
    consequences: 'It probably does several jobs: many mocks to test it, many reasons to change, a magnet for merge conflicts.',
    fixes: [
      'Split it by responsibility — one service per use case.',
      'Group collaborators that are always used together behind a facade.',
      'Move behaviour into the collaborators it mostly works with.',
    ],
    ok: 'Composition roots and thin controllers that only delegate. Raise the threshold: "findings": { "maxDependencies": 8 }.',
  },
  'layer-violation': {
    why: 'The dependency rule: inner layers (Domain, then Application) must not depend on outer ones (Infrastructure, Presentation). Here an inner class calls, holds or creates an outer one.',
    consequences: 'The inner layer cannot be built, tested or changed without the outer one: a change in database, HTTP or UI code ripples into the business rules, and the domain cannot be reused elsewhere.',
    fixes: [
      'Dependency inversion: put an interface (port) for what the inner class needs into the inner layer; the outer class implements it and is passed in.',
      'Move the code that needs the outer class out of the inner one (into an application service or an adapter).',
      'Pass plain data instead of the outer object.',
      'If the class is in the wrong layer (⚑ suggests one), move it: that is the fix, not a code change.',
    ],
    ok: 'The layers are misclassified (fix the rule or the layer, not the code); a shared kernel of value types / DTOs used by every layer; a framework base class the domain deliberately builds on.',
  },
};

export function guideOf(kind: GuideKind): Guide {
  return GUIDES[kind];
}

export interface CardAction {
  label: string;
  title?: string;
  primary?: boolean;
  run(): void;
}

/**
 * FR-19.10 a card that folds to its title line (`▸ Why?` unfolds it, `▾` folds it back, ✕ closes);
 * `changed` reports the reader's choice so the next card opens the same way.
 */
export interface CardFold {
  folded: boolean;
  changed(folded: boolean): void;
  close(): void;
}

/** The card: title, the case in one line (`detail`), Why / Consequences / How to fix / When it's OK, actions. */
/** FR-19.13 a guide card as Markdown: title, the case, why / consequences / how to fix / when it is OK. */
export function guideMarkdown(title: string, guide: Guide, detail?: string, evidence?: string[]): string {
  return [
    `### ${title}`,
    ...(detail ? ['', detail] : []),
    // FR-19.14 the concrete case before the general text
    ...(evidence?.length ? ['', '**In this diagram:**', ...evidence.map((e) => `- ${e}`)] : []),
    '',
    `**Why flagged:** ${guide.why}`,
    '',
    `**Consequences:** ${guide.consequences}`,
    '',
    '**How to fix:**',
    ...guide.fixes.map((f) => `- ${f}`),
    '',
    `**When it's OK:** ${guide.ok}`,
    '',
  ].join('\n');
}

export function guideCard(title: string, guide: Guide, opts: { detail?: string; evidence?: string[]; actions?: CardAction[]; fold?: CardFold; /** FR-25.5 an issue of the user's code: Ask AI too */ ask?: boolean } = {}): HTMLElement {
  const card = html('div', { class: 'guide-card', role: 'dialog', 'aria-label': title });
  const titleEl = html('div', { class: 'gc-title' }, [title]);
  if (opts.fold) {
    const fold = opts.fold;
    const toggle = html('button', { type: 'button', class: 'gc-fold' });
    const close = html('button', { type: 'button', class: 'gc-close', title: 'Close', 'aria-label': 'Close' }, ['✕']);
    const set = (folded: boolean) => {
      card.classList.toggle('folded', folded);
      toggle.textContent = folded ? '▸ Why?' : '▾';
      toggle.title = folded ? 'Why it is flagged, the consequences, how to fix it, when it is OK' : 'Fold to the title line';
      toggle.setAttribute('aria-expanded', String(!folded));
      titleEl.title = folded ? title : '';
    };
    const flip = () => {
      const folded = !card.classList.contains('folded');
      set(folded);
      fold.changed(folded);
    };
    toggle.addEventListener('click', flip);
    titleEl.addEventListener('click', flip);
    close.addEventListener('click', () => fold.close());
    card.appendChild(html('div', { class: 'gc-head' }, [titleEl, toggle, close]));
    set(fold.folded);
  } else card.appendChild(titleEl);
  if (opts.detail) card.appendChild(html('div', { class: 'gc-detail' }, [opts.detail]));
  const section = (label: string, body: HTMLElement | string) => card.appendChild(html('div', { class: 'gc-section' }, [html('div', { class: 'gc-label' }, [label]), typeof body === 'string' ? html('div', { class: 'gc-text' }, [body]) : body]));
  if (opts.evidence?.length) section('In this diagram', html('ul', { class: 'gc-fixes gc-evidence' }, opts.evidence.map((e) => html('li', {}, [e]))));
  section('Why flagged', guide.why);
  section('Consequences', guide.consequences);
  section('How to fix', html('ul', { class: 'gc-fixes' }, guide.fixes.map((f) => html('li', {}, [f]))));
  section("When it's OK", guide.ok);
  // FR-19.13 the card as text, for a colleague or an AI agent (not a screenshot)
  const copy: CardAction = { label: 'Copy as Markdown', title: 'Copy this card as Markdown, to paste into a chat, an issue or an AI agent', run: () => void copyText(guideMarkdown(title, guide, opts.detail, opts.evidence)).then((ok) => flash(ok ? 'Copied ✓' : 'Copy failed')) };
  // FR-25.5 the card with a question first, for an AI chat or agent
  const ask: CardAction = { label: 'Ask AI', title: 'Copy a question about this issue, with the card, to paste into an AI chat or agent', run: () => void copyText(askMarkdown(guideMarkdown(title, guide, opts.detail, opts.evidence))).then((ok) => flash(ok ? 'Copied ✓' : 'Copy failed', ask)) };
  // after the card's own actions, before the primary one (Close)
  const actions = [...(opts.actions ?? []).filter((x) => !x.primary), copy, ...(opts.ask ? [ask] : []), ...(opts.actions ?? []).filter((x) => x.primary)];
  const buttons = new Map<CardAction, HTMLElement>();
  const flash = (text: string, a: CardAction = copy) => {
    const b = buttons.get(a)!;
    b.textContent = text;
    setTimeout(() => (b.textContent = a.label), FLASH_MS);
  };
  {
    const row = html('div', { class: 'gc-actions' });
    for (const a of actions) {
      const b = html('button', { type: 'button', class: `gc-btn${a.primary ? ' primary' : ''}`, ...(a.title ? { title: a.title } : {}) }, [a.label]);
      b.addEventListener('click', () => a.run());
      buttons.set(a, b);
      row.appendChild(b);
    }
    card.appendChild(row);
  }
  return card;
}

/** FR-25.5 a question for an AI chat or agent, then the card as Markdown. */
export function askMarkdown(card: string): string {
  return [
    'Seqcall flagged this design issue in my code (the card below says why it flags it and how it is usually fixed).',
    'Read the code it names. Is it a real problem here or acceptable, and if real, what is the smallest fix?',
    '',
    card,
  ].join('\n');
}

/** The card of a design finding; "Ignore …" only for kinds `findings.ignore` can silence one by one. */
export function findingCard(f: Finding, actions: { show(): void; ignore(pattern: string): void; close(): void }, fold?: { folded: boolean; changed(folded: boolean): void }): HTMLElement {
  return guideCard(`⚠ ${f.title}`, guideOf(f.kind), {
    ask: true,
    detail: f.detail,
    ...(f.evidence?.length ? { evidence: f.evidence } : {}),
    ...(fold ? { fold: { ...fold, close: actions.close } } : {}),
    actions: [
      { label: 'Show in diagram', run: actions.show },
      ...(f.ignoreKey
        ? [{ label: `Ignore ${f.ignoreKey}`, title: `Add "${f.ignoreKey}" to findings.ignore in .seqcall.json`, run: () => actions.ignore(f.ignoreKey!) }]
        : []),
      { label: 'Close', primary: true, run: actions.close },
    ],
  });
}

/** FR-12.16 one side of a layer violation: its class, its layer and — when ⚑ suggests one — the layer it may belong to. */
export interface ViolationSide {
  key: string;
  name: string;
  layer?: string;
  suggested?: string;
  reasons?: string[];
  /** FR-7.11 the hint's convention says the file is in place: no "Move" action. */
  noMove?: boolean;
}

/**
 * FR-12.16 the card of a layer violation (`from` depends on `to`): the case, why / consequences / how to fix /
 * when it is OK, and actions — show the calls, move a class that ⚑ says is misclassified, adjust the rule.
 */
/**
 * FR-19.17 one icon per kind of issue, the same in both diagrams' lists (the type gives every kind one). none
 * shared with a button (⇄ change together, ↻ rescan / refresh, ▦ class diagram).
 */
export const FINDING_ICON: Record<FindingKind, string> = {
  'io-in-loop': '⟳',
  'io-in-domain': '◆',
  'layer-ping-pong': '⇅',
  'cyclic-collaboration': '∞',
  'dependency-cycle': '∞',
  'too-many-dependencies': '⧉',
  'god-class': '◉',
  'layer-violation': '⚠',
};

/** FR-7.16 an issue's title: a layer violation resting on a guessed layer says it is only possible. */
export const issueTitle = (f: Finding): string => (f.possible ? f.title.replace(/^Layer violation/, 'Possible layer violation') : f.title);

export function violationCard(
  from: ViolationSide,
  to: ViolationSide,
  violation: string,
  actions: { show(): void; move(side: ViolationSide): void; adjustRule(): void; close(): void },
  fold?: { folded: boolean; changed(folded: boolean): void },
  evidence?: string[],
  /** FR-7.16 it rests on a guessed layer: one line per guessed end (`` `Cart` is Domain by a guess: … ``). */
  possible?: string[],
): HTMLElement {
  const side = (s: ViolationSide) => `${s.name}${s.layer ? ` (${s.layer})` : ''}`;
  const hints = [from, to].filter((s) => s.suggested && s.suggested !== s.layer);
  // FR-7.16 a guessed side with no ⚑ elsewhere: confirming its layer (a rule in the config) makes the violation certain
  const guessed = possible?.length ? [from, to].filter((s) => s.layer && !hints.includes(s) && possible.some((g) => g.startsWith(`\`${s.name}\` is `))) : [];
  const detail = [
    ...(possible?.length ? [`Possible: it rests on a guessed layer — ${possible.join('; ')}. Put the class in its layer to make it certain, or move it where it belongs.`] : []),
    violation,
    ...hints.map((s) => `⚑ ${s.name} looks like ${s.suggested}${s.reasons?.length ? ` — ${s.reasons[0]}` : ''}: a misclassification would explain this violation.`),
  ].join(' ');
  return guideCard(`⚠ ${possible?.length ? 'Possible layer violation' : 'Layer violation'}: ${side(from)} → ${side(to)}`, guideOf('layer-violation'), {
    ask: true,
    detail,
    ...(evidence?.length ? { evidence } : {}),
    ...(fold ? { fold: { ...fold, close: actions.close } } : {}),
    actions: [
      { label: 'Show in diagram', run: actions.show },
      ...hints.filter((s) => !s.noMove).map((s) => ({ label: `Move ${s.name} to ${s.suggested}`, title: `Put ${s.name}'s file into ${s.suggested} (.seqcall.json, with Undo)`, run: () => actions.move(s) })),
      ...guessed.map((s) => ({ label: `Confirm ${s.name} in ${s.layer}`, title: `Its layer is a guess: put ${s.name}'s file into ${s.layer} (.seqcall.json, with Undo)`, run: () => actions.move({ ...s, suggested: s.layer }) })),
      { label: 'Adjust the rule', title: 'Open .seqcall.json at dependencyRule (the default is added when missing)', run: actions.adjustRule },
      { label: 'Close', primary: true, run: actions.close },
    ],
  });
}

