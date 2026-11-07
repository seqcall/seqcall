/** Dev harness for the class view. Keys: t = theme, e = empty, d = redraw. */
import type { ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { startClassView } from '../src/class/view';
import { createFakeBridge, installThemeSwitcher } from './harness';
import { mockClassDiagram } from './mock-data';

const bridge = createFakeBridge<HostToClassView, ClassViewToHost>((msg) => {
  if (msg.type === 'ready') bridge.send({ type: 'render', diagram: mockClassDiagram });
});

installThemeSwitcher();
startClassView(document.getElementById('app')!, bridge);
document.addEventListener('keydown', (e) => {
  if (e.key === 'e') bridge.send({ type: 'empty', reason: 'No sequence diagram open' });
  if (e.key === 'd') bridge.send({ type: 'render', diagram: mockClassDiagram });
});
