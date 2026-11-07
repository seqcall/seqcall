import type { EntryOutcome, EntryPoint, EntryPointKind } from '@seqcall/protocol';
import { appMapEntryKey, displayRoute, entryOutcomeTags, entryPointMatches } from '@seqcall/core';

/** The icon of each kind, as in the sidebar's groups (codicons). */
const ICON: Record<EntryPointKind, string> = { http: 'globe', route: 'browser', ui: 'window', cli: 'terminal', job: 'clock', handler: 'mail', test: 'beaker' };

/** Rows shown at most (more: refine the search). */
export const SEARCH_MAX = 300;

export interface EntryPointSearchItem {
  label: string;
  description: string;
  entryPoint: EntryPoint;
}

/**
 * FR-16.9 *Go to Entry Point…*: the entry points matching the search (every word in the route / label,
 * `Class.method`, detail or project; FR-32.4 `has:db` the known outcome), in list order with tests last, at most SEARCH_MAX; the row says the
 * project and the method that handles it.
 */
export function entryPointSearch(list: EntryPoint[], query: string, outcomes: Record<string, EntryOutcome> = {}): { items: EntryPointSearchItem[]; total: number } {
  const hits = list.filter((e) => entryPointMatches(e, query, outcomes)).sort((a, b) => Number(a.kind === 'test') - Number(b.kind === 'test'));
  return {
    total: hits.length,
    items: hits.slice(0, SEARCH_MAX).map((e) => {
      const method = e.method.owner.kind === 'module' ? e.method.name : `${e.method.owner.name}.${e.method.name}`;
      return {
        label: `$(${ICON[e.kind]}) ${e.kind === 'http' ? displayRoute(e.label) : e.label}`, // as in the panel
        // FR-32.4 its flow's I/O once known; `has:http` finds them
        description: [e.project, method !== e.label ? method : e.detail, entryOutcomeTags(outcomes[appMapEntryKey(e)])].filter(Boolean).join(' · '),
        entryPoint: e,
      };
    }),
  };
}
