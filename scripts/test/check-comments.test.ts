import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { breaks, checkedFile, commentOf, hitsInDiff, hitsInFile, report } from '../check-comments.mjs';

describe('comment rule check (scripts/check-comments.mjs)', () => {
  it('checks the code of packages and scripts, not tests, fixtures or other files', () => {
    expect(checkedFile('packages/core/src/session.ts')).toBe(true);
    expect(checkedFile('packages/csharp/src/Seqcall.CSharp/Analysis/EntryPoints.cs')).toBe(true);
    expect(checkedFile('packages/vim/lua/seqcall/init.lua')).toBe(true);
    expect(checkedFile('scripts/sonar.mjs')).toBe(true);
    expect(checkedFile('packages/core/test/session.test.ts')).toBe(false);
    expect(checkedFile('scripts/test/sonar.test.ts')).toBe(false);
    expect(checkedFile('packages/csharp/tests/Seqcall.CSharp.Tests/X.cs')).toBe(false);
    expect(checkedFile('fixtures/sample-app/src/main.ts')).toBe(false);
    expect(checkedFile('packages/core/src/types.d.ts')).toBe(false);
    expect(checkedFile('docs/STATUS.md')).toBe(false);
  });

  it('finds the comment of a line: line and block comments, a trailing //, Lua and Vim script', () => {
    expect(commentOf('  // why', 'a.ts')).toBe(' why');
    expect(commentOf('  /** why */', 'a.ts')).toBe(' why */');
    expect(commentOf('   * why', 'a.ts')).toBe(' why');
    expect(commentOf('  /// <summary>why', 'a.cs')).toBe(' <summary>why');
    expect(commentOf('x = 1; // why', 'a.ts')).toBe('why');
    expect(commentOf("const u = 'http://host/x';", 'a.ts')).toBeUndefined();
    expect(commentOf('a * b', 'a.ts')).toBeUndefined();
    expect(commentOf('  */', 'a.ts')).toBeUndefined();
    expect(commentOf('-- why', 'a.lua')).toBe(' why');
    expect(commentOf('local x = 1', 'a.lua')).toBeUndefined();
    expect(commentOf('# why', 'a.vim')).toBe(' why');
    expect(commentOf('" why', 'a.vim')).toBe(' why');
    expect(commentOf('let x = 1', 'a.vim')).toBeUndefined();
  });

  it('flags history: what the code did before', () => {
    expect(breaks('so the class view no longer shows marks')).toEqual(['history']);
    expect(breaks('it used to draw every call')).toEqual(['history']);
    expect(breaks('the cache was removed')).toEqual(['history']);
    expect(breaks('formerly a map')).toEqual(['history']);
    expect(breaks('before this change the list was sorted')).toEqual(['history']);
    // contracts and plain meanings of the words
    expect(breaks('undefined when the method no longer exists')).toEqual([]);
    expect(breaks('after every previously started operation')).toEqual([]);
    expect(breaks('the key used to look the class up')).toEqual([]);
  });

  it('flags dates, but not a spec named by its date or a date in an example', () => {
    expect(breaks('calm defaults (review 2026-10-16)')).toEqual(['date']);
    expect(breaks('MCP 2025-06-18 dropped batches')).toEqual([]);
    expect(breaks('where it came from (`sample-app · c9cbbc2 · 2026-10-10`)')).toEqual([]);
    expect(breaks('formats "2025-01-15"')).toEqual([]);
  });

  it('flags numbers measured on a run, not the constants the code sets', () => {
    expect(breaks('(design-issue scan of a large Laravel app: 14 s of 138 s)')).toEqual(['measurement']);
    expect(breaks('would cost seconds (a large Laravel app: 1.8 s)')).toEqual(['measurement']);
    expect(breaks('walking them made a scan quadratic (large Laravel app:')).toEqual(['measurement']);
    expect(breaks('defaults measured on three projects: 0 / 0 / 4')).toEqual(['measurement']);
    expect(breaks('on a backend 57 % of the queries were repeats')).toEqual(['measurement']);
    expect(breaks('300 ms after typing, the host searches')).toEqual([]);
    expect(breaks('up to 4 levels / 200 methods')).toEqual([]);
  });

  it('lists the hits of a file with line numbers', () => {
    const src = ['// fine: why it is so', 'const a = 1; // it used to be 2', ' * review 2026-10-14'].join('\n');
    expect(hitsInFile('packages/core/src/a.ts', src)).toEqual([
      { file: 'packages/core/src/a.ts', line: 2, kind: 'history', text: 'const a = 1; // it used to be 2' },
      { file: 'packages/core/src/a.ts', line: 3, kind: 'date', text: '* review 2026-10-14' },
    ]);
  });

  it('checks only the lines a diff adds, in checked files, with their new line numbers', () => {
    const diff = [
      'diff --git a/packages/core/src/a.ts b/packages/core/src/a.ts',
      '--- a/packages/core/src/a.ts',
      '+++ b/packages/core/src/a.ts',
      '@@ -10,2 +10,3 @@ class A {',
      '-  // it used to draw all',
      '+  // fine',
      ' unchanged',
      '+  // no longer draws all (2026-10-31)',
      'diff --git a/packages/core/test/a.test.ts b/packages/core/test/a.test.ts',
      '+++ b/packages/core/test/a.test.ts',
      '@@ -0,0 +1 @@',
      '+// no longer draws all',
      'diff --git a/gone.ts b/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
    ].join('\n');
    const hits = hitsInDiff(diff);
    expect(hits.map((h: { line: number; kind: string }) => [h.line, h.kind])).toEqual([[12, 'history'], [12, 'date']]);
    expect(report(hits)).toBe('packages/core/src/a.ts:12  [history]  // no longer draws all (2026-10-31)\npackages/core/src/a.ts:12  [date]  // no longer draws all (2026-10-31)');
  });
});
