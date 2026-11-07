// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { messageCard } from '../src/sequence/view';
import { cloneSequence } from '../dev/mock-data';

describe('FR-1.19 why a call is unknown', () => {
  it('FR-1.19 the hover card of an unresolved call says why', () => {
    const d = cloneSequence();
    const m = { ...d.messages[1], unresolved: '`zodSchema` is typed any, so what it calls cannot be known.' };
    const text = messageCard(m, document, d).map((n) => n.textContent).join('\n');
    expect(text).toContain('`zodSchema` is typed any');
    expect(messageCard(d.messages[1], document, d).some((n) => (n as HTMLElement).className?.includes('hc-unresolved'))).toBe(false);
  });
});
