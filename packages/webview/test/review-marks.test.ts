// @vitest-environment jsdom
import type { ClassChange } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { changeTitle, memberTitle } from '../src/review-marks';

describe('review marks on classes (FR-24.11)', () => {
  it('FR-24.11 a changed class lists its members; fields and base types say what they are, methods do not', () => {
    const c: ClassChange = {
      kind: 'changed',
      members: [
        { kind: 'method', name: 'pay', change: 'changed', text: 'pay(): void' },
        { kind: 'field', name: 'mailer', change: 'added', text: 'mailer: Mailer' },
        { kind: 'declaration', name: 'Shop', change: 'changed', text: 'implements IShop' },
      ],
    };
    expect(changeTitle(c)).toBe('Changed on this branch:\n~ pay(): void\n+ mailer: Mailer (field)\n~ implements IShop (base types)\n(click: open it side by side)');
    // one of the three marked in the box: the other two are said to be unlisted; all listed: no note
    expect(changeTitle(c, 1)).toBe('Changed on this branch:\n~ pay(): void\n+ mailer: Mailer (field)\n~ implements IShop (base types)\n(2 of them not listed in the box: not used in the drawn calls)\n(click: open it side by side)');
    expect(changeTitle(c, 3)).not.toContain('not listed');
  });

  it('FR-24.11 a base-type change in a row tooltip, with its diff lines', () => {
    expect(memberTitle({ kind: 'declaration', name: 'Shop', change: 'changed', text: 'implements IShop', hunk: [{ kind: '-', text: 'class Shop' }, { kind: '+', text: 'class Shop implements IShop' }] })).toBe(
      '~ implements IShop — base types changed on this branch\n- class Shop\n+ class Shop implements IShop\n(click: open the change side by side)',
    );
  });
});
