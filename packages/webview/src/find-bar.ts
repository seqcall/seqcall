/**
 * FR-23 find bar of both views: a floating box at the top right under the toolbar — query, "3 of 12",
 * previous / next, Dim others, close — and an optional area below for results that are not drawn
 * (the sequence view's hits in collapsed calls). Plain DOM, no editor API (portable to every host).
 */
import { FLASH_MS, html } from './dom';
import { bindListKeys } from './list-keys';

export interface FindBarActions {
  /** The query changed (typed, or the bar was opened with one). */
  change(query: string): void;
  next(): void;
  previous(): void;
  dim(on: boolean): void;
  close(): void;
}

export class FindBar {
  readonly element: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly count: HTMLElement;
  /** "Back to the first" when ↓ wraps round (the count alone jumping from 12 to 1 is easy to miss). */
  private readonly wrap: HTMLElement;
  private wrapTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly extra: HTMLElement;
  private readonly dimBox: HTMLInputElement;

  constructor(
    private readonly actions: FindBarActions,
    placeholder: string,
    /** Hover text of the input: what can be typed, in full (the placeholder must fit the narrow input). */
    hint?: string,
  ) {
    this.input = html('input', { type: 'text', class: 'find-input', placeholder, 'aria-label': 'Find', ...(hint ? { title: hint } : {}), spellcheck: 'false', autocomplete: 'off' });
    this.count = html('span', { class: 'find-count', 'aria-live': 'polite' });
    this.wrap = html('span', { class: 'find-wrap', 'aria-live': 'polite', hidden: true });
    const button = (label: string, title: string, run: () => void, cls = 'find-btn') => {
      const b = html('button', { type: 'button', class: cls, title, 'aria-label': title }, [label]);
      b.addEventListener('click', run);
      return b;
    };
    this.dimBox = html('input', { type: 'checkbox', class: 'find-dim-toggle' });
    this.dimBox.addEventListener('change', () => actions.dim(this.dimBox.checked));
    const dim = html('label', { class: 'find-dim', title: 'Dim everything that does not match' }, [this.dimBox, 'Dim others']);
    this.extra = html('div', { class: 'find-extra' });
    this.element = html('div', { class: 'find-bar', role: 'search', hidden: true }, [
      html('div', { class: 'find-row' }, [
        html('span', { class: 'find-icon', 'aria-hidden': 'true' }, ['⌕']),
        this.input,
        this.count,
        this.wrap,
        button('↑', 'Previous match (Shift+Enter)', () => actions.previous()),
        button('↓', 'Next match (Enter)', () => actions.next()),
        dim,
        button('✕', 'Close (Escape)', () => this.close(), 'find-btn find-close'),
      ]),
      this.extra,
    ]);
    this.input.addEventListener('input', () => actions.change(this.input.value));
    // ↓ reaches the rows under the field (the matches in collapsed calls, folded into layers)
    bindListKeys(this.input, this.extra, () => [...this.extra.querySelectorAll<HTMLElement>('.find-deep-item')]);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) actions.previous();
        else actions.next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  get query(): string {
    return this.isOpen ? this.input.value : '';
  }

  get dimmed(): boolean {
    return this.isOpen && this.dimBox.checked;
  }

  /** Opens (or focuses) the bar; `query` replaces the text, else the last query is selected. */
  open(query?: string): void {
    const wasOpen = this.isOpen;
    this.element.hidden = false;
    // just under the view's toolbar (its height depends on the panel width)
    const toolbar = this.element.parentElement?.querySelector('.toolbar');
    if (toolbar) this.element.style.top = `${Math.round(toolbar.getBoundingClientRect().bottom) + 6}px`;
    if (query !== undefined) this.input.value = query;
    this.input.focus();
    this.input.select();
    if (!wasOpen || query !== undefined) this.actions.change(this.input.value);
  }

  close(): void {
    if (!this.isOpen) return;
    this.element.hidden = true;
    this.showWrap(undefined);
    this.extra.replaceChildren();
    this.actions.close();
  }

  /**
   * The match `delta` away from `index` among `total`, round the ends; going round says so for a moment
   * (*Back to the first* / *Back to the last*). Starting from no match (-1) is no wrap.
   */
  step(index: number, delta: number, total: number): number {
    const next = (index + delta + total) % total;
    const wrapped = index >= 0 && total > 1 && (delta > 0 ? next < index : next > index);
    this.showWrap(wrapped ? (delta > 0 ? '↻ Back to the first' : '↻ Back to the last') : undefined);
    return next;
  }

  private showWrap(text: string | undefined): void {
    clearTimeout(this.wrapTimer);
    this.wrap.textContent = text ?? '';
    this.wrap.hidden = !text;
    if (text) this.wrapTimer = setTimeout(() => this.showWrap(undefined), FLASH_MS);
  }

  /** "3 of 12", "No matches" (`current` is 0-based, -1 = none selected). */
  setCount(current: number, total: number, emptyText = 'No matches'): void {
    const q = this.input.value.trim();
    this.count.textContent = !q ? '' : total ? `${current >= 0 ? current + 1 : '?'} of ${total}` : emptyText;
    this.count.classList.toggle('none', !!q && !total);
    // matches exist, just not drawn (below collapsed calls): not an error colour
    this.count.classList.toggle('deep-only', emptyText !== 'No matches');
  }

  /** Content below the query row (results that are not drawn); null clears it. */
  setExtra(content: HTMLElement | null): void {
    this.extra.replaceChildren(...(content ? [content] : []));
  }
}

/** FR-23 Ctrl/Cmd+F and `/` (outside text fields) open the find bar of a view. */
export function bindFindKeys(doc: Document, open: () => void): void {
  doc.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      open();
    } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      open();
    }
  });
}
