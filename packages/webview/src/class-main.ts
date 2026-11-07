/** Webview entry for the class diagram view (bundled to dist/class.js). */
import type { ClassViewToHost, HostToClassView } from '@seqcall/protocol';
import { createHostBridge } from './bridge';
import { startClassView } from './class/view';

function boot(): void {
  const root = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
  startClassView(root, createHostBridge<HostToClassView, ClassViewToHost>());
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
