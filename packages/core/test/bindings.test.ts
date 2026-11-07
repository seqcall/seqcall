import { describe, expect, it } from 'vitest';
import type { ContainerBinding } from '../src/adapter';
import { bindingLookup } from '../src/session/bindings';

const at = (line: number) => ({ file: '/p/Program.cs', start: { line, character: 0 }, end: { line, character: 1 } });
const b = (abstract: string, concrete: string, line: number, extra: Partial<ContainerBinding> = {}): ContainerBinding => ({ abstract, concrete, range: at(line), ...extra });

describe('FR-8.6 binding lookup', () => {
  it('FR-8.6 the last registration wins; a fallback (TryAdd) only fills a gap', () => {
    const l = bindingLookup([b('I', 'A', 1), b('I', 'B', 2), b('I', 'C', 3, { fallback: true }), b('J', 'D', 4, { fallback: true })]);
    expect(l.bound(undefined, 'I')).toEqual({ classKey: 'B', at: at(2), contextual: false });
    expect(l.bound(undefined, 'J')?.classKey).toBe('D');
  });

  it('FR-8.6 a contextual binding (Laravel when(A)->needs(I)) wins for its consumer only', () => {
    const l = bindingLookup([b('I', 'A', 1), b('I', 'B', 2, { consumer: 'X' })]);
    expect(l.bound('X', 'I')).toMatchObject({ classKey: 'B', contextual: true });
    expect(l.bound('Y', 'I')).toMatchObject({ classKey: 'A', contextual: false });
  });

  it('FR-8.6 several hosts: a registration counts for the hosts that run it; chosen only when every host agrees', () => {
    const list = [b('I', 'Retail', 1, { hosts: ['Shop'] }), b('I', 'Export', 2, { hosts: ['Export'] }), b('J', 'Shared', 3, { hosts: ['Shop', 'Export'] })];
    expect(bindingLookup(list, ['Shop']).bound(undefined, 'I')?.classKey).toBe('Retail');
    expect(bindingLookup(list, ['Export']).bound(undefined, 'I')?.classKey).toBe('Export');
    // shared code run by both: they disagree → no choice; they agree → chosen
    expect(bindingLookup(list, ['Export', 'Shop']).bound(undefined, 'I')).toBeUndefined();
    expect(bindingLookup(list, ['Export', 'Shop']).bound(undefined, 'J')?.classKey).toBe('Shared');
    // a host without a registration for it (another container, or none): no choice
    expect(bindingLookup(list, ['Shop', 'Batch']).bound(undefined, 'J')).toBeUndefined();
  });

  it('FR-8.6 keyed and conditional registrations are never chosen; listed for the hosts that run them', () => {
    const list = [b('I', 'Maps', 1, { key: '"maps"', keyKind: 'key', hosts: ['Api'] }), b('I', 'Live', 2, { key: 'live', keyKind: 'condition', hosts: ['Batch'] })];
    expect(bindingLookup(list).bound(undefined, 'I')).toBeUndefined();
    expect(bindingLookup(list, ['Api']).keyed('I')).toEqual([{ classKey: 'Maps', key: '"maps"', at: at(1), kind: 'key' }]);
    expect(bindingLookup(list, ['Api', 'Batch']).keyed('I')?.map((k) => k.kind)).toEqual(['key', 'condition']);
    expect(bindingLookup(list, ['Other']).keyed('I')).toBeUndefined();
    // an abstraction without keyed registrations; a keyed registration without a kind (the adapter did not say)
    expect(bindingLookup(list).keyed('J')).toBeUndefined();
    expect(bindingLookup([b('I', 'Plain', 3, { key: 'k' })]).keyed('I')).toStrictEqual([{ classKey: 'Plain', key: 'k', at: at(3) }]);
  });

  it('FR-8.6 a generic abstraction registered per type argument: the call\'s type arguments pick the registration', () => {
    const list = [b('N`1', 'Shipments', 1, { abstractArgs: ['S'] }), b('N`1', 'Refunds', 2, { abstractArgs: ['F'] }), b('R`1', 'Repo', 3)];
    const l = bindingLookup(list);
    expect(l.bound(undefined, 'N`1', ['S'])?.classKey).toBe('Shipments');
    expect(l.bound(undefined, 'N`1', ['F'])?.classKey).toBe('Refunds');
    // a generic method's own type arguments come first: the receiver type's are the last ones
    expect(l.bound(undefined, 'N`1', ['X', 'S'])?.classKey).toBe('Shipments');
    // not registered for that argument: no choice; an open generic registration serves every argument
    expect(l.bound(undefined, 'N`1', ['Other'])).toBeUndefined();
    expect(l.bound(undefined, 'R`1', ['S'])?.classKey).toBe('Repo');
    // without the arguments (a constructor parameter): the last registration, as before
    expect(l.bound(undefined, 'N`1')?.classKey).toBe('Refunds');
  });
});

describe('FR-6.7 objects the container makes once', () => {
  it('FR-6.7 one registration as a singleton / scoped service; transient, none known, two registrations or another host: undefined', () => {
    const list = [b('I', 'One', 1, { lifetime: 'singleton' }), b('J', 'Req', 2, { lifetime: 'scoped' }), b('K', 'New', 3, { lifetime: 'transient' }), b('L', 'Plain', 4), b('A', 'Two', 5, { lifetime: 'singleton' }), b('B', 'Two', 6, { lifetime: 'singleton' }), b('M', 'Elsewhere', 7, { lifetime: 'singleton', hosts: ['Batch'] })];
    const l = bindingLookup(list);
    expect(['One', 'Req', 'New', 'Plain', 'Two', 'Missing', 'Elsewhere'].map((k) => l.lifetime(k))).toEqual(['singleton', 'scoped', undefined, undefined, undefined, undefined, 'singleton']);
    // in the web host the batch host's registration does not run
    expect(bindingLookup(list, ['Web']).lifetime('Elsewhere')).toBeUndefined();
    expect(bindingLookup(list, ['Batch']).lifetime('Elsewhere')).toBe('singleton');
  });
});
