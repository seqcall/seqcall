import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { belowThresholds, coberturaSummary, findReports } from '../coverage-cs.mjs';

describe('C# coverage (scripts/coverage-cs.mjs)', () => {
  it('reads the line and branch summary from a Cobertura report', () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>\n<coverage line-rate="0.8512" branch-rate="0.7" version="1.9" timestamp="1" ' +
      'lines-covered="851" lines-valid="1000" branches-covered="70" branches-valid="100"><packages /></coverage>';
    expect(coberturaSummary(xml)).toEqual({
      lines: { rate: 0.8512, covered: 851, valid: 1000 },
      branches: { rate: 0.7, covered: 70, valid: 100 },
    });
    expect(() => coberturaSummary('<html />')).toThrow('not a Cobertura report');
    // the floor: 85.12 % lines, 70 % branches
    expect(belowThresholds(coberturaSummary(xml), { lines: 85, branches: 75 })).toEqual(['branches 70.00 % < 75 %']);
    expect(belowThresholds(coberturaSummary(xml), { lines: 85, branches: 70 })).toEqual([]);
  });

  it('finds the report of each run (one GUID folder per run), newest first', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-coverage-'));
    try {
      for (const [run, mtime] of [['run-old', 1_000], ['run-new', 2_000]] as const) {
        fs.mkdirSync(path.join(dir, run));
        const file = path.join(dir, run, 'coverage.cobertura.xml');
        fs.writeFileSync(file, '');
        fs.utimesSync(file, mtime, mtime);
      }
      fs.writeFileSync(path.join(dir, 'other.xml'), '');
      expect(findReports(dir, 'coverage.cobertura.xml')).toEqual([
        path.join(dir, 'run-new', 'coverage.cobertura.xml'),
        path.join(dir, 'run-old', 'coverage.cobertura.xml'),
      ]);
      expect(findReports(path.join(dir, 'missing'), 'coverage.cobertura.xml')).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
