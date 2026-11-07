// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findingCard, guideCard, guideMarkdown, guideOf, violationCard } from '../src/finding-guide';
import { layerReasonCard, layerReasonMarkdown } from '../src/layer-reason';

const clipboard = () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async (t: string) => void writes.push(t)) } });
  return writes;
};
const settle = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => vi.restoreAllMocks());

describe('FR-19.13 cards as Markdown (for people or AI agents, not screenshots)', () => {
  it('FR-19.13 a guide card: title, the case, why / consequences / how to fix / when it is OK', () => {
    const md = guideMarkdown('⚠ Layer violation: A (Application) → B (Infrastructure)', guideOf('layer-violation'), 'Application → Infrastructure: an inner layer depends on an outer layer');
    const lines = md.split('\n');
    expect(lines[0]).toBe('### ⚠ Layer violation: A (Application) → B (Infrastructure)');
    expect(lines[2]).toBe('Application → Infrastructure: an inner layer depends on an outer layer');
    expect(md).toContain('**Why flagged:** ');
    expect(md).toContain('**Consequences:** ');
    expect(md).toMatch(/\*\*How to fix:\*\*\n- Dependency inversion/);
    expect(md).toContain("**When it's OK:** ");
  });

  it('FR-19.14 a finding card shows its concrete case (In this diagram) before the general text, also as Markdown', async () => {
    const writes = clipboard();
    const evidence = ['A: class in src/a.ts', 'A → B: run calls load (a.ts:5)'];
    const card = findingCard({ id: 'c', kind: 'dependency-cycle', title: 'Dependency cycle: A → B → A', evidence }, { show: () => undefined, ignore: () => undefined, close: () => undefined });
    const labels = [...card.querySelectorAll('.gc-label')].map((l) => l.textContent);
    expect(labels.slice(0, 2)).toEqual(['In this diagram', 'Why flagged']);
    expect([...card.querySelectorAll('.gc-evidence li')].map((l) => l.textContent)).toEqual(evidence);
    ([...card.querySelectorAll('.gc-btn')].find((b) => b.textContent === 'Copy as Markdown') as HTMLElement).click();
    await settle();
    expect(writes[0]).toContain('**In this diagram:**\n- A: class in src/a.ts\n- A → B: run calls load (a.ts:5)\n\n**Why flagged:**');
  });

  it('FR-19.13 Copy as Markdown on a violation card copies it and says so', async () => {
    const writes = clipboard();
    const actions = { show: () => undefined, move: () => undefined, adjustRule: () => undefined, close: () => undefined };
    const card = violationCard({ key: 'a', name: 'EditProductHandler', layer: 'Application' }, { key: 'b', name: 'productMapper', layer: 'Infrastructure' }, 'Application → Infrastructure: an inner layer depends on an outer layer', actions);
    const copy = [...card.querySelectorAll('.gc-btn')].find((b) => b.textContent === 'Copy as Markdown') as HTMLElement;
    copy.click();
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0].split('\n')[0]).toBe('### ⚠ Layer violation: EditProductHandler (Application) → productMapper (Infrastructure)');
    expect(copy.textContent).toBe('Copied ✓');
    // a card without actions has it too
    expect([...guideCard('t', guideOf('layer-violation')).querySelectorAll('.gc-btn')].map((b) => b.textContent)).toEqual(['Copy as Markdown']);
  });

  it('FR-19.13 Copy as Markdown says when the copy failed (no clipboard API, no copy command)', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    const card = guideCard('t', guideOf('god-class'));
    const copy = card.querySelector('.gc-btn') as HTMLElement;
    copy.click();
    await settle();
    expect(copy.textContent).toBe('Copy failed');
  });

  it('FR-12.16 a ⚑ hint without reasons still explains the violation as a possible misclassification', () => {
    const actions = { show: () => undefined, move: () => undefined, adjustRule: () => undefined, close: () => undefined };
    const card = violationCard({ key: 'a', name: 'Order', layer: 'Domain', suggested: 'Application' }, { key: 'b', name: 'Db', layer: 'Infrastructure' }, 'Domain → Infrastructure', actions);
    expect(card.querySelector('.gc-detail')!.textContent).toBe('Domain → Infrastructure ⚑ Order looks like Application: a misclassification would explain this violation.');
  });

  it('FR-19.13 the Why this layer? card as Markdown: file, rules checked (✗ / · / ✓), hint, stereotypes, violations', async () => {
    const t = {
      classKey: 'src/pages/products/model/products.hooks.ts#<module>',
      className: 'products.hooks',
      layer: 'Application',
      layerReason: { rule: 'preset' as const, text: 'Feature-Sliced Design preset: `src/**/model/**`', strength: 'strong' as const, notApplied: ['no layer rules in .seqcall.json'], path: 'src/pages/products/model/products.hooks.ts' },
      layerHint: { suggested: 'Infrastructure', reasons: ['does I/O: OpenapiQueryClient.useMutation'], advice: 'in FSD, backend calls belong in an `api/` segment', noMove: true as const },
      stereotypeReasons: [{ stereotype: 'module', text: 'a module (file-level functions), not a class' }],
      violations: ['depends on Presentation: x'],
    };
    expect(layerReasonMarkdown(t)).toBe([
      '### Why `products.hooks` is in Application',
      '',
      '**File:** `src/pages/products/model/products.hooks.ts`',
      '',
      '**Placed by:**',
      '- ✗ no layer rules in .seqcall.json',
      '- ✓ Feature-Sliced Design preset: `src/**/model/**` — a clear signal',
      '',
      '**What the code suggests:** Infrastructure: does I/O: OpenapiQueryClient.useMutation — in FSD, backend calls belong in an `api/` segment',
      '',
      '**Fix:** The fix is in the code: put the backend call in an `api/` segment.',
      '',
      '**Stereotypes:**',
      '- «module» a module (file-level functions), not a class',
      '',
      '**Dependency rule in this diagram:**',
      '- ⚠ depends on Presentation: x',
      '',
    ].join('\n'));
    const writes = clipboard();
    (layerReasonCard(t, {}).querySelector('[data-cmd="lr-copy"]') as HTMLElement).click();
    await settle();
    expect(writes).toEqual([layerReasonMarkdown(t)]);
  });
});
