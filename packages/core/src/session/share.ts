/**
 * FR-25.2 a diagram's state as text to share (a bug report, a colleague): formatting, parsing, the code's git
 * state, and what differs on the receiving side. The session builds and restores the state itself.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DiagramStateSnapshot } from '@seqcall/protocol';
import { CONFIG_FILE_NAME, configFileOf } from '../classifier-impl';
import { git } from '../review/git-changes';
import { trimChar } from '../text';

export const STATE_FORMAT = 'seqcall-state';
export const STATE_SCHEMA_VERSION = 1;
/** Uncommitted files listed in a state (a huge working tree must not make the text huge). */
const MAX_CHANGED = 50;

export interface GitState {
  /** The project root relative to the git top-level ('' = the same). */
  dir: string;
  commit: string;
  branch?: string;
  changed: string[];
}

/** The code's git state, limited to the project folder; undefined without git or outside a repository. */
export async function gitState(projectRoot: string): Promise<GitState | undefined> {
  try {
    const top = (await git(projectRoot, ['rev-parse', '--show-toplevel'])).trim();
    const commit = (await git(projectRoot, ['rev-parse', 'HEAD'])).trim();
    const branch = (await git(projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const dir = path.relative(fs.realpathSync(top), fs.realpathSync(projectRoot)).replace(/\\/g, '/');
    // paths in porcelain output are relative to the top-level
    const status = await git(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
    const prefix = dir ? `${dir}/` : '';
    const changed: string[] = [];
    const entries = status.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.length < 4) continue;
      if (e[0] === 'R' || e[0] === 'C') i++; // the next entry is the old name
      const file = e.slice(3);
      // `-- .` lists files of the project folder only
      changed.push(file.slice(prefix.length));
    }
    return { dir, commit, ...(branch && branch !== 'HEAD' ? { branch } : {}), changed: changed.sort() };
  } catch {
    return undefined;
  }
}

/** Text of the project's layer config, undefined when there is none. */
export function readConfigText(projectRoot: string): string | undefined {
  try {
    return fs.readFileSync(configFileOf(projectRoot), 'utf8');
  } catch {
    return undefined;
  }
}

export function limitChanged(files: string[]): string[] {
  return files.length > MAX_CHANGED ? [...files.slice(0, MAX_CHANGED), `… +${files.length - MAX_CHANGED} more`] : files;
}

export const OPEN_HINT = 'Seqcall: Share → Open a shared diagram…, paste this text (or the file).';

/** The text to copy or save: pure JSON, a hint for the human reader as its second field. */
export function formatState(state: DiagramStateSnapshot): string {
  const { format, open: _old, ...rest } = state;
  return `${JSON.stringify({ format, open: OPEN_HINT, ...rest }, null, 2)}\n`;
}

/** File name of a saved state: `UserController.getUser.seqcall.json`. */
export function stateFileName(state: DiagramStateSnapshot): string {
  return `${trimChar(state.root.label.replace(/[^\w.-]+/g, '-'), '-') || 'diagram'}.seqcall.json`;
}

/**
 * Reads a pasted state: the JSON alone, or inside the text `formatState` makes (an issue, a chat message —
 * everything around the outermost braces is ignored). Throws with a readable reason.
 */
export function parseState(text: string): DiagramStateSnapshot {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No shared diagram in the pasted text (copy one with Share → Copy to reopen elsewhere).');
  let value: unknown;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`The pasted diagram is not valid JSON: ${(e as Error).message}`);
  }
  const s = value as Partial<DiagramStateSnapshot> | null;
  if (!s || typeof s !== 'object' || s.format !== STATE_FORMAT) throw new Error('The pasted text is not a shared Seqcall diagram.');
  if (typeof s.schemaVersion !== 'number' || s.schemaVersion > STATE_SCHEMA_VERSION) {
    throw new Error(`The shared diagram is from a newer Seqcall (format ${String(s.schemaVersion)}); update Seqcall to open it.`);
  }
  if (!s.root || typeof s.root.key !== 'string') throw new Error('The shared diagram has no root method.');
  return {
    ...(s as DiagramStateSnapshot),
    expanded: Array.isArray(s.expanded) ? s.expanded.filter((x): x is string => typeof x === 'string') : [],
    choices: s.choices && typeof s.choices === 'object' ? s.choices : {},
    interfaceChoices: s.interfaceChoices && typeof s.interfaceChoices === 'object' ? s.interfaceChoices : {},
    filters: Array.isArray(s.filters) ? s.filters : [],
    options: s.options && typeof s.options === 'object' ? s.options : {},
    seen: s.seen ?? { messages: 0, participants: 0 },
  };
}

const short = (commit: string) => commit.slice(0, 7);
const list = (files: string[], max = 5) => (files.length > max ? `${files.slice(0, max).join(', ')} … +${files.length - max}` : files.join(', '));

/** Differences between the sender's code / setup and the receiver's, one sentence each. */
export function codeDifferences(
  state: DiagramStateSnapshot,
  here: { git?: GitState; config?: string; language: string; toolVersion?: string; autoSelect: boolean },
): string[] {
  const out: string[] = [];
  if (state.project.language !== here.language) out.push(`The state is from a ${state.project.language} project, this one is ${here.language}.`);
  const theirs = state.git;
  const mine = here.git;
  if (theirs && mine) {
    if (theirs.commit !== mine.commit) out.push(`Other commit: the sender was on ${short(theirs.commit)}${theirs.branch ? ` (${theirs.branch})` : ''}, you are on ${short(mine.commit)}${mine.branch ? ` (${mine.branch})` : ''}.`);
    if (theirs.changed.length) out.push(`The sender had uncommitted changes in ${theirs.changed.length} file${theirs.changed.length === 1 ? '' : 's'}: ${list(theirs.changed)}.`);
    const own = mine.changed.filter((f) => !theirs.changed.includes(f));
    if (own.length) out.push(`You have uncommitted changes the sender did not have: ${list(own)}.`);
  } else if (theirs && !mine) out.push(`The sender's code is commit ${short(theirs.commit)}; this project is not in a git repository, so it cannot be compared.`);
  if ((state.config ?? '') !== (here.config ?? '')) out.push(`The layer configuration (${CONFIG_FILE_NAME}) differs${state.config === undefined ? ' (the sender had none)' : here.config === undefined ? ' (you have none)' : ''}.`);
  if (state.tool?.version && here.toolVersion && state.tool.version !== here.toolVersion) out.push(`Other Seqcall version: the sender had ${state.tool.version}, you have ${here.toolVersion}.`);
  if (state.autoSelectSingleImplementation !== undefined && state.autoSelectSingleImplementation !== here.autoSelect) {
    out.push(`The setting "pre-select the only implementation" is ${here.autoSelect ? 'on' : 'off'} here, ${state.autoSelectSingleImplementation ? 'on' : 'off'} for the sender.`);
  }
  if (state.review) out.push(`The sender had a review against ${state.review.base} on; its marks are not shown here.`);
  return out;
}

/**
 * FR-25.2 where the state's root file is on this machine: under each search root (a workspace folder, a loaded
 * project) as the key's path, or as the sender's project folder below the search root's git top-level.
 */
export async function locateStateFile(state: DiagramStateSnapshot, searchRoots: string[]): Promise<string | undefined> {
  // a key without a file part (`unknown`, `#X`) is in no file
  const hash = state.root.key.indexOf('#');
  if (hash <= 0) return undefined;
  const rel = state.root.key.slice(0, hash);
  const candidates: string[] = [];
  for (const r of searchRoots) {
    candidates.push(path.join(r, rel));
    if (state.project.dir !== undefined) {
      const top = await git(r, ['rev-parse', '--show-toplevel']).then((t) => t.trim(), () => undefined);
      if (top) candidates.push(path.join(top, state.project.dir, rel));
    }
  }
  return candidates.map((c) => c.replace(/\\/g, '/')).find((c) => fs.existsSync(c));
}
