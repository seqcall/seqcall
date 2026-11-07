// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HideFilter, HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startSequenceView } from '../src/sequence/view';
import { startClassView } from '../src/class/view';
import { describeHideFilter } from '../src/sequence/labels';
import { categoryMenu } from '../src/hide-category';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge } from './helpers';

// FR-11.8 "Hide every…": a category in one step, the same submenu in both views.

describe('FR-11.8 Hide every…', () => {
  it('the name\'s last word as a pattern and each stereotype that is a category; a one-word name has no pattern', () => {
    const posted: unknown[] = [];
    const rows = (name: string, st: string[]) => categoryMenu(name, st, (f) => posted.push(f))[0]?.submenu?.map((i) => i.label);
    expect(rows('OrderMapper', ['static', 'interface', 'mapper'])).toEqual(['Classes named *Mapper', 'Every «static» class', 'Every «mapper» class']);
    expect(rows('Logger', ['static'])).toEqual(['Every «static» class']);
    expect(categoryMenu('Logger', ['external'], () => {})).toEqual([]);
    categoryMenu('OrderMapper', ['static'], (f) => posted.push(f))[0].submenu!.forEach((i) => i.action!());
    expect(posted).toEqual([{ kind: 'classPattern', pattern: '*Mapper' }, { kind: 'stereotype', stereotype: 'static' }]);
  });

  it('the Filters list names the rules', () => {
    expect(describeHideFilter({ id: 'a', kind: 'classPattern', pattern: '*Mapper' } as HideFilter)).toBe('Classes named *Mapper');
    expect(describeHideFilter({ id: 'b', kind: 'stereotype', stereotype: 'static' } as HideFilter)).toBe('Every «static» class');
  });

  it('on an object of the sequence diagram and on a class of the class diagram', () => {
    const seq = testBridge<HostToSequenceView, SequenceViewToHost>();
    const v = startSequenceView(mount(), seq, { measureText: estimateTextWidth });
    seq.send({ type: 'render', diagram: cloneSequence() });
    fire(v.header.querySelector('[data-participant-id="p-repo1"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(v.root.querySelector('.popup-layer [data-menu-id="hide-category"]')!, 'click');
    fire(v.root.querySelector('.popup-layer [data-menu-id="hide-pattern"]')!, 'click');
    expect(seq.last()).toEqual({ type: 'hide', filter: { kind: 'classPattern', pattern: '*Repository' } });
    const cls = testBridge<HostToClassView, ClassViewToHost>();
    const c = startClassView(mount(), cls, { measureText: estimateTextWidth, engine: 'dagre' });
    cls.send({ type: 'render', diagram: { classes: [{ key: 'src/a.ts#Logger', name: 'Logger', kind: 'class', stereotypes: ['static'], namespace: '', methods: [] }], relations: [] } });
    fire(c.root.querySelector('[data-class-key="src/a.ts#Logger"]')!, 'contextmenu', { clientX: 10, clientY: 10 });
    fire(c.root.querySelector('.popup-layer [data-menu-id="hide-category"]')!, 'click');
    fire(c.root.querySelector('.popup-layer [data-menu-id="hide-stereotype:static"]')!, 'click');
    expect(cls.last()).toEqual({ type: 'hide', filter: { kind: 'stereotype', stereotype: 'static' } });
  });
});
