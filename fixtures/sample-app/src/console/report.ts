/** Output of a command: a record of functions (functional port), like a CLI's streams. */
export interface Output {
  readonly line: (text: string) => void;
}

export function report(names: string[], { line }: Output): void {
  for (const name of names) line(name);
}
