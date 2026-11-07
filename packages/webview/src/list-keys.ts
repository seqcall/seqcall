/**
 * a text field above a list of buttons (the ⌂ filter, Find's "in collapsed calls"): ↓ from the
 * field goes to the first row, ↓ / ↑ move between rows, ↑ on the first row back to the field; Enter on a row is its
 * click (a button). `rows` is asked each time: the list is redrawn while typing.
 */
export function bindListKeys(input: HTMLInputElement, list: HTMLElement, rows: () => HTMLElement[]): void {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const first = rows()[0];
    if (!first) return;
    e.preventDefault();
    first.focus();
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const all = rows();
    const i = all.indexOf(e.target as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const to = e.key === 'ArrowDown' ? all[Math.min(i + 1, all.length - 1)] : i === 0 ? input : all[i - 1];
    to.focus();
  });
}
