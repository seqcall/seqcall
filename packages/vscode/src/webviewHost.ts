import * as vscode from 'vscode';
import { renderHtml, webviewOptions } from './webviewHtml';

/**
 * Wraps a WebviewPanel: loads a webview bundle, queues outgoing messages until the view
 * sends `ready`, records everything sent (for tests) and forwards incoming messages.
 */
export class WebviewHost<TOut extends { type: string }, TIn extends { type: string }> implements vscode.Disposable {
  private ready = false;
  private queue: TOut[] = [];
  private readyWaiters: (() => void)[] = [];
  /** Last state message (render/empty/error/busy), re-sent if the view (re)announces `ready`. */
  private lastState: TOut | undefined;
  /** Every message the host intended to send, in order (test API). */
  readonly sent: TOut[] = [];
  /** How many messages were posted so far (`sent` keeps only the last 200; test API). */
  posted = 0;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  constructor(
    readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    script: string,
    private readonly onMessage: (msg: TIn) => void | Promise<void>,
    onDispose: () => void,
  ) {
    panel.webview.options = webviewOptions(extensionUri);
    panel.webview.html = renderHtml(panel.webview, extensionUri, script, panel.title);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: TIn) => this.receive(msg)),
      panel.onDidDispose(() => {
        this.disposed = true;
        this.disposables.forEach((d) => d.dispose());
        onDispose();
      }),
    );
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get lastPosted(): TOut | undefined {
    return this.sent[this.sent.length - 1];
  }

  post(msg: TOut, isState = isStateMessage(msg)): void {
    if (this.disposed) return;
    this.sent.push(msg);
    this.posted++;
    if (this.sent.length > 200) this.sent.splice(0, this.sent.length - 200);
    if (isState) {
      this.lastState = msg;
      // A newer state supersedes queued states.
      this.queue = this.queue.filter((m) => !isStateMessage(m));
    }
    if (this.ready) void this.panel.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  /**
   * FR-16.14 resolves once the view has said `ready` (at most `timeoutMs` later), so a message posted before a
   * long synchronous step (the first analysis of a project) is on screen during it.
   */
  whenReady(timeoutMs: number): Promise<void> {
    if (this.ready || this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      this.readyWaiters.push(resolve);
      setTimeout(resolve, timeoutMs);
    });
  }

  /** Feed a message as if it came from the view (also used by the test API). */
  async receive(msg: TIn): Promise<void> {
    if (msg.type === 'ready') {
      this.ready = true;
      const pending = this.queue;
      this.queue = [];
      if (pending.length === 0 && this.lastState) pending.push(this.lastState);
      for (const m of pending) void this.panel.webview.postMessage(m);
      this.readyWaiters.splice(0).forEach((r) => r());
    }
    await this.onMessage(msg);
  }

  dispose(): void {
    if (!this.disposed) this.panel.dispose();
  }
}

/** What the view shows in place of a diagram, or the diagram: a newer one replaces it. */
const isStateMessage = (m: { type: string }): boolean => m.type === 'render' || m.type === 'empty' || m.type === 'error' || m.type === 'busy';
