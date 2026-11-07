import { describe, expect, it } from 'vitest';
import { cutFrom, genericArgument, trailingIdentifier, trimChar, trimEndChar } from '../src/text';

// Random strings over a small alphabet hit the edge cases (line breaks, empty runs, repeats).
function randomStrings(alphabet: string[], count = 20_000, maxLength = 12): string[] {
  let seed = 7;
  // Math.imul: a plain `seed * 1103515245` loses precision above 2^53, and the low bits of an LCG repeat with a short
  // period; both made the sequence collapse to a few dozen strings. The high bits pick the character.
  const next = (n: number) => Math.floor(((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x80000000) * n);
  return Array.from({ length: count }, () => Array.from({ length: next(maxLength + 1) }, () => alphabet[next(alphabet.length)]).join(''));
}

describe('linear-time text helpers (each returns what the regex it replaced returns)', () => {
  it('cutFrom = s.replace(/<marker>.*$/, "")', () => {
    for (const s of randomStrings(['<', 'a', ' ', '>', '\n', '\r', ' '])) expect(cutFrom(s, '<')).toBe(s.replace(/<.*$/, ''));
    for (const s of randomStrings(['#', '(', 'a', '\n'])) expect(cutFrom(s, '#')).toBe(s.replace(/#.*$/, ''));
  });

  it('trimChar = s.replace(/^c+|c+$/g, ""), trimEndChar = s.replace(/c+$/, "")', () => {
    for (const s of randomStrings(['/', 'a', '-', '\n'])) {
      expect(trimChar(s, '/')).toBe(s.replace(/^\/+|\/+$/g, ''));
      expect(trimChar(s, '-')).toBe(s.replace(/^-+|-+$/g, ''));
      expect(trimEndChar(s, '/')).toBe(s.replace(/\/+$/, ''));
    }
    for (const s of randomStrings(['.', '\\', 'a', '#', '\n'])) expect(trimEndChar(s, '.\\')).toBe(s.replace(/[.\\]+$/, ''));
  });

  it('genericArgument = the PHPDoc generic item regex', () => {
    expect(genericArgument('array<int, Foo>')).toBe('Foo');
    expect(genericArgument('Collection<Foo>')).toBe('Foo');
    for (const s of randomStrings(['<', '>', ',', ' ', '\t', '\n', 'a', 'b'], 50_000)) {
      expect(genericArgument(s)).toBe(s.replace(/^.*<\s*(?:[^,>]+,\s*)?([^>]+)>.*$/, '$1'));
    }
  });

  it('trailingIdentifier = /\\$?([A-Za-z_]\\w*)$/.exec(t)?.[1] ?? ""', () => {
    expect(trailingIdentifier('readonly $user')).toBe('user');
    for (const s of randomStrings(['a', 'Z', '_', '1', '$', ' ', '.', '\n'])) expect(trailingIdentifier(s)).toBe(/\$?([A-Za-z_]\w*)$/.exec(s)?.[1] ?? '');
  });

  it('stay fast on long input that made the regexes quadratic', () => {
    const long = (unit: string, tail: string) => unit.repeat(200_000) + tail;
    const started = performance.now();
    cutFrom(long('<', '\n!'), '<');
    trimChar(long('/', 'a'), '/');
    trimEndChar(long('a/', '!'), '/');
    trimEndChar(long('a.\\', '!'), '.\\');
    genericArgument(long('<', '\n!'));
    genericArgument(long('<a', '>\n>'));
    trailingIdentifier(long('a', '!'));
    // the regexes took minutes on these; the helpers well under a second
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
