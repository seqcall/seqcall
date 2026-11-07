import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhpAdapter } from '../src/php/php-adapter';
import { createTsAdapter } from '../src/ts/ts-adapter';

// FR-1.17 what a catch does with the error (shared by the TS and PHP adapters: catch-outcome.ts), on a small PHP
// project per test.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The catch handlers of the `try` around `work()` in `Shop::run`. */
async function handlers(catches: string): Promise<string[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-catch-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  fs.mkdirSync(`${root}/src`);
  fs.writeFileSync(`${root}/src/Shop.php`, `<?php\nclass Shop {\n  public function run() {\n    try { work(); }\n${catches}\n  }\n}\n`);
  const a = new PhpAdapter(root);
  const cs = await a.getOutgoingCalls((await a.getMethod('src/Shop.php#Shop.run'))!);
  const hs = cs.find((c) => c.methodName === 'work')!.fragments![0].handlers!;
  return hs.map((h) => `${h.guard}: ${h.outcome}${h.value !== undefined ? ` ${h.value}` : ''}${h.logged ? ' logged' : ''}`);
}

describe('FR-1.17 the outcome of a catch', () => {
  it('FR-1.17 a call on a logger object is logging whatever its method is called; a look-alike receiver is not', async () => {
    expect(
      await handlers(`
    catch (A $e) { $this->auditLogger->record($e); }
    catch (B $e) { $this->_logger->send($e); }
    catch (C $e) { $this->catalog->record($e); }
    catch (D $e) { record($e); }`),
    ).toEqual(['catch A: swallow logged', 'catch B: swallow logged', 'catch C: swallow', 'catch D: swallow']);
  });

  it('FR-1.17 the returned value is shown on one line, cut at 40 characters', async () => {
    expect(
      await handlers(`
    catch (A $e) { return [
        'status' => 'failed',
        'reason' => $e->getMessage(),
    ]; }
    catch (B $e) { return [ 'status' =>   'failed' ]; }`),
    ).toEqual([`catch A: return [ 'status' => 'failed', 'reason' => $e-…`, "catch B: return [ 'status' => 'failed' ]"]);
  });

  it('FR-1.17 TypeScript: a returned value over several lines is shown on one line', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-catch-ts-')).replace(/\\/g, '/');
    dirs.push(root);
    fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }));
    fs.mkdirSync(`${root}/src`);
    fs.writeFileSync(
      `${root}/src/shop.ts`,
      `export class Shop {
  work() {}
  run() {
    try { this.work(); }
    catch {
      return { status:
        'failed' };
    }
  }
}`,
    );
    const a = createTsAdapter(root);
    const cs = await a.getOutgoingCalls((await a.getMethod('src/shop.ts#Shop.run'))!);
    expect(cs.find((c) => c.methodName === 'work')!.fragments![0].handlers).toEqual([
      expect.objectContaining({ guard: 'catch', outcome: 'return', value: "{ status: 'failed' }" }),
    ]);
  });
});
