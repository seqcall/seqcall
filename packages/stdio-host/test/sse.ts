/** Test helpers for the browser mode (FR-21): a Server-Sent Events client and view intents, as the page sends them. */

/** A Server-Sent Events client on fetch: `next(pred)` waits for a matching data frame. */
export async function events(url: string) {
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const frames: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  void (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (!frame.startsWith('data: ')) continue;
          const msg = JSON.parse(frame.slice(6));
          frames.push(msg);
          for (const w of waiters.splice(0)) (w.pred(msg) ? w.resolve(msg) : waiters.push(w));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    status: res.status,
    frames,
    close: () => controller.abort(),
    /** Fails after `ms` with `what` and the frames seen so far, so a hang names the missing event. */
    next: (pred: (m: any) => boolean, what = 'a matching frame', ms = 20_000) => // eslint-disable-line @typescript-eslint/no-explicit-any
      new Promise<any>((resolve, reject) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`no ${what} within ${ms} ms; frames: ${frames.map((f) => f.type).join(', ') || 'none'}`));
        }, ms);
        const waiter = { pred, resolve: (m: any) => (clearTimeout(timer), resolve(m)) }; // eslint-disable-line @typescript-eslint/no-explicit-any
        waiters.push(waiter);
      }),
  };
}

/** POST a view message as the page does (`/<view>?t=…` → `/intent/<view>?t=…`). */
export const intent = (url: string, view: string, message: object) =>
  fetch(url.replace(`/${view}?`, `/intent/${view}?`), { method: 'POST', body: JSON.stringify(message) });
