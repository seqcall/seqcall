// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView, HostToSequenceView, LayerHint, LayerReason, SequenceViewToHost } from '@seqcall/protocol';
import { layerHintMenu, layerHintTitle } from '../src/layer-hint';
import { violationCard } from '../src/finding-guide';
import { startSequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const item = (root: HTMLElement, id: string) => root.querySelector(`.popup-layer [data-menu-id="${id}"]`) as HTMLElement | null;
const contextMenu = (el: Element) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
const card = (root: HTMLElement) => root.querySelector('.popup-layer .layer-reason-card') as HTMLElement | null;

const weak: LayerReason = {
  rule: 'role-folder',
  text: 'role folder `Services/`',
  strength: 'weak',
  notApplied: ['no layer rules in .seqcall.json', 'no layer folder (presentation, application, domain, infrastructure, …) in the path'],
  path: 'vendor/x/src/Services/Core/Services/ShopSettingsService.php',
  folders: ['Services'],
};

describe('FR-7.8 Why this layer?', () => {
  function setup(hint: LayerHint = { suggested: 'Domain', reasons: ['pure (whole file): takes no ports, no I/O'] }) {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const p = d.participants.find((x) => x.classKey.includes('#') && !x.classKey.startsWith('lib:') && x.layer)!;
    p.layerReason = weak;
    p.layerHint = hint;
    p.layerViolations = ['depends on Infrastructure: RequestClient'];
    p.stereotypeReasons = [
      { stereotype: 'service', text: 'name ends in `Service`' },
      { stereotype: 'seam', text: 'reached through the injected `ShopSettingsServiceContract` in this diagram', inThisDiagram: true },
    ];
    p.stereotypes = ['service', 'seam'];
    d.layerChoices = ['Presentation', 'Application', 'Domain', 'Infrastructure'];
    bridge.send({ type: 'render', diagram: d });
    bridge.posted.length = 0;
    return { bridge, view, p };
  }

  it('FR-7.11 a hint whose fix is not moving the file (FSD: the call belongs in api/): the advice, no "Move to …" in the card, menus or violation card', () => {
    const fsd: LayerHint = { suggested: 'Infrastructure', reasons: ['does I/O: OpenapiQueryClient.useMutation'], advice: 'in FSD, backend calls belong in an `api/` segment', noMove: true };
    const { bridge, view, p } = setup(fsd);
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    expect(item(view.root, 'apply-layer-hint')).toBeNull();
    item(view.root, 'why-layer')!.click();
    const c = card(view.root)!;
    expect(c.querySelector('.lr-hint')!.textContent).toBe('⚑Infrastructure: does I/O: OpenapiQueryClient.useMutation — in FSD, backend calls belong in an api/ segment');
    expect(c.querySelector('[data-cmd="lr-apply"]')).toBeNull();
    expect(c.querySelector('[data-cmd="lr-move"]')).not.toBeNull(); // moving by hand stays possible
    // the note says where the fix is; the hint can be silenced for this file
    // the fix right under the hint (before the stereotypes); the note only says what Move to layer… does
    const sections = [...c.querySelectorAll('.lr-section')];
    const suggests = sections.find((x) => x.querySelector('.lr-head')!.textContent === 'What the code suggests')!;
    expect(suggests.querySelector('.lr-fix')!.textContent).toBe('→The fix is in the code: put the backend call in an api/ segment.');
    expect(sections.indexOf(suggests)).toBeLessThan(sections.findIndex((x) => x.querySelector('.lr-head')!.textContent === 'Stereotypes'));
    expect(c.querySelector('.lr-note')!.textContent).toBe('Move to layer… only relabels the file (a rule in .seqcall.json).');
    (c.querySelector('[data-cmd="lr-ignore-hint"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'ignoreLayerHint', pattern: p.classKey.slice(0, p.classKey.indexOf('#')) });
    // the ⚑'s tooltip and menu
    const t = { classKey: p.classKey, className: p.className, layer: p.layer, layerHint: fsd };
    expect(layerHintTitle(p.layer, fsd)).toContain('→ in FSD, backend calls belong in an api/ segment');
    expect(layerHintMenu(t, () => undefined).some((m) => m.id === 'apply-layer-hint')).toBe(false);
    // a violation card offers no move for that side
    const actions = { show: () => undefined, move: () => undefined, adjustRule: () => undefined, close: () => undefined };
    const v = violationCard({ key: 'a', name: 'products.hooks', layer: 'Application', suggested: 'Infrastructure', reasons: fsd.reasons, noMove: true }, { key: 'b', name: 'x', layer: 'Presentation' }, 'Application → Presentation', actions);
    expect([...v.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Move products.hooks to Infrastructure');
    const movable = violationCard({ key: 'a', name: 'products.hooks', layer: 'Application', suggested: 'Infrastructure', reasons: fsd.reasons }, { key: 'b', name: 'x', layer: 'Presentation' }, 'Application → Presentation', actions);
    expect([...movable.querySelectorAll('button')].map((b) => b.textContent)).toContain('Move products.hooks to Infrastructure');
  });

  it('FR-7.11 a rule that recognised the file and gave no layer on purpose is a note (·), not a miss (✗)', () => {
    const line = 'Feature-Sliced Design preset: `shared/lib/` is shared code, no layer of its own';
    const { view, p } = setup();
    p.layerReason = { rule: 'none', text: 'no rule applies', strength: 'weak', notApplied: ['no layer rules in .seqcall.json', line], noted: [line] };
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    item(view.root, 'why-layer')!.click();
    const c = card(view.root)!;
    expect([...c.querySelectorAll('.lr-skipped')].map((r) => r.textContent)).toEqual(['✗no layer rules in .seqcall.json']);
    expect([...c.querySelectorAll('.lr-noted')].map((r) => r.textContent)).toEqual(['·Feature-Sliced Design preset: shared/lib/ is shared code, no layer of its own']);
  });

  it('FR-7.8 the box tooltip names the layer and the rule that decided (weak signals say so)', () => {
    const { view, p } = setup();
    const title = view.header.querySelector(`[data-participant-id="${p.id}"] > title`)!.textContent!;
    expect(title).toContain(`${p.layer} — role folder Services/ (weak signal)`);
  });

  it('FR-7.9 the «…» line of a box explains each stereotype; the menu offers the card for both', () => {
    const { view, p } = setup();
    const stereo = view.header.querySelector(`[data-participant-id="${p.id}"] .p-stereo title`)!.textContent;
    expect(stereo).toBe('«service» — name ends in Service\n«seam» — reached through the injected ShopSettingsServiceContract in this diagram');
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    expect(item(view.root, 'why-layer')!.textContent).toContain('Why this layer and these stereotypes?');
    item(view.root, 'why-layer')!.click();
    const rows = [...card(view.root)!.querySelectorAll('.lr-stereo')].map((r) => r.textContent);
    expect(rows).toEqual(['«»«service» name ends in Service', '«»«seam» reached through the injected ShopSettingsServiceContract in this diagram']);
  });

  it('FR-7.8 the card: rules checked, the one that decided, what the code suggests, violations, and moving it', () => {
    const { bridge, view, p } = setup();
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    item(view.root, 'why-layer')!.click();
    const c = card(view.root)!;
    expect(c.querySelector('.callers-title')!.textContent).toBe(`Why ${p.className} is in ${p.layer}`);
    expect([...c.querySelectorAll('.lr-skipped')].map((r) => r.textContent)).toEqual(['✗no layer rules in .seqcall.json', '✗no layer folder (presentation, application, domain, infrastructure, …) in the path']);
    const decided = c.querySelector('.lr-decided')!;
    expect(decided.classList.contains('weak')).toBe(true);
    expect(decided.textContent).toContain('role folder Services/');
    expect(decided.querySelector('.code')!.textContent).toBe('Services/');
    expect(c.querySelector('.lr-hint')!.textContent).toContain('Domain: pure (whole file)');
    // the file, with the folder that decided highlighted (the innermost one)
    expect(c.querySelector('.lr-path')!.textContent).toBe('vendor/x/src/Services/Core/Services/ShopSettingsService.php');
    expect([...c.querySelectorAll('.lr-hit')].map((m) => m.textContent)).toEqual(['Services']);
    expect(c.querySelector('.lr-path')!.innerHTML).toContain('Core/<wbr><mark class="lr-hit">Services</mark>/<wbr>ShopSettingsService.php');
    expect(c.querySelector('.lr-violation')!.textContent).toContain('depends on Infrastructure: RequestClient');
    // apply the suggestion
    (c.querySelector('[data-cmd="lr-apply"]') as HTMLElement).click();
    (view.root.querySelector('.popup-layer [data-cmd="ls-move"]') as HTMLElement).click(); // FR-7.12 the scope card: this file
    expect(bridge.last()).toEqual({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Domain' });
    // or pick a layer (the current one is not offered)
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    item(view.root, 'why-layer')!.click();
    (card(view.root)!.querySelector('[data-cmd="lr-move"]') as HTMLElement).click();
    expect(item(view.root, `layer:${p.layer}`)).toBeNull();
    item(view.root, 'layer:Infrastructure')!.click();
    (view.root.querySelector('.popup-layer [data-cmd="ls-move"]') as HTMLElement).click(); // FR-7.12 the scope card: this file
    expect(bridge.last()).toEqual({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Infrastructure' });
  });

  it('FR-7.8 no reason (a library, an old host): no menu entry', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    bridge.send({ type: 'render', diagram: d });
    contextMenu(view.header.querySelector(`[data-participant-id="${d.participants[0].id}"] rect`)!);
    expect(item(view.root, 'why-layer')).toBeNull();
  });

  it('FR-7.8 class diagram: tooltip line and the same card, violations taken from its relations', () => {
    const bridge = testBridge<HostToClassView, ClassViewToHost>();
    const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
    const d = structuredClone(mockClassDiagram);
    const c = d.classes.find((x) => d.relations.some((r) => r.from === x.key && x.layer))!;
    const rel = d.relations.find((r) => r.from === c.key)!;
    rel.violation = 'x → y: an inner layer depends on an outer layer';
    c.layerReason = { rule: 'folder', text: 'layer folder `Domain/`', strength: 'strong', notApplied: ['no layer rules in .seqcall.json'] };
    bridge.send({ type: 'render', diagram: d });
    const box = view.root.querySelector(`[data-class-key="${c.key}"]`)!;
    expect(box.querySelector(':scope > title')!.textContent).toContain(`${c.layer} — layer folder Domain/`);
    contextMenu(box.querySelector('rect')!);
    item(view.root, 'why-layer')!.click();
    const k = card(view.root)!;
    expect(k.querySelector('.lr-decided')!.classList.contains('strong')).toBe(true);
    const target = d.classes.find((x) => x.key === rel.to)!;
    expect(k.querySelector('.lr-violation')!.textContent).toContain(`depends on ${target.layer}: ${target.name}`);
  });
});

describe('FR-7.12 Move to layer: what the rule covers', () => {
  it('FR-7.12 choosing a layer asks for the scopes; the folder is preselected; Move writes the rule for the chosen glob', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    const p = d.participants.find((x) => x.classKey.includes('#') && !x.classKey.startsWith('lib:'))!;
    d.layerChoices = ['Presentation', 'Application', 'Domain', 'Infrastructure'];
    bridge.send({ type: 'render', diagram: d });
    contextMenu(view.header.querySelector(`[data-participant-id="${p.id}"] rect`)!);
    item(view.root, 'layer:Infrastructure')!.click();
    expect(bridge.last()).toEqual({ type: 'requestLayerScopes', classKey: p.classKey, className: p.className });
    const scopeCard = () => view.root.querySelector('.popup-layer .layer-scope-card') as HTMLElement;
    expect(scopeCard().textContent).toContain('Counting files…');
    const file = p.classKey.slice(0, p.classKey.indexOf('#'));
    bridge.send({
      type: 'layerScopes',
      classKey: p.classKey,
      scopes: [
        { kind: 'file', glob: file, files: 1 },
        { kind: 'folder', glob: 'app/Managers/Catalog/**', files: 7 },
        { kind: 'folder', glob: 'app/Managers/**', files: 226 },
        { kind: 'name', glob: '**/*Manager.php', files: 25 },
      ],
    });
    const rows = [...scopeCard().querySelectorAll('.ls-row')].map((r) => r.textContent);
    expect(rows).toEqual([`this file ${file.split('/').pop()}`, 'folder app/Managers/Catalog/ — 7 files', 'folder app/Managers/ — 226 files', 'every *Manager.php — 25 files']);
    expect((scopeCard().querySelector('input:checked') as HTMLInputElement).value).toBe('app/Managers/Catalog/**');
    (scopeCard().querySelectorAll('input')[2] as HTMLInputElement).checked = true;
    (scopeCard().querySelector('[data-cmd="ls-move"]') as HTMLElement).click();
    expect(bridge.last()).toEqual({ type: 'setLayer', classKey: p.classKey, className: p.className, layer: 'Infrastructure', match: 'app/Managers/**' });
    expect(scopeCard()).toBeNull();
  });
});
