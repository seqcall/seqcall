/** Custom context menus and popovers (portable: no native editor menus). */
import { html } from './dom';

export interface MenuItem {
  label: string;
  /** Secondary text on the right (e.g. counts). */
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  action?: () => void;
  /** Stable id for tests / automation. */
  id?: string;
  /** A check box (`menuitemcheckbox`) or one of a set of choices (`menuitemradio`); `checked` is its state. */
  role?: 'checkbox' | 'radio';
  /** Clicking runs the action without closing the menu (options toggled in a row). */
  keepOpen?: boolean;
  /** Tooltip of the row. */
  title?: string;
}

/**
 * One floating layer per view. Opening a menu or popover closes the previous one.
 * Closes on outside mousedown, Escape, or window blur. Menus are keyboard operable: ↑/↓ move,
 * →/← open/leave a submenu, Enter/Space choose; closing returns focus to where it was.
 */
export class PopupLayer {
  private current: HTMLElement | null = null;
  /** Key of the open menu (`showMenu(…, key)`), so a view can refresh it in place. */
  private currentKey: string | undefined;
  /** The open popup survives scrolling / zooming the view (`closeOnViewChange`). */
  private sticky = false;
  /** Element focused before the popup opened (the button that opened it). */
  private opener: HTMLElement | null = null;
  /** Called once when the open popup goes, however it goes (✕, a click elsewhere, Escape, another popup). */
  private onClose: (() => void) | undefined;
  private readonly layer: HTMLElement;

  constructor(private readonly host: HTMLElement) {
    this.layer = html('div', { class: 'popup-layer' });
    host.appendChild(this.layer);
    const doc = host.ownerDocument;
    doc.addEventListener('mousedown', (e) => {
      if (this.current && !this.current.contains(e.target as Node)) this.close();
    });
    doc.addEventListener('keydown', (e) => {
      if (!this.current) return;
      if (e.key === 'Escape') {
        const opener = this.opener;
        this.close();
        opener?.focus();
      } else this.onMenuKey(e); // a card has no menu rows: the keys do nothing there
    });
    doc.defaultView?.addEventListener('blur', () => this.close());
  }

  get element(): HTMLElement | null {
    return this.current;
  }

  close(): void {
    this.current?.remove();
    this.current = null;
    this.currentKey = undefined;
    this.sticky = false;
    const done = this.onClose;
    this.onClose = undefined;
    done?.();
  }

  /**
   * Scrolling / zooming the view closes menus and panels (they belong to what they were opened on),
   * but not a sticky popup: a guide card placed in the corner of the view stays while the view
   * scrolls to the evidence it explains (FR-19.10).
   */
  closeOnViewChange(): void {
    if (!this.sticky) this.close();
  }

  /** The key of the open menu, if it was opened with one. */
  get openKey(): string | undefined {
    return this.current ? this.currentKey : undefined;
  }

  /** Shows arbitrary content at client coordinates; `sticky`: survives scrolling / zooming the view; `onClose`: when it goes. */
  show(content: HTMLElement, x: number, y: number, opts: { sticky?: boolean; onClose?: () => void } = {}): HTMLElement {
    const active = this.host.ownerDocument.activeElement;
    // keep the original opener when a popup replaces another one
    if (!this.current) this.opener = active instanceof HTMLElement && active !== this.host.ownerDocument.body ? active : null;
    this.close();
    this.current = content;
    this.sticky = !!opts.sticky;
    this.onClose = opts.onClose;
    this.layer.appendChild(content);
    if (opts.sticky) this.placeInCorner(content, x, y);
    else this.place(content, x, y);
    return content;
  }

  /** `key` names the menu so that `refresh` can rebuild it in place (e.g. after its options changed). */
  showMenu(items: MenuItem[], x: number, y: number, key?: string): HTMLElement {
    const menu = this.show(this.buildMenu(items), x, y);
    this.currentKey = key;
    (menu.querySelector(':scope > .menu-item:not(.disabled)') as HTMLElement | null)?.focus();
    return menu;
  }

  /** Rebuilds the open menu with `key` at the same place, keeping the focused row; false when it is not open. */
  refresh(key: string, items: MenuItem[]): boolean {
    const old = this.current;
    if (!old || this.currentKey !== key) return false;
    const focusedId = (old.querySelector('.menu-item:focus') as HTMLElement | null)?.dataset.menuId;
    const menu = this.buildMenu(items);
    menu.style.left = old.style.left;
    menu.style.top = old.style.top;
    old.replaceWith(menu);
    this.current = menu;
    const again = focusedId ? ([...menu.querySelectorAll('.menu-item')] as HTMLElement[]).find((r) => r.dataset.menuId === focusedId) : undefined;
    again?.focus();
    return true;
  }

  private onMenuKey(e: KeyboardEvent): void {
    const doc = this.host.ownerDocument;
    const focused = doc.activeElement instanceof HTMLElement && this.current!.contains(doc.activeElement) ? doc.activeElement.closest('.menu-item') as HTMLElement | null : null;
    const list = (focused?.parentElement ?? this.current!) as HTMLElement;
    const rows = [...list.querySelectorAll(':scope > .menu-item:not(.disabled)')] as HTMLElement[];
    if (!rows.length) return;
    const i = focused ? rows.indexOf(focused) : -1;
    const move = (to: HTMLElement | undefined) => {
      e.preventDefault();
      to?.focus();
    };
    switch (e.key) {
      case 'ArrowDown':
        return move(rows[(i + 1) % rows.length]);
      case 'ArrowUp':
        return move(rows[(i - 1 + rows.length) % rows.length]);
      case 'Home':
        return move(rows[0]);
      case 'End':
        return move(rows[rows.length - 1]);
      case 'ArrowRight':
        if (focused?.classList.contains('has-submenu')) {
          focused.classList.add('open');
          this.fitSubmenu(focused.querySelector(':scope > .submenu') as HTMLElement);
          move(focused.querySelector('.submenu > .menu-item:not(.disabled)') as HTMLElement | undefined);
        }
        return;
      case 'ArrowLeft': {
        const parentRow = list.closest('.menu-item.has-submenu') as HTMLElement | null;
        if (parentRow) {
          parentRow.classList.remove('open');
          move(parentRow);
        }
        return;
      }
      case 'Enter':
      case ' ':
        if (focused) {
          e.preventDefault();
          focused.click();
        }
        return;
    }
  }

  /**
   * A card in a corner of the view stays where it was put (folding / unfolding must not move it, FR-19.10):
   * never flipped above the point like a menu; a card taller than the room below scrolls inside.
   */
  private placeInCorner(el: HTMLElement, x: number, y: number): void {
    const win = this.host.ownerDocument.defaultView;
    const vw = win?.innerWidth ?? 0;
    const vh = win?.innerHeight ?? 0;
    const w = el.offsetWidth;
    el.style.left = `${vw && w && x + w > vw - 4 ? Math.max(4, vw - w - 4) : x}px`;
    el.style.top = `${y}px`;
    if (vh) el.style.maxHeight = `${Math.max(80, vh - y - 8)}px`;
  }

  /** A submenu opens to the right of its row, or to the left when the right edge of the view would cut it; moved up when it would run off the bottom. */
  private fitSubmenu(sub: HTMLElement): void {
    const win = this.host.ownerDocument.defaultView;
    const vw = win?.innerWidth ?? 0;
    const vh = win?.innerHeight ?? 0;
    sub.classList.remove('flip');
    sub.style.top = '';
    const r = sub.getBoundingClientRect();
    if (vw && r.width && r.right > vw - 4) sub.classList.add('flip');
    if (vh && r.height && r.bottom > vh - 4) sub.style.top = `${-5 - Math.min(r.bottom - vh + 4, r.top - 4)}px`;
  }

  private place(el: HTMLElement, x: number, y: number): void {
    const win = this.host.ownerDocument.defaultView;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = win?.innerWidth ?? 0;
    const vh = win?.innerHeight ?? 0;
    const left = vw && w && x + w > vw - 4 ? Math.max(4, vw - w - 4) : x;
    const top = vh && h && y + h > vh - 4 ? Math.max(4, y - h) : y;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  buildMenu(items: MenuItem[], nested = false): HTMLElement {
    const menu = html('div', { class: nested ? 'menu submenu' : 'menu', role: 'menu' });
    for (const item of items) {
      if (item.separator) {
        menu.appendChild(html('div', { class: 'menu-separator', role: 'separator' }));
        continue;
      }
      const row = html(
        'div',
        {
          class: ['menu-item', item.disabled ? 'disabled' : '', item.submenu ? 'has-submenu' : '', item.checked ? 'checked' : ''].filter(Boolean).join(' '),
          role: item.role ? `menuitem${item.role}` : 'menuitem',
          'aria-checked': item.role ? String(!!item.checked) : undefined,
          tabindex: item.disabled ? undefined : -1,
          'aria-disabled': item.disabled ? 'true' : undefined,
          'data-menu-id': item.id,
          title: item.title,
        },
        [
          html('span', { class: 'menu-check' }, [item.checked ? '✓' : '']),
          html('span', { class: 'menu-label' }, [item.label]),
          item.hint ? html('span', { class: 'menu-hint' }, [item.hint]) : null,
          item.submenu ? html('span', { class: 'menu-arrow' }, ['›']) : null,
        ],
      );
      if (item.submenu && !item.disabled) {
        const sub = this.buildMenu(item.submenu, true);
        row.appendChild(sub);
        const open = () => {
          for (const other of menu.querySelectorAll(':scope > .menu-item.open')) other.classList.remove('open');
          row.classList.add('open');
          this.fitSubmenu(sub);
        };
        row.addEventListener('mouseenter', open);
        row.addEventListener('click', (e) => {
          if (!sub.contains(e.target as Node)) open(); // the row itself or its label, not a row of the submenu
        });
      } else if (!item.disabled && item.action) {
        const action = item.action;
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          if (item.keepOpen) return action();
          const opener = this.opener;
          this.close();
          action();
          // back to the button that opened the menu, unless the action moved focus elsewhere
          const doc = this.host.ownerDocument;
          if (opener?.isConnected && (doc.activeElement === doc.body || !doc.activeElement)) opener.focus();
        });
      }
      menu.appendChild(row);
    }
    return menu;
  }
}
