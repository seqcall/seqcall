import type { ViewLog } from '@seqcall/protocol';

interface LogSink {
  post(msg: ViewLog): void;
}

const text = (e: unknown): string => (e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e));

/**
 * Reports uncaught errors of the view to the host (the webview's own console is invisible
 * to users) and returns a wrapper that runs a message handler, reports failures and lets
 * the view show them instead of a blank panel.
 */
export function installDiagnostics(sink: LogSink, view: string): <T>(fn: () => T, onError: (message: string) => void) => T | undefined {
  const win = typeof window !== 'undefined' ? window : undefined;
  win?.addEventListener('error', (e) => sink.post({ type: 'log', level: 'error', message: `[${view}] ${text(e.error ?? e.message)}` }));
  win?.addEventListener('unhandledrejection', (e) => sink.post({ type: 'log', level: 'error', message: `[${view}] ${text(e.reason)}` }));
  return (fn, onError) => {
    try {
      return fn();
    } catch (e) {
      sink.post({ type: 'log', level: 'error', message: `[${view}] ${text(e)}` });
      onError(e instanceof Error ? e.message : String(e));
      return undefined;
    }
  };
}
