/** Webview entry for the sequence diagram view (bundled to dist/sequence.js). */
import type { HostToSequenceView, SequenceViewToHost } from '@seqcall/protocol';
import { createHostBridge } from './bridge';
import { startSequenceView } from './sequence/view';

function boot(): void {
  const root = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
  startSequenceView(root, createHostBridge<HostToSequenceView, SequenceViewToHost>());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
