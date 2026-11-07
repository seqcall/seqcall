/**
 * FR-23.1 name matching of the find bar — the same rules as core's `nameMatches` (packages/core/src/search.ts,
 * which matches the collapsed calls; the webview does not depend on core): case-insensitive substring, or
 * camelCase / snake_case word starts in order (`fUs` → `findUser`); a dotted query matches `Class.method`.
 */
export function nameMatches(query: string, ...names: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return names.some((n) => !!n && (n.toLowerCase().includes(q) || (!q.includes('.') && q.length > 1 && humps(q, words(n)))));
}

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function humps(q: string, ws: string[], from = 0): boolean {
  if (!q) return true;
  for (let i = from; i < ws.length; i++) {
    for (let k = Math.min(q.length, ws[i].length); k > 0; k--) {
      if (ws[i].startsWith(q.slice(0, k)) && humps(q.slice(k), ws, i + 1)) return true;
    }
  }
  return false;
}
