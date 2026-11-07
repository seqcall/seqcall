// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { layerHintBadge, layerHintMenu, layerHintTitle } from '../src/layer-hint';

describe('layer hint ⚑ (FR-7.4)', () => {
  const hint = { suggested: 'Domain', reasons: ['no injected dependencies'] };

  it('FR-7.4 a class without a layer: the tooltip and the ⚑ menu say "no layer"', () => {
    expect(layerHintTitle(undefined, hint).split('\n')[0]).toBe('Suggested layer: Domain (placed in no layer)');
    expect(layerHintMenu({ classKey: 'src/a.ts#A', className: 'A', layerHint: hint }, () => {})[0].label).toBe('Suggested layer: Domain (now no layer)');
  });

  it('FR-7.4 the ⚑ takes the colour of the suggested layer; a layer without a name gets none', () => {
    expect(layerHintBadge('Application', hint, 120).getAttribute('class')).toBe('layer-hint layer-4');
    expect(layerHintBadge('Application', { suggested: '', reasons: [] }, 120).getAttribute('class')).toBe('layer-hint');
  });
});
