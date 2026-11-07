import * as vscode from 'vscode';
import type { DiagramOptions } from '@seqcall/protocol';

export const SECTION = 'seqcall';

/** A setting of `seqcall.*`. */
export function setting<T>(key: string, fallback: T, scope?: vscode.Uri): T {
  return vscode.workspace.getConfiguration(SECTION, scope).get<T>(key, fallback);
}

/** Whether a configuration change touches `seqcall.<key>`. */
export function affects(e: vscode.ConfigurationChangeEvent, key: string): boolean {
  return e.affectsConfiguration(`${SECTION}.${key}`);
}

export interface ExtensionConfig {
  defaultDepth: number;
  autoSelectSingleImplementation: boolean;
  /** Options that come from settings (followCursor is toolbar/command state, not a setting). */
  options: Pick<DiagramOptions, 'showArguments' | 'maxArgumentLength' | 'showLibraryCalls' | 'showFragments' | 'showPipeline' | 'showResults' | 'showSideEffects' | 'scanSideEffects'>;
}

export function readConfig(scope?: vscode.Uri): ExtensionConfig {
  const c = { get: <T>(key: string, fallback: T): T => setting(key, fallback, scope) };
  return {
    defaultDepth: c.get<number>('defaultDepth', 1),
    autoSelectSingleImplementation: c.get<boolean>('autoSelectSingleImplementation', true),
    options: {
      showArguments: c.get<boolean>('showArguments', false),
      maxArgumentLength: c.get<number>('maxArgumentLength', 30),
      showLibraryCalls: c.get<boolean>('showLibraryCalls', false),
      showFragments: c.get<boolean>('showFragments', true),
      showPipeline: c.get<boolean>('showPipeline', true),
      showResults: c.get<boolean>('showResults', false),
      showSideEffects: c.get<boolean>('showSideEffects', true),
      scanSideEffects: c.get<boolean>('scanSideEffects', true),
    },
  };
}

/** Settings that map 1:1 to a DiagramOptions key and are applied live to open sessions. */
export const LIVE_OPTION_SETTINGS = ['showArguments', 'maxArgumentLength', 'showLibraryCalls', 'showFragments', 'showPipeline', 'showResults', 'showSideEffects', 'scanSideEffects'] as const;
