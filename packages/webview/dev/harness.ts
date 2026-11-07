/** Shared dev-harness helpers: fake bridge that logs intents, theme simulation. */
import type { HostBridge } from '../src/bridge';

export interface FakeBridge<In, Out> extends HostBridge<In, Out> {
  /** Delivers a host → view message. */
  send(msg: In): void;
}

export function createFakeBridge<In, Out>(onIntent: (msg: Out, bridge: FakeBridge<In, Out>) => void): FakeBridge<In, Out> {
  const listeners = new Set<(msg: In) => void>();
  let state: unknown;
  const log = devLog();
  const bridge: FakeBridge<In, Out> = {
    post(msg) {
      console.log('[intent]', msg);
      log(JSON.stringify(msg));
      setTimeout(() => onIntent(msg, bridge), 0);
    },
    onMessage(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getState: <T>() => state as T | undefined,
    setState(s) {
      state = s;
    },
    send(msg) {
      for (const l of listeners) l(msg);
    },
  };
  return bridge;
}

function devLog(): (line: string) => void {
  const panel = document.createElement('div');
  panel.className = 'dev-log';
  panel.title = 'Intents sent to the host (click to clear)';
  panel.addEventListener('click', () => (panel.textContent = ''));
  document.body.appendChild(panel);
  return (line) => {
    const row = document.createElement('div');
    row.className = 'dev-log-row';
    row.textContent = line;
    panel.prepend(row);
  };
}

const DARK: Record<string, string> = {
  '--vscode-editor-foreground': '#cccccc',
  '--vscode-editor-background': '#1f1f1f',
  '--vscode-descriptionForeground': '#9d9d9d',
  '--vscode-editorWidget-background': '#252526',
  '--vscode-editorWidget-border': '#454545',
  '--vscode-textLink-foreground': '#4daafc',
  '--vscode-focusBorder': '#0078d4',
  '--vscode-menu-background': '#1f1f1f',
  '--vscode-menu-foreground': '#cccccc',
  '--vscode-menu-selectionBackground': '#0078d4',
  '--vscode-menu-selectionForeground': '#ffffff',
  '--vscode-editorGroupHeader-tabsBackground': '#181818',
  '--vscode-editorLineNumber-foreground': '#6e7681',
  '--vscode-editor-selectionHighlightBackground': '#264f7866',
};

const LIGHT: Record<string, string> = {
  '--vscode-editor-foreground': '#3b3b3b',
  '--vscode-editor-background': '#ffffff',
  '--vscode-descriptionForeground': '#717171',
  '--vscode-editorWidget-background': '#f8f8f8',
  '--vscode-editorWidget-border': '#c8c8c8',
  '--vscode-textLink-foreground': '#005fb8',
  '--vscode-focusBorder': '#005fb8',
  '--vscode-menu-background': '#ffffff',
  '--vscode-menu-foreground': '#3b3b3b',
  '--vscode-menu-selectionBackground': '#005fb8',
  '--vscode-menu-selectionForeground': '#ffffff',
  '--vscode-editorGroupHeader-tabsBackground': '#f8f8f8',
  '--vscode-editorLineNumber-foreground': '#6e7681',
  '--vscode-editor-selectionHighlightBackground': '#add6ff80',
};

/** Simulates VS Code theme variables; `t` key cycles none → light → dark. */
export function installThemeSwitcher(): void {
  const modes = ['system', 'light', 'dark'] as const;
  let i = 0;
  const apply = () => {
    const root = document.documentElement;
    for (const k of Object.keys(DARK)) root.style.removeProperty(k);
    const palette = modes[i] === 'light' ? LIGHT : modes[i] === 'dark' ? DARK : null;
    if (palette) for (const [k, v] of Object.entries(palette)) root.style.setProperty(k, v);
    document.body.className = palette ? `vscode-${modes[i]}` : '';
    console.log(`[harness] theme: ${modes[i]}  (press "t" to switch)`);
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 't' && !(e.target instanceof HTMLInputElement)) {
      i = (i + 1) % modes.length;
      apply();
    }
  });
  apply();
}
