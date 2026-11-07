/**
 * Linear-time replacements for small regexes that backtrack quadratically on long input
 * (SonarQube S8786): each helper returns exactly what the regex in its doc comment returns.
 */

const isLineBreak = (c: number) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;

/** `s.replace(/<marker>.*$/, '')`: cut at the first marker after the last line break. */
export function cutFrom(s: string, marker: string): string {
  let lineStart = s.length;
  while (lineStart > 0 && !isLineBreak(s.charCodeAt(lineStart - 1))) lineStart--;
  const i = s.indexOf(marker, lineStart);
  return i < 0 ? s : s.slice(0, i);
}

/** `s.replace(/^c+|c+$/g, '')` for one character `c`. */
export function trimChar(s: string, c: string): string {
  let a = 0;
  while (a < s.length && s[a] === c) a++;
  return trimEndChar(s, c, a);
}

/** `s.replace(/[c]+$/, '')`: the characters of `c` trimmed from the end (one character, or a set like `'.\\'`). */
export function trimEndChar(s: string, c: string, from = 0): string {
  let b = s.length;
  while (b > from && c.includes(s[b - 1])) b--;
  return s.slice(from, b);
}

/**
 * `doc.replace(/^.*<\s*(?:[^,>]+,\s*)?([^>]+)>.*$/, '$1')`: the item type of a PHPDoc generic
 * (`array<int, Foo>` → Foo, `Collection<Foo>` → Foo), `doc` unchanged when it is none. The regex
 * tries each `<` from the right; here each try is O(1) with the next-`,`/`>`/non-space tables.
 */
export function genericArgument(doc: string): string {
  const n = doc.length;
  let firstBreak = n;
  let lastBreak = -1;
  for (let i = 0; i < n; i++) {
    if (!isLineBreak(doc.charCodeAt(i))) continue;
    if (firstBreak === n) firstBreak = i;
    lastBreak = i;
  }
  const nextGt = new Int32Array(n + 2).fill(n);
  const nextCommaOrGt = new Int32Array(n + 2).fill(n);
  const nextNonSpace = new Int32Array(n + 2).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    const ch = doc[i];
    nextGt[i] = ch === '>' ? i : nextGt[i + 1];
    nextCommaOrGt[i] = ch === '>' || ch === ',' ? i : nextCommaOrGt[i + 1];
    nextNonSpace[i] = /\s/.test(ch) ? nextNonSpace[i + 1] : i;
  }
  // `>.*$`: no line break after the closing `>`
  const closes = (g: number) => g < n && g > lastBreak;
  for (let lt = firstBreak - 1; lt >= 0; lt--) {
    if (doc[lt] !== '<') continue;
    const p = nextNonSpace[lt + 1];
    // `\s*` gives back at most one space: with fewer, the same `,` / `>` follow and the same try fails again
    for (let k = p; k >= Math.max(lt + 1, p - 1); k--) {
      const c = nextCommaOrGt[k];
      if (c > k && doc[c] === ',') {
        const g = nextGt[c + 1];
        const j = Math.min(nextNonSpace[c + 1], g - 1);
        if (closes(g) && j >= c + 1) return doc.slice(j, g);
      }
      const g = nextGt[k];
      if (g > k && closes(g)) return doc.slice(k, g);
    }
  }
  return doc;
}

/** `/\$?([A-Za-z_]\w*)$/.exec(t)?.[1] ?? ''`: the identifier the text ends with. */
export function trailingIdentifier(t: string): string {
  let i = t.length;
  while (i > 0 && /\w/.test(t[i - 1])) i--;
  const start = t.slice(i).search(/[A-Za-z_]/);
  return start < 0 ? '' : t.slice(i + start);
}
