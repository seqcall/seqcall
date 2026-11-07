import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallSite, FragmentScope } from '../src/adapter';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-18.4 / FR-1.10 / FR-1.15 / FR-1.17 / FR-19.1 combined fragments and early exits of PHP methods, on small
// projects written per test (also half-typed code).
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function method(body: string, params = '$a, $b, $items') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-frag-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  fs.mkdirSync(`${root}/src`);
  const src = `<?php
class Shop {
  public function run(${params}) {
${body}
  }
}
`;
  fs.writeFileSync(`${root}/src/Shop.php`, src);
  const a = new PhpAdapter(root);
  const m = (await a.getMethod('src/Shop.php#Shop.run'))!;
  return { a, m, src, root };
}

const scope = (f: FragmentScope) => `${f.kind}${f.operand !== undefined ? `#${f.operand}` : ''}${f.guard !== undefined ? ` ${f.guard}` : ''}${f.negatedGuard ? ` (${f.negatedGuard})` : ''}${f.leavesLoop ? ' leaves' : ''}`;
/** Each call (by name): its fragments, outermost first. */
async function scopes(body: string): Promise<string[]> {
  const { a, m } = await method(body);
  const cs: CallSite[] = await a.getOutgoingCalls(m);
  return cs.map((c) => `${c.methodName}: ${(c.fragments ?? []).map(scope).join(' / ')}`);
}

describe('FR-18.4 PHP fragments: switch and match', () => {
  it('switch: cases falling through share an operand; default is else; a single group without default is opt', async () => {
    expect(
      await scopes(`
    switch ($a) {
      case 1:
      case 2: one(); break;
      case 3: three();
      default: other();
    }
    switch (pick()) { case 'x': only(); }
    switch ($b) { case 1: first(); case 2: }
    switch ($b) { default: fallback(); }`),
    ).toEqual([
      'one: alt#0 $a = 1 | 2',
      'three: alt#1 $a = 3',
      'other: alt#2 else',
      'pick: ',
      "only: opt#0 pick() = 'x'",
      'first: alt#0 $b = 1',
      'fallback: alt#0 else',
    ]);
  });

  it('switch: the operand\'s range runs from the first case to its value (the default case: the case itself)', async () => {
    const { a, m, src } = await method(`
    switch ($a) {
      case 1: one();
      default: other();
    }`);
    const lines = src.split('\n');
    const cs = await a.getOutgoingCalls(m);
    const range = (name: string) => cs.find((c) => c.methodName === name)!.fragments![0].range;
    const line = lines.findIndex((l) => l.includes('case 1'));
    expect(range('one')).toMatchObject({ start: { line, character: lines[line].indexOf('case') }, end: { line, character: lines[line].indexOf('1:') + 1 } });
    const dline = lines.findIndex((l) => l.includes('default'));
    expect(range('other')).toMatchObject({ start: { line: dline, character: lines[dline].indexOf('default') } });
  });

  it('match: the operand\'s range spans its conditions', async () => {
    const { a, m, src } = await method(`
    $r = match ($a) {
      1, 2 => one(),
    };`);
    const lines = src.split('\n');
    const line = lines.findIndex((l) => l.includes('1, 2'));
    const cs = await a.getOutgoingCalls(m);
    expect(cs[0].fragments![0].range).toMatchObject({ start: { line, character: lines[line].indexOf('1') }, end: { line, character: lines[line].indexOf('2') + 1 } });
  });

  it('match: one operand per arm, default is else; calls in the conditions are outside the arms; a half-typed arm', async () => {
    expect(
      await scopes(`
    $r = match ($a) {
      1, 2 => one(),
      cond() => two(),
      default => other(),
    };
    $s = match ($b) { => half() };`),
    ).toEqual(['one: alt#0 $a = 1 | 2', 'cond: ', 'two: alt#1 $a = cond()', 'other: alt#2 else', 'half: alt#0 $b = ']);
  });
});

describe('FR-18.4 PHP fragments: loops', () => {
  it('for: the conditions are the guard (init and calls in the conditions are outside); for (;;) has none', async () => {
    expect(
      await scopes(`
    for ($i = start(); more($i), $i < 3; $i++) { body(); }
    for (;;) { forever(); }`),
    ).toEqual(['start: ', 'more: loop#0 more($i), $i < 3', 'body: loop#0 more($i), $i < 3', 'forever: loop#0']);
  });

  it('foreach with a key; the iterated expression is outside; while and do', async () => {
    expect(
      await scopes(`
    foreach (load() as $k => $v) { each_one(); }
    while (next_one()) { step(); }
    do { again(); } while ($a);`),
    ).toEqual(['load: ', 'each_one: loop#0 each $k => $v of load()', 'next_one: loop#0 next_one()', 'step: loop#0 next_one()', 'again: loop#0 $a']);
  });

  it('FR-19.1 a call leaves the loop when a return / throw follows it in its block (not after a continue / break); a loop body without braces never', async () => {
    expect(
      await scopes(`
    foreach ($items as $i) { found($i); return; }
    foreach ($items as $i) { skipped($i); continue; return; }
    foreach ($items as $i) { stopped($i); break; return; }
    foreach ($items as $i) bare($i);`),
    ).toEqual(['found: loop#0 each $i of $items leaves', 'skipped: loop#0 each $i of $items', 'stopped: loop#0 each $i of $items', 'bare: loop#0 each $i of $items']);
  });
});

describe('FR-18.4 PHP fragments: if, ?:, try', () => {
  it('a call in an elseif condition is in the operand of that branch; else negates a single condition', async () => {
    expect(
      await scopes(`
    if ($a) { one(); } elseif (check()) { two(); }
    if (!$a) { three(); } else { four(); }
    if ($a && $b) { five(); } else { six(); }
    if (ready()) { seven(); } else { eight(); }`),
    ).toEqual([
      'one: alt#0 $a',
      'check: alt#1 check()',
      'two: alt#1 check()',
      'three: alt#0 !$a',
      'four: alt#1 else ($a)',
      'five: alt#0 $a && $b',
      'six: alt#1 else (!($a && $b))',
      'ready: ',
      'seven: alt#0 ready()',
      'eight: alt#1 else (!ready())',
    ]);
  });

  it('finally always runs: no operand; FR-1.17 what each catch does (log calls on objects and functions, return, continue, closures not counted)', async () => {
    const { a, m } = await method(`
    foreach ($items as $i) {
      try { work(); }
      catch (A $e) { $this->logger->error('x'); return; }
      catch (B $e) { report($e); continue; }
      catch (C | D $e) { return 1; continue; }
      catch (E $e) { $f = function () { throw new X(); }; cleanup_files($e); }
      catch (F $e) { if ($a) { return; } return 2; }
      catch ($e) { }
      finally { cleanup(); }
    }`);
    const cs = await a.getOutgoingCalls(m);
    expect(cs.find((c) => c.methodName === 'cleanup')!.fragments!.map(scope)).toEqual(['loop#0 each $i of $items']);
    const handlers = cs.find((c) => c.methodName === 'work')!.fragments![1].handlers!;
    expect(handlers.map((h) => `${h.guard}: ${h.outcome}${h.value ? ` ${h.value}` : ''}${h.logged ? ' logged' : ''}`)).toEqual([
      'catch A: return logged',
      'catch B: skip logged',
      'catch C | D: return 1',
      'catch E: swallow',
      // the value of the first return that has one
      'catch F: return 2',
      // `catch ($e)` being typed: no type yet
      'catch: swallow',
    ]);
  });
});

describe('FR-1.15 PHP early exits', () => {
  it('FR-3.9 a return says what it returns, a bare return an empty text', async () => {
    const { a, m } = await method(`
    if ($a) { return; }
    if ($b) { return   Result::fail(  'no'  ); }
    work();`);
    expect((await a.getEarlyExits(m)).map((e) => e.value)).toEqual(['', "Result::fail( 'no' )"]);
  });

  it('a return in a switch case at the end of the method is its last statement (no early exit)', async () => {
    const { a, m } = await method(`
    switch ($a) {
      case 1: return one(); break;
      default: return other();
    }`);
    expect(await a.getEarlyExits(m)).toEqual([]);
  });

  it('a declare block is a list of statements: its last return ends the method, one before more code is early', async () => {
    const { a, m } = await method(`
    declare(ticks=1) {
      return one();
    }`);
    expect(await a.getEarlyExits(m)).toEqual([]);
    const early = await method(`
    declare(ticks=1) {
      if ($a) { return one(); }
      two();
    }`);
    expect((await early.a.getEarlyExits(early.m)).map((e) => e.kind)).toEqual(['return']);
  });

  it('a throw in parentheses is a statement too (the whole statement)', async () => {
    const { a, m, src } = await method(`
    if ($a) { (throw new \\App\\OrderFailed()); }
    after();`);
    const lines = src.split('\n');
    const line = lines.findIndex((l) => l.includes('(throw'));
    const exits = await a.getEarlyExits(m);
    expect(exits.map((e) => `${e.kind} ${e.exception}`)).toEqual(['throw OrderFailed']);
    // (php-parser starts the statement after the opening parenthesis; it ends with the `;`)
    expect(exits[0].range).toMatchObject({ start: { line, character: lines[line].indexOf('throw') }, end: { line, character: lines[line].indexOf(');') + 2 } });
  });

  it('a return in a loop is early even at the end of the method (the loop may go on)', async () => {
    const { a, m } = await method(`
    foreach ($items as $i) {
      return one($i);
    }`);
    expect((await a.getEarlyExits(m)).map((e) => e.kind)).toEqual(['return']);
  });

  it('a return in a switch case followed by more code is early', async () => {
    const { a, m } = await method(`
    switch ($a) {
      case 1: return one();
    }
    after();`);
    expect((await a.getEarlyExits(m)).map((e) => `${e.kind} ${(e.fragments ?? []).map(scope).join(' / ')}`)).toEqual(['return opt#0 $a = 1']);
  });

  it('throws: an if without braces, a variable, `new $class`, a half-typed throw; a return before more code (no fragment)', async () => {
    const { a, m } = await method(`
    if ($a) throw new \\App\\OrderFailed();
    if ($b) { throw $b; }
    if ($items) { throw new $a(); }
    if ($a > 1) { throw; }
    return 1;
    after();`);
    expect((await a.getEarlyExits(m)).map((e) => `${e.kind} ${e.exception ?? '-'} ${(e.fragments ?? []).map(scope).join(' / ')}`)).toEqual([
      'throw OrderFailed opt#0 $a',
      'throw $b opt#0 $b',
      'throw $a opt#0 $items',
      'throw - opt#0 $a > 1',
      'return - ',
    ]);
  });
});

describe('FR-18.4 PHP fragments in half-typed code', () => {
  it('`if (` without a condition yet: an opt without a guard, at the if', async () => {
    const { a, m, src } = await method(`
    if (
    echo found();`);
    const cs = await a.getOutgoingCalls(m);
    const line = src.split('\n').findIndex((l) => l.includes('if ('));
    expect(cs.map((c) => `${c.methodName}: ${(c.fragments ?? []).map(scope).join(' / ')}`)).toEqual(['found: opt#0 ']);
    expect(cs[0]!.fragments![0]!.range?.start).toEqual({ line, character: 4 });
  });
});
