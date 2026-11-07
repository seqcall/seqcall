import type { LayerHint } from '@seqcall/protocol';
import { svg, svgTitle } from './dom';
import { layerClass } from './layers';
import type { MenuItem } from './menu';

/** Text of the layer-hint tooltip. */
export function layerHintTitle(current: string | undefined, hint: LayerHint): string {
  return [
    `Suggested layer: ${hint.suggested} (placed in ${current ?? 'no layer'})`,
    ...hint.reasons.map((r) => `• ${r}`),
    ...(hint.advice ? [`→ ${hint.advice.replace(/`/g, '')}`] : []),
    hint.noMove ? 'Hint only — the file is where its convention puts it' : 'Hint only — set layers in .seqcall.json',
  ].join('\n');
}

/** Small ⚑ in the suggested layer's colour, top-right of a box, with the reasons as tooltip. */
export function layerHintBadge(current: string | undefined, hint: LayerHint, boxWidth: number): SVGGElement {
  const lc = layerClass(hint.suggested);
  return svg('g', { class: `layer-hint${lc ? ` ${lc}` : ''}`, 'data-layer-hint': hint.suggested }, [
    svg('text', { class: 'layer-hint-flag', x: boxWidth - 5, y: 12, 'text-anchor': 'end' }, ['⚑']),
    svgTitle(layerHintTitle(current, hint)),
  ]);
}

export interface LayerTarget {
  classKey: string;
  className: string;
  layer?: string;
  layerHint?: LayerHint;
}

/** Can this class be moved (project source, not a library or unresolved call)? */
export const isMovable = (t: { classKey: string }) => t.classKey.includes('#') && !t.classKey.startsWith('lib:');

/**
 * FR-7.5 menu entries: apply the suggested layer, or move to any layer. Each posts `setLayer`;
 * the host writes the rule to .seqcall.json.
 */
export function layerMenuItems(t: LayerTarget, choices: string[], post: (layer: string) => void): MenuItem[] {
  if (!isMovable(t)) return [];
  const items: MenuItem[] = [];
  if (t.layerHint && !t.layerHint.noMove) items.push({ id: 'apply-layer-hint', label: `Move to ${t.layerHint.suggested} layer (suggested)`, action: () => post(t.layerHint!.suggested) });
  const others = choices.filter((l) => l !== t.layer);
  if (others.length) items.push({ id: 'move-layer', label: 'Move to layer', submenu: others.map((l) => ({ id: `layer:${l}`, label: l, action: () => post(l) })) });
  return items;
}

/** Menu shown when the ⚑ itself is clicked: the reasons, then apply. */
export function layerHintMenu(t: LayerTarget, post: (layer: string) => void): MenuItem[] {
  const hint = t.layerHint!;
  return [
    { label: `Suggested layer: ${hint.suggested} (now ${t.layer ?? 'no layer'})`, disabled: true },
    ...hint.reasons.map((r) => ({ label: `• ${r}`, disabled: true })),
    ...(hint.advice ? [{ label: `→ ${hint.advice.replace(/`/g, '')}`, disabled: true }] : []),
    ...(hint.noMove ? [] : [
      { separator: true, label: '' },
      { id: 'apply-layer-hint', label: `Move ${t.className} to ${hint.suggested}`, disabled: !isMovable(t), action: () => post(hint.suggested) },
    ]),
  ];
}
