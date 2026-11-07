import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { hitsIn, identifiers, RULES, rulesFor, wordRules } from '../leak-check.mjs';

const script = fileURLToPath(new URL('../leak-check.mjs', import.meta.url));
const kinds = (text: string, rules = RULES) => hitsIn(text, rules).map((h: { kind: string; match: string }) => `${h.kind}:${h.match}`);

describe('leak check (scripts/leak-check.mjs)', () => {
  it('flags a developer home folder, not placeholders or CI runners', () => {
    expect(kinds('see /home/alex/git/shop/src')).toEqual(['home path:/home/alex']);
    expect(kinds('open /Users/sam/Library')).toEqual(['home path:/Users/sam']);
    expect(kinds('C:\\Users\\kim\\AppData')).toEqual(['home path:C:\\Users\\kim']);
    expect(kinds('/home/<user>/.nvm and /home/runner/work and $HOME, /home/user/x')).toEqual([]);
    expect(kinds('see https://www.example.org/en/home/tables/a1.html')).toEqual([]);
  });

  it('keeps the e-mail addresses of third-party copyright lines in the generated notices, nothing else', () => {
    const text = 'Copyright (c) Jane Doe (jane.doe@shop-corp.eu) /home/jane/x';
    expect(kinds(text, rulesFor('seqcall-rider.zip!seqcall-rider/THIRD-PARTY-NOTICES.txt', RULES))).toEqual(['home path:/home/jane']);
    expect(kinds(text, rulesFor('docs/INSTALL.md', RULES))).toEqual(['home path:/home/jane', 'e-mail:jane.doe@shop-corp.eu']);
  });

  it('flags e-mail addresses outside the placeholder and bot domains', () => {
    expect(kinds('mail jane.doe@shop-corp.eu')).toEqual(['e-mail:jane.doe@shop-corp.eu']);
    expect(kinds('a@example.com b@test.example c@users.noreply.github.com Co-Authored-By: x <noreply@anthropic.com>')).toEqual([]);
  });

  it('takes the words from the config and LEAK_WORDS, case-insensitive, with allowed lines', () => {
    const rules = wordRules({ words: ['acmeshop', '\\bfoo\\b'], allow: ['acmeshop-free'] }, 'Bar\n\n');
    expect(kinds('AcmeShop and foo, not food; bar', rules)).toEqual(['word:AcmeShop', 'word:foo', 'word:bar']);
    expect(kinds('use acmeshop-free here', rules)).toEqual([]);
    expect(hitsIn('one\ntwo acmeshop', rules)[0]).toMatchObject({ line: 2, text: 'two acmeshop' });
    // a minified bundle is one line: allow looks at the text around the hit only
    expect(kinds(`acmeshop-free ${'x'.repeat(200)} acmeshop`, rules)).toEqual(['word:acmeshop']);
  });

  it('checks a commit message, without the comment lines git strips (the commit-msg hook)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'leak-msg-'));
    const msg = path.join(dir, 'COMMIT_EDITMSG');
    const run = () => spawnSync(process.execPath, [script, '--message', msg], { env: { ...process.env, LEAK_WORDS: 'acmeshop' }, encoding: 'utf8' });
    writeFileSync(msg, 'Coupons for the shop\n\n# acmeshop: a comment git strips\n');
    expect(run().status).toBe(0);
    writeFileSync(msg, 'Coupons as in AcmeShop\n');
    const hit = run();
    expect(hit.status).toBe(1);
    expect(hit.stdout).toContain('commit message:1  [word] AcmeShop');
  });

  it('compares compound names only, not plain words, short names or hashes', () => {
    expect([...identifiers('class OrderService { findById() } const TYPE_REFUND = 1; order items sha512-Ab3dE9fGh2kLmN0pQ')]).toEqual([
      'OrderService',
      'findById',
      'TYPE_REFUND',
    ]);
  });
});
