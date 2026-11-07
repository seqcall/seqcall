/**
 * Styled hover card (native SVG `<title>` tooltips cannot be styled): shown after a short delay
 * next to the mouse for elements the `content` callback recognises; hidden on leave, scroll,
 * click and re-render. Plain DOM, no editor API (portable to JCEF).
 */
export class HoverCard {
  readonly element: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Element | null = null;
  /** The anchor whose card is visible (for the `hidden` hook). */
  private shownAnchor: Element | null = null;
  private hooks: { shown?(anchor: Element): void; hidden?(): void } = {};
  /** The card takes clicks: it stays while the mouse moves onto it (see attach `interactive`). */
  private interactive = false;
  private leaveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly delayMs = 350,
  ) {
    this.element = root.ownerDocument.createElement('div');
    this.element.className = 'hover-card';
    this.element.setAttribute('role', 'tooltip');
    this.element.hidden = true;
    root.appendChild(this.element);
  }

  /**
   * Shows `content(target)` for targets inside `container`; `content` returns the element the
   * card belongs to and its content, or null for "no card here". `hooks` run when a card
   * appears / disappears (e.g. to highlight what the card is about elsewhere in the view).
   */
  attach(
    container: HTMLElement,
    content: (target: Element) => { anchor: Element; body: Node[] } | null,
    hooks: { shown?(anchor: Element): void; hidden?(): void; interactive?: boolean } = {},
  ): void {
    this.hooks = hooks;
    this.interactive = !!hooks.interactive;
    if (this.interactive) {
      // the mouse may cross the diagram on its way to the card: the card stays a moment, and while over it
      this.element.classList.add('interactive');
      this.element.addEventListener('mouseenter', () => this.cancelLeave());
      this.element.addEventListener('mouseleave', (e) => {
        if (!(e.relatedTarget instanceof Node && container.contains(e.relatedTarget))) this.hide();
      });
    }
    container.addEventListener('mouseover', (e) => {
      const found = e.target instanceof Element ? content(e.target) : null;
      if (!found) return this.leave();
      if (found.anchor === this.current) return this.cancelLeave();
      if (this.interactive && this.shownAnchor) {
        // another element: its card replaces this one after the delay (not at once — the mouse may be passing)
        this.cancelLeave();
        if (this.timer) clearTimeout(this.timer);
        this.current = found.anchor;
        const { clientX, clientY } = e;
        this.timer = setTimeout(() => {
          this.hide();
          this.current = found.anchor;
          this.reveal(found, clientX, clientY);
        }, this.delayMs);
        return;
      }
      this.hide();
      this.current = found.anchor;
      const { clientX, clientY } = e;
      this.timer = setTimeout(() => this.reveal(found, clientX, clientY), this.delayMs);
    });
    container.addEventListener('mouseleave', (e) => {
      if (this.interactive && e.relatedTarget instanceof Node && this.element.contains(e.relatedTarget)) return;
      this.leave();
    });
    container.addEventListener('mousedown', () => this.hide());
  }

  private reveal(found: { anchor: Element; body: Node[] }, x: number, y: number): void {
    this.show(found.body, x, y);
    this.shownAnchor = found.anchor;
    this.hooks.shown?.(found.anchor);
  }

  /** The mouse left what the card is about: an interactive card waits a moment (the mouse may be on its way to it). */
  private leave(): void {
    if (!this.interactive || !this.shownAnchor) return this.hide();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.current = this.shownAnchor;
    this.cancelLeave();
    this.leaveTimer = setTimeout(() => this.hide(), 300);
  }

  private cancelLeave(): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = undefined;
  }

  private show(body: Node[], x: number, y: number): void {
    this.element.replaceChildren(...body);
    this.element.hidden = false;
    const win = this.root.ownerDocument.defaultView;
    const w = this.element.offsetWidth;
    const h = this.element.offsetHeight;
    const maxX = (win?.innerWidth ?? 1e6) - w - 8;
    const maxY = (win?.innerHeight ?? 1e6) - h - 8;
    this.element.style.left = `${Math.max(4, Math.min(x + 12, maxX))}px`;
    this.element.style.top = `${Math.max(4, y + 18 > maxY ? y - h - 10 : y + 18)}px`;
  }

  /** Shows a card for `anchor` without the mouse (e.g. the change a reviewer stepped to), below / above it. */
  showAt(anchor: Element, body: Node[]): void {
    this.hide();
    const r = anchor.getBoundingClientRect();
    this.show(body, r.left + Math.min(r.width, 300) / 2, r.bottom - 12);
    this.current = anchor;
    this.shownAnchor = anchor;
    this.hooks.shown?.(anchor);
  }

  /** The anchor whose card is visible, if any. */
  get anchor(): Element | null {
    return this.shownAnchor;
  }

  hide(): void {
    this.cancelLeave();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.current = null;
    this.element.hidden = true;
    if (this.shownAnchor) {
      this.shownAnchor = null;
      this.hooks.hidden?.();
    }
  }
}
