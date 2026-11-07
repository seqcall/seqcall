/**
 * FR-7.12 "Move to layer" with a scope: after choosing the layer, a card asks what the rule covers — this file,
 * its folder (or a folder above it), or every class named like it — with the number of files each covers
 * (counted by the host). The rule is written to .seqcall.json by the host (Undo offered there).
 */
import type { LayerScope } from '@seqcall/protocol';
import { html } from './dom';
import { layerClass } from './layers';
import type { PopupLayer } from './menu';

export interface ScopeTarget {
  classKey: string;
  className: string;
}

/** What a scope covers, in words. */
function scopeLabel(s: LayerScope): (string | HTMLElement)[] {
  const code = (t: string) => html('span', { class: 'code' }, [t]);
  if (s.kind === 'file') return ['this file ', code(s.glob.slice(s.glob.lastIndexOf('/') + 1))];
  if (s.kind === 'folder') return ['folder ', code(s.glob.replace(/\*\*$/, '')), html('span', { class: 'ls-count' }, [` — ${s.files} files`])];
  return ['every ', code(s.glob.replace(/^(.*\/)?\*\*\//, '')), html('span', { class: 'ls-count' }, [` — ${s.files} files`])];
}

export class LayerScopeChooser {
  private open: { target: ScopeTarget; layer: string; card: HTMLElement; list: HTMLElement; status: HTMLElement; scopes: LayerScope[] } | undefined;

  constructor(
    private readonly popups: PopupLayer,
    private readonly post: (msg: { type: 'requestLayerScopes'; classKey: string; className: string } | { type: 'setLayer'; classKey: string; className: string; layer: string; match?: string }) => void,
  ) {}

  /** Asks what the rule should cover; the host answers with the scopes (`onScopes`). */
  choose(target: ScopeTarget, layer: string, x: number, y: number): void {
    const lc = layerClass(layer);
    const list = html('div', { class: 'ls-list', role: 'radiogroup' });
    const status = html('div', { class: 'lr-note' }, ['Counting files…']);
    const move = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'ls-move' }, ['Move']);
    const cancel = html('button', { type: 'button', class: 'notice-btn', 'data-cmd': 'ls-cancel' }, ['Cancel']);
    const card = html('div', { class: `callers-panel layer-reason-card layer-scope-card${lc ? ` ${lc}` : ''}`, role: 'dialog', 'aria-label': `Move ${target.className} to ${layer}` }, [
      html('div', { class: 'callers-title' }, ['Move to ', html('span', { class: 'lr-layer' }, [layer]), ': what should the rule cover?']),
      list,
      status,
      html('div', { class: 'lr-actions' }, [move, cancel]),
      html('div', { class: 'lr-note' }, ['A rule in .seqcall.json (before your other rules).']),
    ]);
    move.addEventListener('click', () => {
      const picked = (list.querySelector('input:checked') as HTMLInputElement | null)?.value;
      const scope = this.open?.scopes.find((s) => s.glob === picked);
      this.popups.close();
      this.open = undefined;
      this.post({ type: 'setLayer', classKey: target.classKey, className: target.className, layer, ...(scope && scope.kind !== 'file' ? { match: scope.glob } : {}) });
    });
    cancel.addEventListener('click', () => {
      this.popups.close();
      this.open = undefined;
    });
    this.open = { target, layer, card, list, status, scopes: [] };
    // until the host answers: this file only (an old host never answers — the file is what it always moved)
    this.render([{ kind: 'file', glob: target.classKey.slice(0, target.classKey.indexOf('#')), files: 1 }]);
    this.popups.show(card, x, y);
    this.post({ type: 'requestLayerScopes', classKey: target.classKey, className: target.className });
  }

  /** The host's answer: the scopes with their file counts. */
  onScopes(classKey: string, scopes: LayerScope[]): void {
    if (!this.open || this.open.target.classKey !== classKey || !scopes.length) return;
    this.open.status.remove();
    this.render(scopes);
  }

  private render(scopes: LayerScope[]): void {
    const o = this.open!;
    o.scopes = scopes;
    // preselected: the class's own folder when it holds more than this file, else the file
    const folder = scopes.find((s) => s.kind === 'folder');
    const preselect = folder ?? scopes[0];
    o.list.replaceChildren(
      ...scopes.map((s) => {
        const input = html('input', { type: 'radio', name: 'layer-scope', value: s.glob }) as HTMLInputElement;
        input.checked = s === preselect;
        return html('label', { class: 'ls-row', title: s.glob }, [input, html('span', {}, scopeLabel(s))]);
      }),
    );
  }
}
