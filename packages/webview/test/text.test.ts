import { describe, expect, it } from 'vitest';
import { cutFrom, splitTrimmed, trimChar } from '../src/text';

function randomStrings(alphabet: string[], count = 20_000, maxLength = 12): string[] {
  let seed = 7;
  // Math.imul: a plain `seed * 1103515245` loses precision above 2^53, and the low bits of an LCG repeat with a short
  // period; both made the sequence collapse to a few dozen strings. The high bits pick the character.
  const next = (n: number) => Math.floor(((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x80000000) * n);
  return Array.from({ length: count }, () => Array.from({ length: next(maxLength + 1) }, () => alphabet[next(alphabet.length)]).join(''));
}

describe('linear-time text helpers (each returns what the regex it replaced returns)', () => {
  it('the random inputs are varied (else the comparisons below check almost nothing)', () => {
    expect(new Set(randomStrings([':', '<', 'a', '-', '\n', ' '])).size).toBeGreaterThan(10_000);
  });

  it('cutFrom = s.replace(/<marker>.*$/, ""), trimChar = s.replace(/^c+|c+$/g, "")', () => {
    for (const s of randomStrings([':', '<', 'a', '-', '\n', ' '])) {
      expect(cutFrom(s, ':')).toBe(s.replace(/:.*$/, ''));
      expect(trimChar(s, '-')).toBe(s.replace(/^-+|-+$/g, ''));
    }
  });

  it('splitTrimmed = s.split(/\\s*\\|\\s*/)', () => {
    expect(splitTrimmed(' A |  B| C ', '|')).toEqual([' A', 'B', 'C ']);
    for (const s of randomStrings(['|', ' ', '\t', '\n', 'a'])) expect(splitTrimmed(s, '|')).toEqual(s.split(/\s*\|\s*/));
  });

  it('stay fast on long input that made the regexes quadratic', () => {
    const started = performance.now();
    cutFrom(':'.repeat(200_000) + '\n!', ':');
    trimChar('a' + '-'.repeat(200_000) + '!', '-');
    splitTrimmed('a' + ' '.repeat(200_000) + '!', '|');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
