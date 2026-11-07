import type { ViewLog } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { installDiagnostics } from '../src/diagnostics';

describe('view diagnostics without a window (node)', () => {
  it('NFR-2 still guards message handlers when there is no window to listen on', () => {
    const posted: ViewLog[] = [];
    const shown: string[] = [];
    const guard = installDiagnostics({ post: (m) => void posted.push(m) }, 'v');
    guard(() => { throw 'x'; }, (m) => shown.push(m));
    expect(shown).toEqual(['x']);
    expect(posted).toEqual([{ type: 'log', level: 'error', message: '[v] x' }]);
  });
});
