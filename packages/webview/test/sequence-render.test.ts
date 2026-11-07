// @vitest-environment jsdom
import type { SequenceDiagram } from '@seqcall/protocol';
import { describe, expect, it } from 'vitest';
import { layoutSequence } from '../src/sequence/layout';
import { renderBody, renderHeader, rootDeclarationRange } from '../src/sequence/render';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, range } from '../dev/mock-data';

const P = 'root/1:placeOrder';
const draw = (d: SequenceDiagram) => {
  const g = layoutSequence(d, {}, {}, estimateTextWidth);
  return { header: renderHeader(g), body: renderBody(g) };
};
const headTip = (svg: SVGSVGElement, id: string) => svg.querySelector(`[data-participant-id="${id}"] > title`)!.textContent!;

describe('sequence rendering: participants', () => {
  it('FR-5.6 / FR-5.10 objects on one lifeline say why: mutually exclusive creations, or interchangeable instances', () => {
    const d = cloneSequence();
    d.participants.find((p) => p.id === 'p-svc')!.alternatives = 2;
    d.participants.find((p) => p.id === 'p-repo1')!.instances = 3;
    const { header } = draw(d);
    expect(headTip(header, 'p-svc')).toContain('\none of 2 objects created in mutually exclusive places (each returned, or in different branches): only one exists in a run');
    expect(headTip(header, 'p-repo1')).toContain('\n3 objects created in the drawn calls, shown as one:');
  });

  it('FR-6.2 a long name:Class label is drawn on two lines, the name first', () => {
    const d = cloneSequence();
    d.participants.find((p) => p.id === 'p-notify')!.label = 'notifier:NotificationService';
    const { header } = draw(d);
    const texts = [...header.querySelectorAll('[data-participant-id="p-notify"] .p-label')].map((t) => t.textContent);
    expect(texts).toEqual(['notifier', ':NotificationService']);
    expect([...header.querySelectorAll('[data-participant-id="p-svc"] .p-label')].map((t) => t.textContent)).toEqual([':OrderService']);
  });

  it('«module» is no line on the box (the label says it), the tooltip lists every stereotype the line leaves out', () => {
    const d = cloneSequence();
    const fn = d.participants.find((p) => p.id === 'p-svc')!;
    fn.stereotypes = ['module'];
    fn.stereotypeReasons = undefined;
    const both = d.participants.find((p) => p.id === 'p-repo1')!;
    both.stereotypes = ['module', 'static'];
    both.stereotypeReasons = undefined;
    const { header } = draw(d);
    const line = (id: string) => header.querySelector(`[data-participant-id="${id}"] .p-stereo`)?.textContent;
    expect(line('p-svc')).toBeUndefined();
    expect(headTip(header, 'p-svc')).toContain('\n«module»');
    expect(line('p-repo1')).toBe('«static»');
    expect(headTip(header, 'p-repo1')).toContain('\n«module, static»');
  });
});

describe('sequence rendering: messages and frames', () => {
  it('FR-28.2 a call folding more calls than it names says how many more', () => {
    const d = cloneSequence();
    const m = d.messages.find((x) => x.id === P)!;
    m.folded = { count: 5, names: ['Repo.find', 'Repo.save'], expandable: 0 };
    const { body } = draw(d);
    expect(body.querySelector(`[data-msg-id="${P}"] .folded-badge title`)!.textContent).toBe('5 calls inside the layer, folded:\nRepo.find\nRepo.save\n+3 more');
  });

  it('FR-1.17 a try without a guard on its block; a catch that turns the error into a return value', () => {
    const d = cloneSequence();
    d.fragments = [{
      id: `${P}#try@1`, kind: 'try', ownerMessageId: P,
      operands: [{ firstMessageId: `${P}/0:findById`, lastMessageId: `${P}/0:findById` }],
      catches: [{ guard: 'catch (e)', outcome: '↩ null', swallowed: false }],
    }];
    const { body } = draw(d);
    const frame = body.querySelector('.fragments')!;
    expect(frame.querySelector('.frag-tag title')!.textContent).toBe('try / catch');
    const outcome = frame.querySelector('.frag-outcome')!;
    expect(outcome.getAttribute('class')).toBe('frag-outcome');
    expect(outcome.querySelector('title')!.textContent).toBe('The error becomes this return value: the caller sees no exception');
  });

  it('FR-2.5 the bar of a plain function (no class) names just the function', () => {
    const d = cloneSequence();
    const m = d.messages.find((x) => x.id === P)!;
    m.className = undefined;
    m.targetDeclaration = range('services/order-service.ts', 12, 2, 10);
    const { body } = draw(d);
    expect(body.querySelector(`[data-activation-for="${P}"] title`)!.textContent).toMatch(/^placeOrder — order-service\.ts:\d+ · click to go to the definition$/);
  });
});

describe('the root\'s declaration', () => {
  it('FR-2.2 the found message\'s call site, else the root method\'s declaration', () => {
    const d = cloneSequence();
    d.messages.find((m) => m.id === 'root')!.callSite = range('a.ts', 1);
    expect(rootDeclarationRange(d)).toEqual(range('a.ts', 1));
    expect(rootDeclarationRange({ ...d, messages: d.messages.filter((m) => m.id !== 'root') })).toEqual(d.root.declaration);
  });
});
