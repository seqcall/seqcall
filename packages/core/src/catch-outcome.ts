/**
 * FR-1.17 what a catch clause does with the error, from its syntax — shared by the TS and PHP adapters
 * (the C# sidecar has its own copy in FragmentScopes.cs).
 */

/**
 * A logging call: `_logger.LogError`, `logger.warn`, `console.error`, `Log::error`, `report($e)`,
 * `Sentry.captureException` — not `login` / `logout` (`log` alone or followed by a capital).
 */
const LOG_METHOD = /^([Ll]og([A-Z]\w*)?|[Ww]arn(ing)?|[Ee]rror|[Ii]nfo(rmation)?|[Dd]ebug|[Tt]race|[Cc]ritical|[Ff]atal|[Aa]lert|[Ee]mergency|[Nn]otice|report|[Cc]apture(Exception|Message))$/;

/** `$this->logger`, `_logger`, `log`, `Log`, `auditLogger` — not `catalog`. */
const LOG_RECEIVER = /^\$?_?log(ger)?$|Logger$/i;

export function isLogCall(receiver: string | undefined, method: string): boolean {
  return LOG_METHOD.test(method) || (!!receiver && LOG_RECEIVER.test(receiver.replace(/^.*(\.|->|::|\\)/, '')));
}

/** A returned expression, on one line and short: `(default, new VoucherDetails { … })`. */
export function compactValue(text: string, max = 40): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
