/**
 * Layer colours, shared by the sequence and class views so a layer looks the same in both.
 * Well-known layers get fixed slots; other layer names hash into the remaining slots.
 * Colours come from CSS (`.layer-N { --lc: … }`), backed by VS Code's theme-aware chart colours.
 */
const KNOWN = ['presentation', 'application', 'ports', 'domain', 'infrastructure'];
const EXTRA_SLOTS = [6, 7];

export function layerSlot(layer: string | undefined): number | undefined {
  if (!layer) return undefined;
  const i = KNOWN.indexOf(layer.toLowerCase());
  if (i >= 0) return i + 1;
  let h = 0;
  for (const ch of layer) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA_SLOTS[h % EXTRA_SLOTS.length];
}

/** CSS class carrying the layer colour (`--lc`), or '' for classes without a layer. */
export function layerClass(layer: string | undefined): string {
  const slot = layerSlot(layer);
  return slot ? `layer-${slot}` : '';
}

/** Layers in architectural order (well-known first), then the others alphabetically. */
export function sortLayers(layers: Iterable<string>): string[] {
  const rank = (l: string) => {
    const i = KNOWN.indexOf(l.toLowerCase());
    return i >= 0 ? i : KNOWN.length;
  };
  return [...new Set(layers)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * FR-28.9 layers with something out: opened in place, or with objects / classes pulled out; FR-28.11 in the object view
 * also the open layers (bands / classes that can fold their layer).
 */
export function openLayerCount(items: readonly { inLayer?: { key: string }; fold?: { key: string }; layerFold?: { key: string } }[]): number {
  return new Set(items.flatMap((x) => [x.inLayer?.key, x.fold?.key, x.layerFold?.key].filter((k): k is string => !!k))).size;
}


/** FR-28.1 the objects of a layer lifeline, one row per class (in flow order): a class's only object by its own label. */
export interface LayerObjectRow {
  /** What `setLayerOpen` pulls out: the object's id, or the class key for all objects of the class. */
  pull: string;
  label: string;
  count: number;
  /** The objects' own labels (named ones say which they are: `error:PaymentError`). */
  labels: string[];
}

export function layerObjectRows(objects: readonly { id: string; label: string; classKey: string; className: string }[]): LayerObjectRow[] {
  const byClass = new Map<string, typeof objects[number][]>();
  for (const o of objects) byClass.set(o.classKey, [...(byClass.get(o.classKey) ?? []), o]);
  return [...byClass.values()].map((os) =>
    os.length === 1 ? { pull: os[0].id, label: os[0].label, count: 1, labels: [os[0].label] } : { pull: os[0].classKey, label: os[0].className, count: os.length, labels: os.map((o) => o.label) },
  );
}

/** One line per class for a tooltip: `Outcome<T> ×23`. */
export function layerObjectLines(objects: readonly { id: string; label: string; classKey: string; className: string }[]): string {
  return layerObjectRows(objects).map((r) => (r.count > 1 ? `${r.label} ×${r.count}` : r.label)).join('\n');
}
