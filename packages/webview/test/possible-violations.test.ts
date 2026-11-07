// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AppMapLevel, ClassViewToHost, Finding, HostToClassView, HostToSequenceView, ProjectFinding, ReviewResult, SequenceViewToHost } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { issueTitle } from '../src/finding-guide';
import { issuesMenu, violationsText } from '../src/issues-ui';
import { estimateTextWidth } from '../src/measure';
import { designIssuesMarkdown } from '../src/sequence/design-issues';
import { reviewMarkdown, structureKind } from '../src/sequence/review-panel';
import { startSequenceView } from '../src/sequence/view';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// FR-7.16 a violation resting on a guessed layer is only possible: amber instead of red, counted apart, said on its card
const GUESS = '`B` is Infrastructure by a guess: name ends in `Client`';
const violation = (id: string, possible?: string[], extra: Partial<Finding> = {}): Finding => ({
  id,
  kind: 'layer-violation',
  title: `Layer violation: ${id.toUpperCase()} → B`,
  detail: 'Domain → Infrastructure: an inner layer depends on an outer layer',
  classKeys: [id, 'B'],
  ...(possible ? { possible } : {}),
  ...extra,
});
const rows = (items: ReturnType<typeof issuesMenu>) => items.map((i) => (i.separator ? '---' : `${i.label}${i.hint ? ` [${i.hint}]` : ''}`));

describe('FR-7.16 possible layer violations', () => {
  it('FR-7.16 the ⚠ list: the certain ones first, a possible one says so with its guess on hover; the count names the possible ones', () => {
    const items = issuesMenu([violation('p', [GUESS]), violation('c')], () => {});
    expect(rows(items)).toEqual(['⚠ 2 layer violations (1 possible)', 'C → B [Domain → Infrastructure]', 'P → B [possible · Domain → Infrastructure]']);
    expect(items[2].title).toBe(`Domain → Infrastructure: an inner layer depends on an outer layer\n${GUESS}`);
    // without a rule text: only the word, the guess on hover
    expect(issuesMenu([violation('p', [GUESS], { detail: undefined })], () => {}).slice(1).map((i) => [i.hint, i.title])).toEqual([['possible', GUESS]]);
    expect([violationsText([violation('a', [GUESS]), violation('b', [GUESS])]), violationsText([violation('a', [GUESS])]), violationsText([violation('a')])]).toEqual([
      '2 layer violations (all possible)',
      '1 layer violation (1 possible)',
      '1 layer violation',
    ]);
    expect([issueTitle(violation('a', [GUESS])), issueTitle(violation('a'))]).toEqual(['Possible layer violation: A → B', 'Layer violation: A → B']);
  });

  it('FR-7.16 sequence diagram: a possibly violating call is amber (a call in a certain violation too stays red); its card says why and offers to confirm the guessed layer', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const [one, two] = [d.messages[1], d.messages[2]];
    const to = d.participants.find((p) => p.id === two.to)!;
    to.layer = 'Infrastructure';
    d.findings = [
      { ...violation('p', [`\`${to.className}\` is Infrastructure by a guess: name ends in \`Client\``], { messageIds: [one.id, two.id], classKeys: ['p', to.classKey] }), title: `Layer violation: P → ${to.className}` },
      violation('c', undefined, { messageIds: [one.id] }),
      // a possible one after the certain one on the same call: the call stays red
      violation('q', [GUESS], { messageIds: [one.id] }),
      // one on no call of the diagram (a class only)
      violation('z', [GUESS]),
    ];
    bridge.send({ type: 'render', diagram: d });
    const cls = (id: string) => view.body.querySelector(`[data-msg-id="${id}"]`)!.classList;
    expect([cls(one.id).contains('violates'), cls(one.id).contains('possible'), cls(two.id).contains('violates'), cls(two.id).contains('possible')]).toEqual([true, false, true, true]);
    expect(view.toolbar.button('findings').title).toContain('4 layer violations (3 possible)');
    fire(view.toolbar.button('findings'), 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:p"]')!, 'click');
    const card = view.root.querySelector('.guide-card')!;
    expect(card.querySelector('.gc-title')!.textContent).toContain(`⚠ Possible layer violation: P → ${to.className} (Infrastructure)`);
    expect(card.textContent).toContain(`Possible: it rests on a guessed layer — \`${to.className}\` is Infrastructure by a guess`);
    const confirm = [...card.querySelectorAll<HTMLElement>('.gc-btn')].find((b) => b.textContent === `Confirm ${to.className} in Infrastructure`)!;
    fire(confirm, 'click');
    expect(bridge.last()).toEqual({ type: 'requestLayerScopes', classKey: to.classKey, className: to.className });
    expect(view.root.querySelector('.layer-scope-card .lr-layer')!.textContent).toBe('Infrastructure');
  });

  it('FR-7.16 class diagram: a possible violation is drawn amber with its guess on hover; the class card says it as the sequence diagram does', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const node = (key: string, layer: string) => ({ key, name: key, kind: 'class' as const, stereotypes: [], namespace: '', methods: [], layer, layerReason: { rule: 'folder' as const, text: 'layer folder `domain/`', strength: 'strong' as const, notApplied: [] } });
    bridge.send({
      type: 'render',
      diagram: {
        classes: [node('A', 'Domain'), node('B', 'Infrastructure')],
        relations: [{ id: 'r1', kind: 'dependency', from: 'A', to: 'B', violation: 'Domain → Infrastructure: an inner layer depends on an outer layer', possible: [GUESS] }],
        findings: [violation('a', [GUESS], { classKeys: ['A', 'B'], relationIds: ['r1'] })],
      },
      layerChoices: ['Domain', 'Infrastructure'],
    });
    const rel = view.root.querySelector('[data-relation-id="r1"]')!;
    expect([...rel.classList]).toEqual(expect.arrayContaining(['violation', 'possible']));
    expect(rel.querySelector('title')!.textContent).toContain(`\n⚠ possible: Domain → Infrastructure: an inner layer depends on an outer layer\n  ${GUESS}`);
    fire(rel.querySelector('.rel-hit')!, 'click');
    expect(view.root.querySelector('.guide-card .gc-title')!.textContent).toContain('⚠ Possible layer violation: A (Domain) → B (Infrastructure)');
    // the class card's dependency rule
    fire(view.root.querySelector('[data-class-key="A"]')!, 'contextmenu');
    fire(view.root.querySelector('.popup-layer [data-menu-id="why-layer"]')!, 'click');
    expect([...view.root.querySelectorAll('.layer-reason-card .lr-violation')].map((r) => r.textContent)).toEqual([`⚠depends on Infrastructure: B (possible: ${GUESS})`]);
  });

  it('FR-7.16 codebase map: the summary counts the possible ones, the ⚠ list and the card say so', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    view.enterApp('');
    const level: AppMapLevel = {
      path: '',
      crumbs: [{ label: 'Codebase', path: '' }],
      entryPoints: 1,
      failed: 0,
      truncated: 0,
      classes: 2,
      relations: 1,
      violations: 1,
      possibleViolations: 1,
      computedAt: '2026-10-31T10:00:00.000Z',
      diagram: { layers: [], classes: [], relations: [] },
      violationList: [{ from: 'src/a.ts#A', to: 'src/b.ts#B', fromName: 'A', toName: 'B', violation: 'Domain → Infrastructure', folder: 'src', fromLayer: 'Domain', toLayer: 'Infrastructure', possible: [GUESS] }],
    };
    bridge.send({ type: 'appMap', state: 'done', level });
    expect(view.root.textContent).toContain('1 layer violation (1 possible)');
    const btn = view.root.querySelector('[data-cmd="findings"]') as HTMLButtonElement;
    expect(btn.title).toContain('1 layer violation (1 possible)');
    fire(btn, 'click');
    fire(view.root.querySelector('.popup-layer [data-menu-id="finding:app-violation:0"]')!, 'click');
    const card = view.root.querySelector('.guide-card')!;
    expect(card.querySelector('.gc-title')!.textContent).toContain('⚠ Possible layer violation: A (Domain) → B (Infrastructure)');
    expect([...card.querySelectorAll('.gc-btn')].map((b) => b.textContent)).toContain('Confirm B in Infrastructure');
  });

  it('FR-7.16 project-wide list and review: the title and the structure row say possible', () => {
    const ep = { kind: 'http' as const, label: 'GET /a', method: { key: 'src/x.ts#X.a', name: 'a', owner: { key: 'src/x.ts#X', name: 'X', kind: 'class' as const } } };
    const pf: ProjectFinding = { finding: violation('a', [GUESS]), entryPoint: ep } as ProjectFinding;
    expect(designIssuesMarkdown({ state: 'done', findings: [pf] } as never, [pf])).toContain('- Possible layer violation: A → B');
    const base = { kind: 'violation-added' as const, title: 'Layer violation: A → B', level: 'layer' as const };
    expect([structureKind({ ...base, possible: [GUESS] }).what, structureKind(base).what]).toEqual(['new possible layer violation', 'new layer violation']);
    const r = { resolvedBase: 'main', methods: [], files: [], issues: [{ finding: violation('a', [GUESS]), where: 'changed-lines' }] } as unknown as ReviewResult;
    expect(reviewMarkdown(r)).toContain('- ⚠ Possible layer violation: A → B');
  });
});
