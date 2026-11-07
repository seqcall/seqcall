import type { ClassRef, LayerReason, StereotypeReason } from '@seqcall/protocol';
import type { ClassInfo } from './adapter';
import type { SmartExpandConfig } from './smart-expand';

export interface Classification {
  /** Without guillemets, e.g. ["service", "singleton"]. */
  stereotypes: string[];
  layer?: string;
  /** Module folder path relative to the project root, e.g. "src/services". */
  namespace: string;
  /** FR-7.8 why it is in its layer (the rule that decided). */
  layerReason?: LayerReason;
  /** FR-7.9 why it carries each stereotype (same order as `stereotypes`). */
  stereotypeReasons?: StereotypeReason[];
}

/** How a participant is reached — some stereotypes depend on usage, not declaration («seam», «static»). */
export interface UsageContext {
  /** Reached through an interface/abstract-typed dependency injected via constructor or parameter. */
  injectedAsAbstraction?: boolean;
  /** Reached through a static member call. */
  staticAccess?: boolean;
  /** FR-6.7 the DI container makes it once: its only registration is a singleton (`AddSingleton`, `singleton(…)`). */
  containerSingleton?: boolean;
}

/**
 * Stereotype & layer assignment (FR-7): built-in heuristics, extended/overridden by
 * `<projectRoot>/.seqcall.json`:
 *
 * {
 *   "layers": [ { "name": "Presentation", "match": ["src/controllers/**"] }, ... ],   // ordered by priority: first match wins
 *   "layerOrder": ["Presentation", "Application", "Ports", "Domain", "Infrastructure"],  // optional display order (bands/lanes)
 *   "stereotypes": [
 *     { "stereotype": "port", "match": { "path": "src/ports/**" } },
 *     { "stereotype": "gateway", "match": { "name": ".*Gateway$" } },
 *     { "stereotype": "controller", "match": { "decorator": "Controller" } },
 *     { "stereotype": "adapter", "match": { "implements": ".*Port$" } }
 *   ],
 *   "disableBuiltinStereotypes": false,
 *   "associationNames": "non-obvious",   // or "all": show field names on associations even when they only repeat the type
 *   "dependencyRule": { "Domain": 0, "Application": 1, "Ports": 1, "Presentation": 2, "Infrastructure": 2 },
 *       // ring per layer, 0 = innermost; a relation from an inner to an outer ring is a violation
 *       // (class diagram). These are the defaults; given layers replace them, unlisted layers are unchecked.
 *   "testFiles": ["e2e/**", "src/**\/*.spec.ts"]   // test code (globs relative to the root); replaces the defaults
 * }
 *
 * (`\/` stands for `/` inside this comment.) Test code (default globs: `**\/*.spec.*`, `**\/*.test.*`, `**\/__tests__/**`, `**\/test/**`,
 * `**\/tests/**`, `**\/features/**\/*.steps.*`, `**\/features/support/**`, `**\/features/step-definitions/**`, `**\/features/step_definitions/**`, `**\/*.steps.*`) never provides implementations
 * (FR-8, so it does not prevent auto-selection either), and its callers are listed after production
 * callers (FR-4.1).
 */
export interface Classifier {
  classify(ref: ClassRef, info: ClassInfo | undefined, usage?: UsageContext): Classification;
  /** Display order of layers (bands/lanes): `layerOrder` config, else architectural order (not rule priority). */
  layerOrder(): string[];
  /** Association labels: hide names that only repeat the type ("non-obvious", default) or show "all". */
  associationNames?(): 'non-obvious' | 'all';
  /** Dependency-rule ring of a layer (0 = innermost), or undefined when the layer is unchecked. */
  layerRing?(layer: string): number | undefined;
  /** FR-7.11 `layerHints.ignore` silences this file's ⚑ hint (relative path). Optional. */
  layerHintIgnored?(relPath: string): boolean;
  /** FR-19.22 the `layerHints.ignore` globs as written (listed in the ⚠ menu, with Stop ignoring). Optional. */
  layerHintIgnores?(): string[];
  /** FR-3.6 `smartExpand` section of the project config. */
  smartExpandConfig?(): SmartExpandConfig | undefined;
  /** FR-19 design findings: thresholds and disabled kinds. Optional. */
  findingsConfig?(): { maxDependencies?: number; disable?: string[]; ignore?: string[]; godClass?: { methods?: number; lines?: number; fields?: number; dependencies?: number; models?: boolean } } | undefined;
  /** FR-31.4 `unreachable.ignore` names the method (its file, relative path, or `Class.method`). Optional. */
  unreachableIgnored?(relPath: string, qualifiedName: string): boolean;
  /** FR-18.14 which sources the step before an entry point's action shows. Optional. */
  pipelineConfig?(): { route?: boolean; controller?: boolean; global?: boolean } | undefined;
  /** The project root the config belongs to (where git history is read: FR-24 reviews). Optional. */
  projectRoot?(): string;
  reloadConfig(): void;
  /**
   * FR-25.3 use another config (the text of a shared diagram's `.seqcall.json`) instead of the file, in
   * memory only, until called with undefined; `reloadConfig` keeps it meanwhile. Throws (nothing changed) when
   * the text is not valid or a pattern in it could hang the analysis. Optional.
   */
  setConfigOverride?(text: string | undefined): void;
}
