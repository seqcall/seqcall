/**
 * Linear-time replacements for small regexes that backtrack quadratically on long input
 * (SonarQube S8786): each helper returns exactly what the regex in its doc comment returns.
 * (Same as packages/core/src/text.ts; the webview does not depend on core.)
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
  let b = s.length;
  while (b > a && s[b - 1] === c) b--;
  return s.slice(a, b);
}

/** `s.split(/\s*<sep>\s*\/)`: split at `sep`, whitespace around each separator dropped. */
export function splitTrimmed(s: string, sep: string): string[] {
  const parts = s.split(sep);
  return parts.map((p, i) => {
    if (i > 0) p = p.trimStart();
    if (i < parts.length - 1) p = p.trimEnd();
    return p;
  });
}
