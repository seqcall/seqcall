/**
 * Long synchronous scans (entry points over every file) block the host's event loop — in VS Code the whole
 * extension host. `await slice()` between files gives way once `ms` have passed, so a click (an expand, a render)
 * can run meanwhile; between those moments the scan runs as before.
 */
export function timeSlicer(ms = 50): () => Promise<void> {
  let start = performance.now();
  return async () => {
    if (performance.now() - start < ms) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    start = performance.now();
  };
}
