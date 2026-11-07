import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { classInCategory } from '../src/session/build';
import { newSession } from './helpers';

// FR-11.8 a category hidden in one step: every class named *X, every «stereotype» class.
const IMPORT = 'src/services/import-service.ts#ImportService.importAll';
const to = (d: SequenceDiagram | undefined) => [...new Set(d!.messages.filter((m) => m.kind !== 'found').map((m) => d!.participants.find((p) => p.id === m.to)!.className))].sort();

describe('FR-11.8 hiding a category', () => {
  it('Classes named *Repository: the calls to every repository go, counted; «static»: the static logger; both diagrams; Show all brings them back', async () => {
    const s = newSession();
    await s.openMethodByKey(IMPORT);
    const all = (await s.expandEverything())!;
    expect(to(all)).toEqual(expect.arrayContaining(['UserRepository', 'Logger']));
    const repos = all.messages.filter((m) => m.kind !== 'found' && /Repository$/.test(all.participants.find((p) => p.id === m.to)!.className)).length;
    const d = (await s.hide({ kind: 'classPattern', pattern: '*Repository' }))!;
    expect(to(d).some((n) => n.endsWith('Repository'))).toBe(false);
    expect(d.hiddenFilters.map((f) => [f.filter.id, f.hiddenCount])).toEqual([['classPattern:*Repository', repos]]);
    expect((await s.getClassDiagram())!.classes.some((c) => c.name.endsWith('Repository'))).toBe(false);
    const st = (await s.hide({ kind: 'stereotype', stereotype: 'static' }))!;
    expect(to(st)).not.toContain('Logger');
    expect((await s.getClassDiagram())!.classes.map((c) => c.name)).not.toContain('Logger');
    expect(st.hiddenFilters.map((f) => f.filter.id)).toEqual(['classPattern:*Repository', 'stereotype:static']);
    const back = (await s.unhideAll())!;
    expect(to(back)).toEqual(to(all));
  });

  it('as "don\'t expand" rules: the calls stay drawn, folded', async () => {
    const s = newSession();
    await s.openMethodByKey(IMPORT);
    const d = (await s.hide({ kind: 'classPattern', pattern: '*Repository', noExpand: true }))!;
    expect(d.hiddenFilters[0].filter.id).toBe('noExpand:classPattern:*Repository');
    const all = (await s.expandEverything())!;
    const repoCalls = all.messages.filter((m) => /Repository$/.test(all.participants.find((p) => p.id === m.to)!.className));
    expect(repoCalls.length).toBeGreaterThan(0);
    expect(repoCalls.every((m) => !m.expanded)).toBe(true);
    // they stay in the class diagram too
    expect((await s.getClassDiagram())!.classes.some((c) => c.name.endsWith('Repository'))).toBe(true);
  });

  it('classInCategory: the glob on the class name, the stereotype among its stereotypes; other rules are no category', () => {
    expect(classInCategory({ id: 'a', kind: 'classPattern', pattern: '*Mapper' }, 'OrderMapper', [])).toBe(true);
    expect(classInCategory({ id: 'a', kind: 'classPattern', pattern: '*Mapper' }, 'MapperFactory', [])).toBe(false);
    expect(classInCategory({ id: 'b', kind: 'stereotype', stereotype: 'static' }, 'Logger', ['static', 'util'])).toBe(true);
    expect(classInCategory({ id: 'b', kind: 'stereotype', stereotype: 'static' }, 'Logger', ['service'])).toBe(false);
    expect(classInCategory({ id: 'c', kind: 'class', classKey: 'k', className: 'Logger' }, 'Logger', ['static'])).toBe(false);
  });
});
