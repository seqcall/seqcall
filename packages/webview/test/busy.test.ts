// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { ClassViewToHost, HostToClassView, HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { startSequenceView } from '../src/sequence/view';
import { estimateTextWidth } from '../src/measure';
import { cloneSequence, mockClassDiagram } from '../dev/mock-data';
import { mount, testBridge } from './helpers';

/** FR-16.14 the host says a slow first load is running: a spinner with its text until the diagram (or why not) arrives. */
function sequence() {
  const bridge = testBridge<HostToSequenceView, SequenceViewToHost>();
  const view = startSequenceView(mount(), bridge, { measureText: estimateTextWidth });
  const placeholder = view.root.querySelector('.placeholder') as HTMLElement;
  return { bridge, view, placeholder };
}

function classes() {
  const bridge = testBridge<HostToClassView, ClassViewToHost>();
  const view = startClassView(mount(), bridge, { measureText: estimateTextWidth, engine: 'dagre' });
  return { bridge, view, placeholder: view.placeholder };
}

describe('FR-16.14 a spinner while the project is first analysed', () => {
  it('FR-16.14 sequence view: the spinner and text replace the empty screen; the render removes them; screen readers hear it', () => {
    const { bridge, placeholder } = sequence();
    expect(placeholder.getAttribute('role')).toBe('status');
    expect(placeholder.querySelector('.spinner')).toBeNull(); // the empty screen has none
    bridge.send({ type: 'busy', text: 'Analysing shop…' });
    expect(placeholder.hidden).toBe(false);
    expect(placeholder.classList.contains('busy')).toBe(true);
    expect(placeholder.querySelector('.spinner')!.getAttribute('aria-hidden')).toBe('true');
    expect(placeholder.textContent).toBe('Analysing shop…');
    bridge.send({ type: 'render', diagram: cloneSequence() });
    expect(placeholder.hidden).toBe(true);
    expect(placeholder.querySelector('.spinner')).toBeNull();
  });

  it('FR-16.14 sequence view: over the diagram before it; an error or empty answer replaces the spinner', () => {
    const { bridge, view, placeholder } = sequence();
    bridge.send({ type: 'render', diagram: cloneSequence() });
    bridge.send({ type: 'busy', text: 'Loading C# workspace Shop…' });
    expect(view.body.querySelector('svg')).not.toBeNull(); // still drawn under the overlay
    bridge.send({ type: 'error', message: 'sidecar not found' });
    expect(placeholder.classList.contains('error')).toBe(true);
    expect(placeholder.querySelector('.spinner')).toBeNull();
    bridge.send({ type: 'busy', text: 'Analysing shop…' });
    bridge.send({ type: 'empty', reason: 'No method found at the cursor.' });
    expect(placeholder.querySelector('.spinner')).toBeNull();
    expect(placeholder.classList.contains('busy')).toBe(false);
  });

  it('FR-16.14 class view: the spinner in place of the classes until the render; an empty answer has none', () => {
    const { bridge, view, placeholder } = classes();
    expect(placeholder.getAttribute('role')).toBe('status');
    bridge.send({ type: 'render', diagram: structuredClone(mockClassDiagram) });
    bridge.send({ type: 'busy', text: 'Analysing shop…' });
    expect(view.canvas.textContent).toBe('');
    expect(placeholder.hidden).toBe(false);
    expect(placeholder.classList.contains('busy')).toBe(true);
    expect(placeholder.querySelectorAll('.spinner')).toHaveLength(1);
    expect(placeholder.textContent).toBe('Analysing shop…');
    bridge.send({ type: 'busy', text: 'Analysing shop…' }); // again: still one spinner
    expect(placeholder.querySelectorAll('.spinner')).toHaveLength(1);
    bridge.send({ type: 'render', diagram: structuredClone(mockClassDiagram) });
    expect(placeholder.hidden).toBe(true);
    bridge.send({ type: 'busy', text: 'Analysing shop…' });
    bridge.send({ type: 'empty', reason: 'The sequence diagram is empty.' });
    expect(placeholder.querySelector('.spinner')).toBeNull();
    expect(placeholder.classList.contains('busy')).toBe(false);
    expect(placeholder.textContent).toBe('The sequence diagram is empty.');
  });

  it('FR-16.14 class view on the codebase map: a busy flow leaves the map alone; the map scan itself spins', () => {
    const { bridge, view, placeholder } = classes();
    view.enterApp('');
    expect(placeholder.querySelector('.spinner')).not.toBeNull(); // finding the entry points
    bridge.send({ type: 'appMap', state: 'running', total: 3 });
    expect(placeholder.querySelector('.spinner')).not.toBeNull();
    bridge.send({ type: 'busy', text: 'Analysing shop…' });
    expect(placeholder.textContent).toBe('Following every entry point… 0 / 3');
    bridge.send({ type: 'appMap', state: 'cancelled' });
    expect(placeholder.querySelector('.spinner')).toBeNull();
  });
});
