import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePhp, type PNode } from '../src/php/ast';

// FR-18.1 php-parser 3.7 loops forever on some half-typed files (an unclosed `#[` attribute, a file ending right
// after `enum Name`). The editor parses in its own process, so a loop freezes it. Each case is parsed in a child
// process with a time limit first: a regression fails the test instead of hanging the test run.
let dir = '';
let bundle = '';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-guard-'));
  bundle = path.join(dir, 'ast.cjs');
  await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/php/ast.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The top-level node kinds of a parse in a child process; undefined when it did not end within 10 s. */
function kindsInChild(code: string): string[] | undefined {
  const script = `const { parsePhp } = require(${JSON.stringify(bundle)}); process.stdout.write(JSON.stringify(parsePhp(${JSON.stringify(code)}, 'x.php').children.map((c) => c.kind)));`;
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 10_000, encoding: 'utf8' });
  return r.status === 0 ? (JSON.parse(r.stdout) as string[]) : undefined;
}

const kinds = (code: string) => (parsePhp(code, 'x.php').children as PNode[]).map((c) => c.kind);

describe('FR-18.1 half-typed PHP that makes php-parser loop', () => {
  it.each([
    ['an attribute not closed before a function', '<?php\n#[Attribute\nfunction main() {}'],
    ['an attribute not closed, the text ending in a newline', '<?php\n#[Attribute\nfunction main() {}\n'],
    ['`interface #[` at the end', '<?php\ninterface #['],
    ['an attribute list not closed before a closure', '<?php\n$cb = #[MyAttr, MyOther static function () {};\n'],
    ['a file ending right after `enum Name`', '<?php\nclass Order {}\nenum Status'],
  ])('FR-18.1 %s is parsed (the editor does not freeze)', (_name, code) => {
    const inChild = kindsInChild(code);
    expect(inChild).toBeInstanceOf(Array);
    // safe to parse here now: the same answer
    expect(kinds(code)).toEqual(inChild);
  });

  it('FR-18.1 the code before an unclosed attribute is still read; a closed attribute is read as before', () => {
    expect(kindsInChild('<?php\nclass Order {}\n#[Attribute\nfunction main() {}\n')?.[0]).toBe('class');
    const f = parsePhp("<?php\n#[Route('/orders')]\nfunction orders() {}\n", 'x.php').children[0] as PNode;
    expect([f.kind, f.attrGroups[0].attrs[0].name, f.name.name]).toEqual(['function', 'Route', 'orders']);
  });
});
