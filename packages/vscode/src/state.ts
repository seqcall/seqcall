import type { ProjectLanguage } from '@seqcall/core';
import type * as vscode from 'vscode';
import type { ParticipantPositions, Position } from '@seqcall/protocol';
import type { SessionPersistentState } from '@seqcall/core';
import { pathKey } from './paths';

/** Last diagram root, used to restore the sequence panel (FR-13.2). */
export interface LastRoot {
  projectRoot: string;
  /** Analysis language of the project (absent in state saved before C# support = typescript). */
  language?: ProjectLanguage;
  methodKey: string;
  file?: string;
  position?: Position;
}

/** Typed wrapper around `context.workspaceState`. */
export class StateStore {
  constructor(private readonly memento: vscode.Memento) {}

  getSessionState(projectRoot: string): Partial<SessionPersistentState> | undefined {
    return this.memento.get(`seqcall.session:${pathKey(projectRoot)}`);
  }

  setSessionState(projectRoot: string, state: SessionPersistentState): Thenable<void> {
    return this.memento.update(`seqcall.session:${pathKey(projectRoot)}`, state);
  }

  /** FR-10.8: manual positions per root method. */
  getPositions(projectRoot: string, rootKey: string): ParticipantPositions | undefined {
    const all = this.memento.get<Record<string, ParticipantPositions>>(`seqcall.positions:${pathKey(projectRoot)}`);
    return all?.[rootKey];
  }

  setPositions(projectRoot: string, rootKey: string, positions: ParticipantPositions): Thenable<void> {
    const key = `seqcall.positions:${pathKey(projectRoot)}`;
    const all = { ...(this.memento.get<Record<string, ParticipantPositions>>(key) ?? {}) };
    all[rootKey] = positions;
    return this.memento.update(key, all);
  }

  getFollowCursor(): boolean {
    return this.memento.get<boolean>('seqcall.followCursor', false);
  }

  setFollowCursor(value: boolean): Thenable<void> {
    return this.memento.update('seqcall.followCursor', value);
  }

  getLastRoot(): LastRoot | undefined {
    return this.memento.get<LastRoot>('seqcall.lastRoot');
  }

  setLastRoot(root: LastRoot): Thenable<void> {
    return this.memento.update('seqcall.lastRoot', root);
  }
}
