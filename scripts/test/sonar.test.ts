import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { ceTaskUrl, describeIssue, gateSearches } from '../sonar.mjs';

describe('SonarQube Cloud release gate (scripts/sonar.mjs)', () => {
  it('fails on any open bug or vulnerability, and on any open issue of medium severity or higher', () => {
    const searches = gateSearches('org_seqcall');
    expect(searches).toEqual([
      expect.objectContaining({ componentKeys: 'org_seqcall', resolved: 'false', impactSoftwareQualities: 'RELIABILITY,SECURITY' }),
      expect.objectContaining({ componentKeys: 'org_seqcall', resolved: 'false', impactSeverities: 'MEDIUM,HIGH,BLOCKER' }),
    ]);
  });

  it('reads the analysis to wait for from a scanner report', () => {
    const report = 'organization=org\nprojectKey=org_seqcall\nceTaskUrl=https://sonarcloud.io/api/ce/task?id=AY1\nceTaskId=AY1\n';
    expect(ceTaskUrl(report)).toBe('https://sonarcloud.io/api/ce/task?id=AY1');
    expect(ceTaskUrl('projectKey=x\n')).toBeUndefined();
  });

  it('names each failing issue by rule, file:line and message', () => {
    expect(describeIssue({ rule: 'typescript:S1854', component: 'org_seqcall:packages/core/src/a.ts', line: 7, message: 'Remove this useless assignment' })).toBe(
      'typescript:S1854  packages/core/src/a.ts:7  Remove this useless assignment',
    );
    expect(describeIssue({ rule: 'csharpsquid:S1', component: 'org_seqcall-csharp:src/A.cs', message: 'm' })).toBe('csharpsquid:S1  src/A.cs  m');
  });
});
