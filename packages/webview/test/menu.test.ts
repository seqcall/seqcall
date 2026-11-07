// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { PopupLayer, type MenuItem } from '../src/menu';
import { fire, mount } from './helpers';

const key = (k: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const focusedId = () => (document.activeElement as HTMLElement | null)?.dataset.menuId;

/** jsdom has no layout: give elements a size for the placement rules. */
function sized(w: number, h: number): () => void {
  const proto = HTMLElement.prototype;
  const ow = Object.getOwnPropertyDescriptor(proto, 'offsetWidth')!;
  const oh = Object.getOwnPropertyDescriptor(proto, 'offsetHeight')!;
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => w });
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get: () => h });
  return () => {
    Object.defineProperty(proto, 'offsetWidth', ow);
    Object.defineProperty(proto, 'offsetHeight', oh);
  };
}
let unsize = () => {};
/** Every layer listens on the document: close the ones of earlier tests so their menus do not take the keys. */
const layers: PopupLayer[] = [];
afterEach(() => {
  unsize();
  unsize = () => {};
  layers.splice(0).forEach((l) => l.close());
});

function setup(items: MenuItem[]) {
  const root = mount();
  const opener = document.createElement('button');
  root.appendChild(opener);
  opener.focus();
  const popups = new PopupLayer(root);
  layers.push(popups);
  const menu = popups.showMenu(items, 10, 10, 'k');
  return { root, popups, menu, opener };
}

const ran: string[] = [];
const act = (id: string): MenuItem => ({ id, label: id, action: () => ran.push(id) });

describe('FR-14.6 menus are keyboard operable', () => {
  it('FR-14.6 Home / End jump to the first / last row', () => {
    setup([act('a'), act('b'), act('c')]);
    key('End');
    expect(focusedId()).toBe('c');
    key('Home');
    expect(focusedId()).toBe('a');
  });

  it('FR-14.6 → opens a submenu at its first row, ← goes back to its row and closes it; on other rows they do nothing', () => {
    const s = setup([act('a'), { id: 'sub', label: 'More', submenu: [{ id: 'off', label: 'off', disabled: true }, act('s1')] }]);
    expect(key('ArrowRight')).toBe(true); // on a plain row: nothing (not prevented)
    expect(s.menu.querySelector('[data-menu-id="a"]')!.classList.contains('open')).toBe(false);
    expect(key('ArrowLeft')).toBe(true); // at the top level: nothing
    expect(focusedId()).toBe('a');
    key('ArrowDown');
    key('ArrowRight');
    expect(focusedId()).toBe('s1');
    const row = s.menu.querySelector('[data-menu-id="sub"]')!;
    expect(row.classList.contains('open')).toBe(true);
    key('ArrowLeft');
    expect(focusedId()).toBe('sub');
    expect(row.classList.contains('open')).toBe(false);
  });

  it('FR-14.6 Enter and Space choose; the focus returns to the button that opened the menu', () => {
    ran.length = 0;
    const s = setup([act('a'), act('b')]);
    key('Enter');
    expect(ran).toEqual(['a']);
    expect(document.activeElement).toBe(s.opener);
    s.popups.showMenu([act('a'), act('b')], 0, 0);
    key('ArrowDown');
    key(' ');
    expect(ran).toEqual(['a', 'b']);
  });

  it('FR-14.6 an action that moves the focus keeps it there', () => {
    const s = setup([]);
    const field = document.createElement('input');
    s.root.appendChild(field);
    s.popups.showMenu([{ id: 'go', label: 'go', action: () => field.focus() }], 0, 0);
    (s.root.querySelector('[data-menu-id="go"]') as HTMLElement).click();
    expect(document.activeElement).toBe(field);
  });

  it('FR-14.6 keys in a menu without enabled rows, or over a card (not a menu), do nothing', () => {
    const s = setup([{ id: 'x', label: 'nothing to do', disabled: true }]);
    expect(key('ArrowDown')).toBe(true); // not prevented
    const card = document.createElement('div');
    s.popups.show(card, 0, 0);
    expect(key('ArrowDown')).toBe(true);
    expect(s.popups.element).toBe(card);
  });
});

describe('menus and submenus', () => {
  it('FR-14.1 opening a submenu closes the other open one; a click inside a submenu on a disabled row leaves it as it is', () => {
    const s = setup([
      { id: 'one', label: 'One', submenu: [act('o1')] },
      { id: 'two', label: 'Two', submenu: [{ id: 'dis', label: 'dis', disabled: true }] },
    ]);
    const one = s.menu.querySelector('[data-menu-id="one"]')!;
    const two = s.menu.querySelector('[data-menu-id="two"]')!;
    fire(one.querySelector('.menu-label')!, 'click');
    expect(one.classList.contains('open')).toBe(true);
    two.dispatchEvent(new MouseEvent('mouseenter'));
    expect([one.classList.contains('open'), two.classList.contains('open')]).toEqual([false, true]);
    two.classList.remove('open');
    fire(two.querySelector('[data-menu-id="dis"]')!, 'click');
    expect(two.classList.contains('open')).toBe(false);
    fire(two, 'click');
    expect(two.classList.contains('open')).toBe(true);
  });

  it('FR-14.2 refresh rebuilds the open menu in place; without a focused row nothing gets focus', () => {
    const s = setup([act('a')]);
    (document.activeElement as HTMLElement).blur();
    expect(s.popups.refresh('k', [act('a'), { label: 'no id', action: () => {} }])).toBe(true);
    expect(s.root.querySelectorAll('.popup-layer .menu-item')).toHaveLength(2);
    expect(document.activeElement).toBe(document.body);
    expect(s.popups.refresh('other', [])).toBe(false);
  });
});

describe('popup placement', () => {
  it('FR-14.1 a menu that would leave the window on the right or the bottom moves in / opens above', () => {
    unsize = sized(200, 150);
    const s = setup([]);
    const el = s.popups.show(document.createElement('div'), window.innerWidth - 50, window.innerHeight - 20);
    expect(el.style.left).toBe(`${window.innerWidth - 204}px`);
    expect(el.style.top).toBe(`${window.innerHeight - 170}px`);
  });

  it('FR-19.10 a card in a corner moves in from the right edge, never above the point, and scrolls inside', () => {
    unsize = sized(200, 900);
    const s = setup([]);
    const el = s.popups.show(document.createElement('div'), window.innerWidth - 50, 100, { sticky: true });
    expect([el.style.left, el.style.top, el.style.maxHeight]).toEqual([`${window.innerWidth - 204}px`, '100px', `${window.innerHeight - 108}px`]);
  });

  it('FR-14.1 a submenu with no room on the right opens to the left of its row, and moves up when it would run off the bottom', () => {
    const s = setup([act('a'), { id: 'sub', label: 'More', submenu: [act('s1'), act('s2')] }]);
    const row = s.menu.querySelector('[data-menu-id="sub"]') as HTMLElement;
    const sub = row.querySelector('.submenu') as HTMLElement;
    const rect = (left: number, top: number) => () => ({ left, top, right: left + 150, bottom: top + 60, width: 150, height: 60, x: left, y: top, toJSON: () => ({}) });
    sub.getBoundingClientRect = rect(window.innerWidth - 100, window.innerHeight - 30);
    fire(row, 'mouseenter');
    expect(sub.classList.contains('flip')).toBe(true);
    expect(sub.style.top).toBe('-39px'); // up by the 30 px it overran plus the 4 px margin
    // room again (the menu was opened elsewhere): back to the right, at its row
    sub.getBoundingClientRect = rect(100, 100);
    fire(row, 'mouseenter');
    expect(sub.classList.contains('flip')).toBe(false);
    expect(sub.style.top).toBe('');
    // a submenu taller than the room above stays below the top edge
    sub.getBoundingClientRect = rect(100, 10);
    const tall = sub.getBoundingClientRect;
    sub.getBoundingClientRect = () => ({ ...tall(), bottom: window.innerHeight + 200, height: window.innerHeight + 190 });
    fire(row, 'mouseenter');
    expect(sub.style.top).toBe('-11px'); // up by its 10 px to the top edge, less the 4 px margin
  });

  it('FR-14.1 in a document without a window, popups stay at the given point', () => {
    unsize = sized(200, 150);
    const doc = document.implementation.createHTMLDocument();
    const popups = new PopupLayer(doc.body);
    const card = popups.show(doc.createElement('div'), 30, 40, { sticky: true });
    expect([card.style.left, card.style.top, card.style.maxHeight]).toEqual(['30px', '40px', '']);
    const menu = popups.show(doc.createElement('div'), 50, 60);
    expect([menu.style.left, menu.style.top]).toEqual(['50px', '60px']);
    // a submenu there opens to the right as usual
    const list = popups.showMenu([{ id: 'sub', label: 'More', submenu: [act('s1')] }], 50, 60);
    const row = list.querySelector('[data-menu-id="sub"]') as HTMLElement;
    row.dispatchEvent(new Event('mouseenter'));
    expect(row.querySelector('.submenu')!.classList.contains('flip')).toBe(false);
  });
});
