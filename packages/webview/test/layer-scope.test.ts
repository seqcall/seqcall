// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LayerScopeChooser } from '../src/layer-scope';
import { PopupLayer } from '../src/menu';
import { mount } from './helpers';

function setup() {
  const root = mount();
  const posted: unknown[] = [];
  const popups = new PopupLayer(root);
  const chooser = new LayerScopeChooser(popups, (m) => posted.push(m));
  const target = { classKey: 'app/Managers/OrderManager.php#OrderManager', className: 'OrderManager' };
  const card = () => root.querySelector('.popup-layer .layer-scope-card') as HTMLElement | null;
  const rows = () => [...root.querySelectorAll('.popup-layer .ls-row')].map((r) => `${(r.querySelector('input') as HTMLInputElement).checked ? '(x)' : '( )'} ${r.textContent}`);
  const click = (cmd: string) => (root.querySelector(`.popup-layer [data-cmd="${cmd}"]`) as HTMLElement).click();
  return { posted, chooser, target, card, rows, click };
}

const scopes = [
  { kind: 'file' as const, glob: 'app/Managers/OrderManager.php', files: 1 },
  { kind: 'folder' as const, glob: 'app/Managers/**', files: 7 },
  { kind: 'name' as const, glob: '**/*Manager.php', files: 12 },
];

describe('FR-7.12 Move to layer with a scope', () => {
  it('FR-7.12 asks the host for the scopes; until it answers, this file only', () => {
    const s = setup();
    s.chooser.choose(s.target, 'Domain', 10, 10);
    expect(s.posted).toEqual([{ type: 'requestLayerScopes', classKey: s.target.classKey, className: 'OrderManager' }]);
    expect(s.rows()).toEqual(['(x) this file OrderManager.php']);
    expect(s.card()!.getAttribute('class')).toContain('layer-4'); // the layer's colour
  });

  it('FR-7.12 the answer lists the scopes with counts, the folder preselected; Move posts its glob', () => {
    const s = setup();
    s.chooser.choose(s.target, 'Domain', 10, 10);
    s.chooser.onScopes(s.target.classKey, scopes);
    expect(s.rows()).toEqual(['( ) this file OrderManager.php', '(x) folder app/Managers/ — 7 files', '( ) every *Manager.php — 12 files']);
    s.click('ls-move');
    expect(s.posted.at(-1)).toEqual({ type: 'setLayer', classKey: s.target.classKey, className: 'OrderManager', layer: 'Domain', match: 'app/Managers/**' });
    expect(s.card()).toBeNull();
  });

  it('FR-7.12 answers for another class, an empty answer or after the card closed change nothing', () => {
    const s = setup();
    s.chooser.choose(s.target, 'Domain', 10, 10);
    s.chooser.onScopes('app/Other.php#Other', scopes);
    s.chooser.onScopes(s.target.classKey, []);
    expect(s.rows()).toEqual(['(x) this file OrderManager.php']);
    expect(s.card()!.textContent).toContain('Counting files…');
    s.click('ls-cancel');
    expect(s.card()).toBeNull();
    s.chooser.onScopes(s.target.classKey, scopes);
    expect(s.card()).toBeNull();
    expect(s.posted).toHaveLength(1); // only the request: Cancel moves nothing
  });

  it('FR-7.12 a layer without a colour slot (empty name) gets no colour class', () => {
    const s = setup();
    s.chooser.choose(s.target, '', 10, 10);
    expect(s.card()!.getAttribute('class')).toBe('callers-panel layer-reason-card layer-scope-card');
  });
});
