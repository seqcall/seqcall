// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { HostToSequenceView, SequenceDiagram, SequenceViewToHost } from '@seqcall/protocol';
import { messageCard, startSequenceView, type SequenceView } from '../src/sequence/view';
import { layoutSequence } from '../src/sequence/layout';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { fire, mount, testBridge, type TestBridge, viewOptionRow } from './helpers';

const P = 'root/1:placeOrder';
const FIND = `${P}/0:findById`;
let bridge: TestBridge<HostToSequenceView, SequenceViewToHost>;
let view: SequenceView;

const msgEl = (id: string) => [...view.body.querySelectorAll('[data-msg-id]')].find((e) => e.getAttribute('data-msg-id') === id)!;

/** The mock diagram with a DB read below findById and a repository that uses a database library. */
function withIo(): SequenceDiagram {
  const d = cloneSequence();
  d.messages.find((m) => m.id === FIND)!.sideEffects = { kinds: ['db'], evidence: ['DB: Pool.query'] };
  d.messages.find((m) => m.id === `${P}/1:findById`)!.sideEffects = { kinds: ['db', 'http'], evidence: ['DB: Pool.query (in Sql.read)', 'HTTP: fetch (in Cache.load)'], below: true };
  d.participants.find((p) => p.id === 'p-repo1')!.sideEffects = { kinds: ['db'], evidence: ['DB: uses pg'] };
  return d;
}

beforeEach(() => {
  bridge = testBridge();
  view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  bridge.send({ type: 'render', diagram: withIo() });
  bridge.posted.length = 0;
});

describe('sequence view: I/O badges (FR-17)', () => {
  it('FR-17.1 a message with I/O shows a pill with its kinds; I/O found only below is dashed', () => {
    const own = msgEl(FIND).querySelector('.io-badge')!;
    expect(own.textContent).toBe('DB');
    expect(own.classList.contains('below')).toBe(false);
    const below = msgEl(`${P}/1:findById`).querySelector('.io-badge')!;
    expect(below.textContent).toBe('DB·HTTP');
    expect(below.classList.contains('below')).toBe(true);
    expect(msgEl(P).querySelector('.io-badge')).toBeNull();
  });

  it('FR-17.1 the pill widens the label (layout reserves its width)', () => {
    const plain = cloneSequence();
    const width = (d: SequenceDiagram) => layoutSequence(d).messages.find((m) => m.message.id === FIND)!.label.width;
    expect(width(withIo())).toBeGreaterThan(width(plain) + estimateTextWidth('DB', 'tag'));
  });

  it('FR-17.1 the hover card lists the evidence', () => {
    const card = (id: string) => messageCard(withIo().messages.find((m) => m.id === id)!, document).map((n) => n.textContent);
    expect(card(FIND)).toEqual(expect.arrayContaining(['I/O', 'DB: Pool.query']));
    expect(card(`${P}/1:findById`)).toEqual(expect.arrayContaining(['I/O further down (already analysed calls)', 'HTTP: fetch (in Cache.load)']));
  });

  it('FR-17.2 a participant with I/O libraries shows the pill on its box, evidence as tooltip', () => {
    const box = view.header.querySelector('[data-participant-id="p-repo1"]')!;
    const pill = box.querySelector('.io-badge.participant-io')!;
    expect(pill.textContent).toContain('DB');
    expect(pill.querySelector('title')!.textContent).toBe('I/O in this file / type\nDB: uses pg');
    expect(view.header.querySelector('[data-participant-id="p-svc"] .io-badge')).toBeNull();
  });

  it('FR-17.4 the View ▾ "I/O badges" option posts the option (on by default)', () => {
    const button = viewOptionRow(view, 'showSideEffects');
    expect(button.getAttribute('aria-checked')).toBe('true');
    fire(button, 'click');
    expect(bridge.last()).toEqual({ type: 'setOption', option: 'showSideEffects', value: false });
  });
});
