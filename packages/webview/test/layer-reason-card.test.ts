// @vitest-environment jsdom
import type { LayerReason } from '@seqcall/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLASH_MS } from '../src/dom';
import { layerReasonCard, layerReasonLine, layerReasonMarkdown, pathWithDecision, whyLabel, type LayerReasonTarget } from '../src/layer-reason';

afterEach(() => vi.restoreAllMocks());

const none: LayerReason = { rule: 'none', text: 'no rule applies', strength: 'weak', notApplied: ['no layer rules in .seqcall.json'] };
const config: LayerReason = { rule: 'config', text: 'rule 2 in .seqcall.json: `app/Http/**`', strength: 'strong', notApplied: [] };
const marked = (el: HTMLElement) => [...el.querySelectorAll('mark')].map((m) => m.textContent);
const rows = (card: HTMLElement) => [...card.querySelectorAll('.lr-row')].map((r) => `${r.className.replace('lr-row ', '')}: ${r.textContent}`);
const heads = (card: HTMLElement) => [...card.querySelectorAll('.lr-head')].map((h) => h.textContent);

describe('FR-7.8 Why this layer? (pure parts)', () => {
  it('FR-7.8 the tooltip line of a class without a layer: "no rule applies", or the reason itself', () => {
    expect(layerReasonLine(undefined, none)).toBe('No layer — no rule applies');
    expect(layerReasonLine(undefined, { ...none, notApplied: [], text: 'the `shared/lib` folder has no layer' })).toBe('No layer — the shared/lib folder has no layer');
  });

  it('FR-7.9 a class with stereotypes and no layer reason: the menu entry asks only about the stereotypes', () => {
    expect(whyLabel({ stereotypeReasons: [{ stereotype: 'service', text: 'name ends in Service' }] })).toBe('Why these stereotypes?');
  });

  it('FR-7.8 the path: a dotted folder counts by its parts; a folder that is not in the path marks nothing', () => {
    const r: LayerReason = { rule: 'folder', text: 'x', strength: 'strong', notApplied: [], path: 'src/Shop.Infrastructure/Db/OrderRepo.cs', folders: ['Infrastructure', 'Missing'] };
    expect(marked(pathWithDecision(r)!)).toEqual(['Shop.Infrastructure']);
  });

  it('FR-7.8 an entry file is marked by its file name', () => {
    const r: LayerReason = { rule: 'entry-file', text: 'entry file', strength: 'strong', notApplied: [], path: 'src/main.ts' };
    expect(marked(pathWithDecision(r)!)).toEqual(['main.ts']);
  });
});

describe('FR-19.13 the Why this layer? card as Markdown, unusual cases', () => {
  it('FR-19.13 no layer, no path, a noted rule, no rule decided, no hint', () => {
    const md = layerReasonMarkdown({ classKey: 'a#A', className: 'A', layerReason: { ...none, notApplied: ['FSD preset: `shared/lib` has no layer', 'no folder'], noted: ['FSD preset: `shared/lib` has no layer'] } });
    expect(md.split('\n')).toEqual([
      '### Why `A` has no layer',
      '',
      '**Placed by:**',
      '- · FSD preset: `shared/lib` has no layer',
      '- ✗ no folder',
      '',
      '**What the code suggests:** no suggestion from the analysed code',
      '',
    ]);
  });

  it('FR-19.13 only stereotypes (no layer reason): a weak one says so; a hint without advice', () => {
    const md = layerReasonMarkdown({
      classKey: 'a#A', className: 'A', layer: 'Domain',
      layerHint: { suggested: 'Infrastructure', reasons: ['does I/O'] },
      stereotypeReasons: [{ stereotype: 'service', text: 'folder `Services/`', weak: true }],
    });
    expect(md.split('\n')).toEqual([
      '### Why `A` is in Domain',
      '',
      '**What the code suggests:** Infrastructure: does I/O',
      '',
      '**Stereotypes:**',
      '- «service» folder `Services/` — weak signal',
      '',
    ]);
  });

  it('FR-19.13 a class in a layer with nothing against it (and no violations in this diagram)', () => {
    expect(layerReasonMarkdown({ classKey: 'a#A', className: 'A', layer: 'Domain', layerReason: config, violations: [] }).split('\n').slice(-2)).toEqual(['**What the code suggests:** nothing against this layer in the analysed code', '']);
  });
});

describe('FR-7.8 the Why this layer? card, unusual cases', () => {
  it('FR-7.8 a class without a layer and without a reason: no colour, no rules section, no suggestion, Copy only', () => {
    const card = layerReasonCard({ classKey: 'lib:x#X', className: 'X', stereotypeReasons: [{ stereotype: 'static', text: 'called statically', weak: true }] }, {});
    expect(card.getAttribute('class')).toBe('callers-panel layer-reason-card');
    expect(card.querySelector('.callers-title')!.textContent).toBe('Why X has no layer');
    expect(heads(card)).toEqual(['What the code suggests', 'Stereotypes']);
    expect(rows(card)).toEqual(['lr-none: ·no suggestion from the analysed code', 'lr-stereo weak: «»«static» called statically — weak signal']);
    expect([...card.querySelectorAll('.lr-actions button')].map((b) => b.textContent)).toEqual(['Copy as Markdown']);
    expect(card.querySelector('.lr-note')!.textContent).toBe('Moving writes a rule to .seqcall.json.');
  });

  it('FR-7.8 your own rule decided: the card says to edit it', () => {
    const card = layerReasonCard({ classKey: 'app/Http/A.php#A', className: 'A', layer: 'Presentation', layerReason: config }, {});
    expect(card.getAttribute('class')).toBe('callers-panel layer-reason-card layer-1');
    expect(card.querySelector('.lr-layer')!.getAttribute('class')).toBe('lr-layer layer-1');
    expect(card.querySelector('.lr-note')!.textContent).toBe('Your rule decides: edit it in .seqcall.json.');
  });

  it('FR-19.13 Copy as Markdown says when the copy failed, then shows its label again', async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
    const card = layerReasonCard({ classKey: 'a#A', className: 'A', layerReason: none } as LayerReasonTarget, {});
    const copy = card.querySelector('[data-cmd="lr-copy"]') as HTMLElement;
    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe('Copy failed'));
    vi.advanceTimersByTime(FLASH_MS);
    expect(copy.textContent).toBe('Copy as Markdown');
    vi.useRealTimers();
  });
});
