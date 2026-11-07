/**
 * FR-14.3 narrow panels: a toolbar narrower than `below` px gets the class `compact` (buttons show
 * icons only; their names stay in the tooltips). The toolbar spans the panel, so its width does not
 * depend on the class — no feedback loop.
 */
export function setCompact(toolbar: HTMLElement, width: number, below: number): void {
  toolbar.classList.toggle('compact', width > 0 && width < below);
}

/**
 * Applied in the next animation frame and only when the state flips: toggling the class changes the
 * toolbar's height, and doing that inside the observer callback is a "ResizeObserver loop" error.
 */
export function observeCompact(toolbar: HTMLElement, below: number): void {
  const win = toolbar.ownerDocument.defaultView;
  if (!win?.ResizeObserver) return;
  new win.ResizeObserver((entries) => {
    const width = entries[0].contentRect.width;
    const want = width > 0 && width < below;
    if (want !== toolbar.classList.contains('compact')) win.requestAnimationFrame(() => setCompact(toolbar, width, below));
  }).observe(toolbar);
}
