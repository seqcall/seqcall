/** The file of a class key (`<relPath>#…`); undefined for libraries and unknown targets. */
export function fileOfClassKey(key: string): string | undefined {
  if (key.startsWith('lib:') || !key.includes('#')) return undefined;
  return key.slice(0, key.indexOf('#'));
}
