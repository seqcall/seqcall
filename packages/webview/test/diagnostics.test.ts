// @vitest-environment jsdom
import type { ViewLog } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { installDiagnostics } from '../src/diagnostics';

function sink() {
  const posted: ViewLog[] = [];
  return { posted, post: (m: ViewLog) => void posted.push(m) };
}

describe('view diagnostics (errors reach the host log, the view shows them)', () => {
  it('NFR-2 a failing message handler is logged with its stack and shown, not a blank panel', () => {
    const s = sink();
    const guard = installDiagnostics(s, 'sequence view');
    const shown: string[] = [];
    const err = new Error('no participants');
    err.stack = 'at render (view.ts:1)';
    expect(guard(() => { throw err; }, (m) => shown.push(m))).toBeUndefined();
    expect(shown).toEqual(['no participants']);
    expect(s.posted).toEqual([{ type: 'log', level: 'error', message: '[sequence view] no participants\nat render (view.ts:1)' }]);
  });

  it('NFR-2 an error without a stack, or a thrown string, is logged and shown as text', () => {
    const s = sink();
    const guard = installDiagnostics(s, 'class view');
    const shown: string[] = [];
    const noStack = new Error('bad layout');
    noStack.stack = undefined;
    guard(() => { throw noStack; }, (m) => shown.push(m));
    guard(() => { throw 'odd value'; }, (m) => shown.push(m));
    expect(shown).toEqual(['bad layout', 'odd value']);
    expect(s.posted.map((p) => p.message)).toEqual(['[class view] bad layout\n', '[class view] odd value']);
  });

  it('NFR-2 a handler that works returns its result and logs nothing', () => {
    const s = sink();
    expect(installDiagnostics(s, 'v')(() => 42, () => { throw new Error('not called'); })).toBe(42);
    expect(s.posted).toEqual([]);
  });

  it('NFR-2 uncaught errors and rejections of the page are logged; a script error without an Error object logs its message', () => {
    const s = sink();
    installDiagnostics(s, 'v');
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    const e = new Error('boom');
    e.stack = 'S';
    window.dispatchEvent(new ErrorEvent('error', { error: e, message: 'ignored' }));
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = 'lost promise';
    window.dispatchEvent(rejection);
    expect(s.posted.map((p) => p.message)).toEqual(['[v] Script error.', '[v] boom\nS', '[v] lost promise']);
  });
});
