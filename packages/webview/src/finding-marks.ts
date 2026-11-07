/**
 * a design issue marked where its evidence is, in both diagrams (the same list, FR-19.17): its glyph after the
 * first evidence call in the sequence diagram — or on the participants when its evidence is classes only — and on its
 * classes in the class diagram. Hover = its title, a click opens its card (the views listen for `data-finding-id`).
 * Layer violations are not marked here: they are the red calls and relations already.
 */
import type { ClassRelation, Finding } from '@seqcall/protocol';
import { round, svg, svgTitle } from './dom';
import { FINDING_ICON } from './finding-guide';

/** The design issues of a list (without the layer violations). */
export const designIssues = (findings: readonly Finding[] | undefined): Finding[] => (findings ?? []).filter((f) => f.kind !== 'layer-violation');

/** The design issues whose evidence is classes only, on this class (a participant's or a class box's marks). */
export const classMarks = (findings: readonly Finding[] | undefined, classKey: string): Finding[] =>
  designIssues(findings).filter((f) => !f.messageIds?.length && f.classKeys?.includes(classKey));

/**
 * The class diagram's marks: each design issue on the classes it names, else (its evidence is a call, e.g. I/O in a
 * loop) on the class that sends its first relation's calls.
 */
export function classDiagramMarks(findings: readonly Finding[] | undefined, relations: readonly ClassRelation[]): Map<string, Finding[]> {
  const out = new Map<string, Finding[]>();
  for (const f of designIssues(findings)) {
    const from = relations.find((r) => r.id === f.relationIds?.[0])?.from;
    for (const key of f.classKeys?.length ? f.classKeys : from ? [from] : []) out.set(key, [...(out.get(key) ?? []), f]);
  }
  return out;
}

/** One issue's glyph at (x, y) (text baseline). */
export function findingMark(f: Finding, x: number, y: number): SVGElement {
  return svg('text', { class: `finding-mark kind-${f.kind}`, x: round(x), y: round(y), 'data-finding-id': f.id, role: 'button' }, [FINDING_ICON[f.kind], svgTitle(`${f.title} — click for why and how to fix`)]);
}
