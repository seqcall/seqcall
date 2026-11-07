// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { EntryPoint, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { messageCard, startSequenceView } from '../src/sequence/view';
import { entryTagText, layoutSequence } from '../src/sequence/layout';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

const route = (label: string, verb: string): EntryPoint => ({ kind: 'http', label, verb, detail: 'route', method: cloneSequence().root });

describe('FR-16.3 entry point tag at the found message', () => {
  it('the found message shows the entry point as a pill before the method name; others are in the hover card', () => {
    const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
    const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
    const d = cloneSequence();
    d.entryPoints = [route('POST /orders', 'POST'), route('PUT /orders', 'PUT')];
    bridge.send({ type: 'render', diagram: d });
    const found = view.body.querySelector('[data-msg-id="root"]')!;
    const pill = found.querySelector('.entry-badge')!;
    expect(pill.textContent).toBe('POST /orders');
    expect(pill.getAttribute('data-entry')).toBe('http');
    // pill first, then the name
    const x = (sel: string) => Number(found.querySelector(sel)!.getAttribute('x'));
    expect(x('.entry-text')).toBeLessThan(x('.seg-name'));
    // only the found message
    expect(view.body.querySelectorAll('.entry-badge')).toHaveLength(1);
    const card = messageCard(d.messages[0], document, d).map((n) => n.textContent);
    expect(card).toEqual(expect.arrayContaining(['Entry point (2)', 'POST /orders · route', 'PUT /orders · route']));
  });

  it('kinds are prefixed and long labels shortened; the label reserves the pill width', () => {
    const m = cloneSequence().root;
    expect(entryTagText({ kind: 'cli', label: 'orders:expire', method: m })).toBe('CLI orders:expire');
    // a route as the entry-point list writes it (constraints dropped), so it is cut less often
    expect(entryTagText(route('GET /v{version:apiVersion}/Providers/{providerId:long}', 'GET'))).toBe('GET /v{version}/Providers/{providerId}');
    // FR-16.6 / FR-16.7 React pages and render roots
    expect(entryTagText({ kind: 'route', label: '/orders/:id', method: m })).toBe('ROUTE /orders/:id');
    expect(entryTagText({ kind: 'ui', label: '#cart-app', method: m })).toBe('UI #cart-app');
    expect(entryTagText({ kind: 'test', label: 'OrderServiceTest.it_rejects_unknown_users_with_a_long_name', method: m })).toMatch(/^TEST OrderServiceTest\.it_rejects_unknow.*…$/);
    const plain = cloneSequence();
    const tagged = cloneSequence();
    tagged.entryPoints = [route('POST /orders', 'POST')];
    const width = (d: typeof plain) => layoutSequence(d).messages.find((x) => x.message.kind === 'found')!.label.width;
    expect(width(tagged)).toBeGreaterThan(width(plain) + estimateTextWidth('POST /orders', 'marker'));
  });
});
