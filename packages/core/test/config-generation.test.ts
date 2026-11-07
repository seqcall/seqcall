import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configGeneration, noteConfigChanged } from '../src/config-generation';

// FR-4.4 the counter per project root that tells the test-file matchers to re-read `.seqcall.json` (testFiles).
describe('config generation', () => {
  it('FR-4.4 a root named relative or absolute is the same root; each reload counts', () => {
    const abs = path.resolve('some-shop-root');
    expect(configGeneration(abs)).toBe(0);
    noteConfigChanged('some-shop-root');
    expect(configGeneration(abs)).toBe(1);
    noteConfigChanged(abs);
    expect([configGeneration(abs), configGeneration('some-shop-root')]).toEqual([2, 2]);
  });
});
