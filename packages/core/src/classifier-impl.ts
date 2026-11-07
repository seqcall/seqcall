import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { ClassRef, LayerReason, StereotypeReason } from '@seqcall/protocol';
import type { ClassInfo } from './adapter';
import type { Classification, Classifier, UsageContext } from './classifier';
import type { SmartExpandConfig } from './smart-expand';
import { noteConfigChanged } from './config-generation';

export const CONFIG_FILE_NAME = '.seqcall.json';

/** Whether a path is a project's config file. */
export function isConfigFile(file: string): boolean {
  return path.basename(file) === CONFIG_FILE_NAME;
}

/** The config file of a project, joined with `/` when `root` is in that form. */
export function configFileOf(root: string): string {
  return root.includes('\\') ? path.join(root, CONFIG_FILE_NAME) : `${root.replace(/\/$/, '')}/${CONFIG_FILE_NAME}`;
}

export interface LayerRule {
  name: string;
  match: string[];
}

export interface StereotypeRule {
  stereotype: string;
  match: { name?: string; path?: string; decorator?: string; implements?: string };
}

export interface ClassifierConfig {
  layers?: LayerRule[];
  /**
   * FR-7.11 framework defaults for the framework's own folders, after `layers` and before the built-in
   * heuristics: "laravel", "fsd" (Feature-Sliced Design), or "none". Absent: detected (composer.json requiring
   * laravel/framework; FSD's layer folders `src/{app,pages,widgets,features,entities,shared}`, four of them with shared).
   */
  preset?: string;
  stereotypes?: StereotypeRule[];
  disableBuiltinStereotypes?: boolean;
  /** Globs (relative to the project root) of test code; replaces DEFAULT_TEST_FILE_GLOBS when given. */
  testFiles?: string[];
  /** Ring per layer (0 = innermost) for dependency-rule checks; replaces DEFAULT_DEPENDENCY_RULE. */
  dependencyRule?: Record<string, number>;
  /** "non-obvious" (default): hide association names that only repeat the type; "all": show them. */
  associationNames?: 'non-obvious' | 'all';
  /** Display order of layers (bands/lanes); default: built-in architectural order. */
  layerOrder?: string[];
  /** FR-7.11 layer hints (⚑) not to show: globs on the file, relative to the project root (`src/pages/x/model/**`). */
  layerHints?: { ignore?: string[] };
  /** FR-3.6 Smart expand budget and importance patterns. */
  smartExpand?: SmartExpandConfig;
  /**
   * FR-18.9 PHP: Composer packages (globs on `vendor/name`) analysed as project code, loaded on demand
   * from `vendor/`. Default: the project's own vendor (`acme/*` for `acme/shop`); `[]` = none.
   */
  packages?: string[];
  /** FR-19 design findings: thresholds and kinds to leave out. */
  findings?: FindingsConfig;
  /** FR-18.14 what the step before an entry point's action shows. */
  pipeline?: PipelineConfig;
  /**
   * FR-31.4 unreachable code: `ignore` — globs on the file (`database/migrations/**`) or on `Class.method`
   * (`*Listener.handle`) of methods a tool or the framework runs by convention: walked from, not listed.
   */
  unreachable?: { ignore?: string[] };
}

/** FR-18.14 sources of the step before an entry point's action (each absent = its default). */
export interface PipelineConfig {
  /** Middleware on routes and route groups (and on the mount of a route file). Default true. */
  route?: boolean;
  /** Controller middleware (`$this->middleware(…)` in its constructor). Default true. */
  controller?: boolean;
  /** The HTTP kernel's global stack (`$middleware`), before every route's own. Default false: the same on every route. */
  global?: boolean;
}

export interface FindingsConfig {
  /** Q11: a class with more injected dependencies than this is a finding (default 6). */
  maxDependencies?: number;
  /** Finding kinds not to report, e.g. ["layer-ping-pong"]. */
  disable?: string[];
  /** Globs on `Class.method` (calls) and class names known to be fine, e.g. ["helpers.setting", "*Cache*"]. */
  ignore?: string[];
  /** FR-19.11 god class thresholds; `models: true` also checks Active Record models (Eloquent …). */
  godClass?: GodClassConfig;
}

export interface GodClassConfig {
  /** Instance methods (default 20). */
  methods?: number;
  /** Non-blank lines of its file (default 500). */
  lines?: number;
  /** Fields (default 10) … */
  fields?: number;
  /** … or injected dependencies (default 7). */
  dependencies?: number;
  models?: boolean;
}

/**
 * FR-7.11 framework presets: layer rules for the framework's conventional folders (globs relative to the
 * project root), checked after the project's own rules. Laravel: HTTP, console and the service providers
 * (the composition root, like `Program.cs`) are Presentation; jobs, listeners, events, DTOs and actions
 * Application; Eloquent models and enums Domain; mail and notifications (sent through channels) Infrastructure.
 */
/**
 * FR-7.11 a framework preset: `layers` decide (strong); a file in a `noLayer` segment gets no layer from the preset (a
 * note on the card, its own code decides); `fallback` rules catch the rest (weak — a whole folder, not a segment).
 */
interface Preset {
  label: string;
  layers: LayerRule[];
  noLayer?: { segment: string; match: string[] }[];
  fallback?: LayerRule[];
  dependencyRule?: Record<string, number>;
  shared?: string;
}

export const PRESETS: Record<string, Preset> = {
  laravel: {
    label: 'Laravel',
    layers: [
      { name: 'Presentation', match: ['app/Http/**', 'app/Console/**', 'app/Providers/**', 'app/ViewModels/**', 'app/Rules/**', 'routes/**'] },
      { name: 'Application', match: ['app/Jobs/**', 'app/Listeners/**', 'app/Events/**', 'app/Actions/**', 'app/DTO/**', 'app/DTOs/**', 'app/Dto/**', 'app/Dtos/**', 'app/Data/**'] },
      { name: 'Domain', match: ['app/Models/**', 'app/Enums/**'] },
      { name: 'Infrastructure', match: ['app/Mail/**', 'app/Notifications/**'] },
    ],
  },
};

/** FSD's layers: a project with most of them (and `shared`) in its source folder follows Feature-Sliced Design. */
const FSD_LAYERS = ['app', 'processes', 'pages', 'widgets', 'features', 'entities', 'shared'];

/**
 * FR-7.11 Feature-Sliced Design (`src/{app,pages,widgets,features,entities,shared}/<slice>/{ui,model,api,lib}`): the
 * segment decides — `api/` calls the backend (Infrastructure), `model/` holds a slice's state and logic (Application;
 * in `entities/` the business entities: Domain), `ui/` Presentation; the rest by its layer (app, pages, widgets,
 * features: Presentation; entities: Domain; `shared/lib`, `shared/config`: none). FSD lets a layer import only the
 * layers below it, `shared` lowest: the rings follow (Infrastructure 0, Domain 1, Application 2, Presentation 3) — a
 * page's model calling `shared/api` is no violation, `api` importing a `model` is.
 */
export const FSD_LABEL = 'Feature-Sliced Design';

function fsdPreset(src: string): Preset & { dependencyRule: Record<string, number>; shared: string } {
  const at = (g: string) => `${src}${g}`;
  return {
    label: FSD_LABEL,
    shared: at('shared/'),
    // a slice is made of segments: the segment decides (a clear signal)
    layers: [
      { name: 'Infrastructure', match: [at('**/api/**')] },
      { name: 'Domain', match: [at('entities/*/model/**')] },
      { name: 'Application', match: [at('**/model/**')] },
      { name: 'Presentation', match: [at('**/ui/**')] },
    ],
    // helper and configuration segments have no layer of their own, in every FSD layer: the file's code decides
    noLayer: [{ segment: 'lib', match: [at('**/lib/**')] }, { segment: 'config', match: [at('**/config/**')] }],
    // a file outside any segment (a slice's index.ts, a page file): its FSD layer, a weak signal
    fallback: [
      { name: 'Presentation', match: [at('app/**'), at('processes/**'), at('pages/**'), at('widgets/**'), at('features/**')] },
      { name: 'Domain', match: [at('entities/**')] },
    ],
    dependencyRule: { Infrastructure: 0, Domain: 1, Application: 2, Ports: 2, Presentation: 3 },
  };
}

/** The folder holding FSD's layers (`src/` or the project root), or undefined: at least four of them, `shared` among them. */
function fsdSource(rootDir: string): string | undefined {
  for (const dir of ['src', '']) {
    try {
      const names = new Set(fs.readdirSync(path.join(rootDir, dir)));
      if (names.has('shared') && FSD_LAYERS.filter((l) => names.has(l)).length >= 4) return dir ? `${dir}/` : '';
    } catch {
      // no such folder
    }
  }
  return undefined;
}

/**
 * The preset of a project: the configured one ("none" = off), else detected — Laravel from composer.json, FSD from
 * its layer folders (`src/{app,pages,…,shared}`). FSD's globs start at the folder its layers are in.
 */
function presetOf(rootDir: string, configured: string | undefined): Preset | undefined {
  const fsd = () => fsdPreset(fsdSource(rootDir) ?? 'src/');
  if (typeof configured === 'string') {
    const key = configured.toLowerCase();
    return key === 'fsd' ? fsd() : PRESETS[key];
  }
  try {
    const composer = JSON.parse(fs.readFileSync(path.join(rootDir, 'composer.json'), 'utf8')) as { require?: Record<string, string> };
    if (composer.require?.['laravel/framework']) return PRESETS.laravel;
  } catch {
    // no composer.json
  }
  return fsdSource(rootDir) !== undefined ? fsd() : undefined;
}

/** Clean/hexagonal architecture: dependencies point inwards (outer → inner rings only). */
export const DEFAULT_DEPENDENCY_RULE: Record<string, number> = {
  Domain: 0,
  Application: 1,
  Ports: 1,
  Presentation: 2,
  Infrastructure: 2,
};

/**
 * FR-7.3 built-in layers, in band order. `explicit` folder names name the layer itself and
 * win anywhere in the path (`modules/x/infrastructure/api/…` is Infrastructure); `folders` are
 * role folders, used only when no explicit layer folder (or name hint) decided it — they are
 * ambiguous (`api/` holds endpoints in a backend but outbound clients elsewhere).
 * Path segments are also split on `.`, so dotted project folders count (`Billing.Infrastructure`,
 * `Sample.Web`). `core` is the Clean Architecture "Core" project (application + domain): an explicit
 * `Domain` folder inside it still wins. `interfaces` names no layer by itself.
 */
export const BUILTIN_LAYERS: { name: string; explicit: string[]; folders: string[] }[] = [
  { name: 'Presentation', explicit: ['presentation'], folders: ['controllers', 'controller', 'api', 'routes', 'handlers', 'ui', 'views', 'pages', 'web'] },
  { name: 'Application', explicit: ['application', 'usecases', 'use-cases'], folders: ['services', 'service', 'core'] },
  { name: 'Domain', explicit: ['domain'], folders: ['model', 'models', 'entities', 'entity'] },
  { name: 'Infrastructure', explicit: ['infrastructure', 'infra'], folders: ['adapters', 'repositories', 'db', 'persistence'] },
];

/**
 * Name-based layer hints for concrete classes/modules, applied after configured layer rules
 * and before folder names: folders like `api/` are ambiguous (inbound endpoints in a backend,
 * outbound clients in a frontend), names are not. Interfaces/abstract classes are excluded:
 * a `…Gateway`/`…Repository` interface is usually a port and keeps its folder's layer.
 */
export const LAYER_NAME_HINTS: [RegExp, string][] = [
  [/(Client|Gateway|Adapter|Proxy|Dao|Sdk)$/i, 'Infrastructure'],
  [/(Controller|Router|Resolver)$/i, 'Presentation'],
];

/**
 * Hexagonal layouts keep the inbound (driving) adapters inside `infrastructure/`: a folder below it
 * with one of these names holds HTTP routes, controllers, CLI commands — Presentation; also what starts work
 * without a request: jobs, workers, queue consumers, schedulers (they drive the application like a route). Not `api`:
 * `infrastructure/api` usually wraps an external API (outbound).
 */
export const INBOUND_ADAPTER_FOLDERS = ['http', 'rest', 'routes', 'route', 'controllers', 'controller', 'graphql', 'grpc', 'web', 'cli', 'endpoints', 'jobs', 'job', 'workers', 'worker', 'consumers', 'consumer', 'schedulers', 'scheduler'];
/** Folders below `infrastructure/` that mark the outbound side even inside an inbound-looking folder. */
const OUTBOUND_ADAPTER_FOLDERS = ['client', 'clients', 'outbound', 'gateway', 'gateways', 'external'];

const ROLE_SUFFIXES: [RegExp, string][] = [
  [/Controller$/, 'controller'],
  [/Service$/, 'service'],
  [/(Repository|Repo)$/, 'repository'],
  [/Factory$/, 'factory'],
  [/Adapter$/, 'adapter'],
  [/Port$/, 'port'],
];

const ROLE_DECORATORS: Record<string, string> = {
  Controller: 'controller',
  ApiController: 'controller', // ASP.NET Core [ApiController]
  RestController: 'controller',
  JsonController: 'controller',
  Resolver: 'controller',
  Injectable: 'service',
  Service: 'service',
  Repository: 'repository',
  EntityRepository: 'repository',
};

const ROLE_FOLDERS: Record<string, string> = {
  controllers: 'controller',
  services: 'service',
  repositories: 'repository',
  factories: 'factory',
  adapters: 'adapter',
  ports: 'port',
};

interface CompiledLayer {
  name: string;
  test: (p: string) => boolean;
  /** Each glob with its own matcher: the explanation names the one that matched (FR-7.8). */
  globs: { glob: string; test: (p: string) => boolean }[];
}

interface CompiledRule {
  stereotype: string;
  /** FR-7.9 "rule 2 in .seqcall.json: name `Job$`, path `app/Jobs/**`". */
  describe: string;
  name?: RegExp;
  path?: (p: string) => boolean;
  decorator?: string;
  implements?: RegExp;
}

/**
 * FR-25.3 why a regular expression from someone else's config is not used: too long, or a quantified group that
 * is itself quantified (`(a+)+`, `(\w*)*`, `(x|y+){2,}`) — the shape that can backtrack for minutes on one name.
 */
export function riskyPattern(pattern: string): string | undefined {
  if (pattern.length > 200) return 'is longer than 200 characters';
  if (/\((?:[^()\\+*}]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) return `repeats a repeated group (\`${pattern}\`), which can freeze the editor`;
  return undefined;
}

/** Test code by default (FR-8: no implementations from tests; FR-4.1: test callers last; «test», no layer). */
export const DEFAULT_TEST_FILE_GLOBS = [
  '**/*.spec.*',
  '**/*.test.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
  '**/features/**/*.steps.*',
  // Cucumber / BDD support code (hooks, world, setup)
  '**/features/support/**',
  '**/features/step-definitions/**',
  '**/features/step_definitions/**',
  '**/*.steps.*',
];

/** FR-7: heuristics + `.seqcall.json` (see the Classifier doc comment for the format). */
export class DefaultClassifier implements Classifier {
  /** test code (`testFiles`, else the defaults): «test», no layer of its own. */
  private isTestFile: (relPath: string) => boolean = picomatch(DEFAULT_TEST_FILE_GLOBS, { dot: true });
  private layers: CompiledLayer[] = [];
  /** FR-7.11 the preset's layer rules (after `layers`), and its name for explanations. */
  private presetLayers: CompiledLayer[] = [];
  private presetLabel: string | undefined;
  private presetNoLayer: { segment: string; test: (p: string) => boolean }[] = [];
  private presetFallback: CompiledLayer[] = [];
  /** FR-7.11 FSD's `shared/` folder (`src/shared/`): what the preset leaves without a layer on purpose (lib, config, …). */
  private presetShared: string | undefined;
  private rings: Record<string, number> = DEFAULT_DEPENDENCY_RULE;
  /** FR-7.11 `layerHints.ignore`: files whose ⚑ hint is silenced. */
  private hintIgnored: ((relPath: string) => boolean) | undefined;
  private hintGlobs: string[] = [];
  private unreachableIgnore: ((text: string) => boolean) | undefined;
  private assocNames: 'non-obvious' | 'all' = 'non-obvious';
  private smart: SmartExpandConfig | undefined;
  private findings: FindingsConfig | undefined;
  private pipeline: PipelineConfig | undefined;
  private explicitOrder: string[] | undefined;
  private rules: CompiledRule[] = [];
  private disableBuiltins = false;
  /** Last config load problem (for diagnostics). */
  configError?: string;
  /** The name of the file the rules come from (FR-7.8 / 7.9 reasons name it). */
  private configName = CONFIG_FILE_NAME;

  constructor(
    private readonly rootDir: string,
    config?: ClassifierConfig,
  ) {
    if (config) this.apply(config);
    else this.reloadConfig();
  }

  /** FR-25.3 a borrowed config (a shared diagram's), used instead of the file until cleared. */
  private override: ClassifierConfig | undefined;

  setConfigOverride(text: string | undefined): void {
    if (text === undefined) {
      this.override = undefined;
      this.reloadConfig();
      return;
    }
    let config: ClassifierConfig;
    try {
      config = JSON.parse(stripJsonComments(text)) as ClassifierConfig;
    } catch (e) {
      throw new Error(`The shared ${CONFIG_FILE_NAME} is not valid JSON: ${(e as Error).message}`);
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`The shared ${CONFIG_FILE_NAME} is not an object.`);
    for (const r of config.stereotypes ?? []) {
      for (const pattern of [r?.match?.name, r?.match?.implements]) {
        const why = typeof pattern === 'string' ? riskyPattern(pattern) : undefined;
        if (why) throw new Error(`The shared ${CONFIG_FILE_NAME} was not used: the stereotype rule "${String(r.stereotype)}" has a pattern that ${why}.`);
      }
    }
    this.override = config;
    this.configError = undefined;
    this.apply(config);
  }

  reloadConfig(): void {
    this.configError = undefined;
    noteConfigChanged(this.rootDir); // `testFiles` too (the adapters' TestFileMatcher)
    if (this.override) {
      this.apply(this.override);
      return;
    }
    const file = configFileOf(this.rootDir);
    this.configName = path.basename(file);
    let config: ClassifierConfig = {};
    if (fs.existsSync(file)) {
      try {
        config = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))) as ClassifierConfig;
      } catch (e) {
        this.configError = `${this.configName}: ${(e as Error).message}`;
      }
    }
    this.apply(config);
  }

  private apply(config: ClassifierConfig): void {
    this.rings = config.dependencyRule && typeof config.dependencyRule === 'object' ? config.dependencyRule : DEFAULT_DEPENDENCY_RULE;
    this.assocNames = config.associationNames === 'all' ? 'all' : 'non-obvious';
    this.smart = config.smartExpand && typeof config.smartExpand === 'object' ? config.smartExpand : undefined;
    this.findings = config.findings && typeof config.findings === 'object' ? config.findings : undefined;
    const hintGlobs = Array.isArray(config.layerHints?.ignore) ? config.layerHints!.ignore.filter((g): g is string => typeof g === 'string' && g.length > 0) : [];
    this.hintIgnored = hintGlobs.length ? picomatch(hintGlobs, { dot: true }) : undefined;
    this.hintGlobs = hintGlobs;
    const keepGlobs = Array.isArray(config.unreachable?.ignore) ? config.unreachable!.ignore.filter((g): g is string => typeof g === 'string' && g.length > 0) : [];
    this.unreachableIgnore = keepGlobs.length ? picomatch(keepGlobs, { dot: true }) : undefined;
    this.pipeline = config.pipeline && typeof config.pipeline === 'object' ? config.pipeline : undefined;
    this.isTestFile = picomatch(Array.isArray(config.testFiles) ? config.testFiles.filter((g) => typeof g === 'string') : DEFAULT_TEST_FILE_GLOBS, { dot: true });
    this.explicitOrder = Array.isArray(config.layerOrder) ? config.layerOrder.filter((x): x is string => typeof x === 'string') : undefined;
    const compile = (rules: LayerRule[]): CompiledLayer[] =>
      rules
        .filter((l) => l && typeof l.name === 'string')
        .map((l) => ({
          name: l.name,
          test: picomatch(toArray(l.match), { dot: true }),
          globs: toArray(l.match).map((glob) => ({ glob, test: picomatch(glob, { dot: true }) })),
        }));
    this.layers = compile(config.layers ?? []);
    const preset = presetOf(this.rootDir, config.preset);
    this.presetLayers = preset ? compile(preset.layers) : [];
    this.presetLabel = preset?.label;
    this.presetNoLayer = (preset?.noLayer ?? []).map((n) => ({ segment: n.segment, test: picomatch(n.match, { dot: true }) }));
    this.presetFallback = preset?.fallback ? compile(preset.fallback) : [];
    this.presetShared = preset?.shared;
    // the preset's own dependency rule (FSD) unless the project gives one
    if (!(config.dependencyRule && typeof config.dependencyRule === 'object') && preset?.dependencyRule) this.rings = preset.dependencyRule;
    this.rules = [];
    for (const r of config.stereotypes ?? []) {
      if (!r || typeof r.stereotype !== 'string' || !r.match) continue;
      try {
        const m = r.match;
        const criteria = [
          m.name !== undefined ? `name \`${m.name}\`` : '',
          m.path !== undefined ? `path \`${m.path}\`` : '',
          m.decorator !== undefined ? `decorator \`${m.decorator}\`` : '',
          m.implements !== undefined ? `implements \`${m.implements}\`` : '',
        ].filter(Boolean);
        this.rules.push({
          stereotype: r.stereotype,
          describe: `rule ${config.stereotypes!.indexOf(r) + 1} in ${this.configName}${criteria.length ? `: ${criteria.join(', ')}` : ''}`,
          name: r.match.name !== undefined ? new RegExp(r.match.name) : undefined,
          path: r.match.path !== undefined ? picomatch(r.match.path, { dot: true }) : undefined,
          decorator: r.match.decorator,
          implements: r.match.implements !== undefined ? new RegExp(r.match.implements) : undefined,
        });
      } catch (e) {
        this.configError = `${this.configName}: invalid rule for "${r.stereotype}": ${(e as Error).message}`;
      }
    }
    this.disableBuiltins = !!config.disableBuiltinStereotypes;
  }

  associationNames(): 'non-obvious' | 'all' {
    return this.assocNames;
  }

  smartExpandConfig(): SmartExpandConfig | undefined {
    return this.smart;
  }

  findingsConfig(): FindingsConfig | undefined {
    return this.findings;
  }

  pipelineConfig(): PipelineConfig | undefined {
    return this.pipeline;
  }

  projectRoot(): string {
    return this.rootDir;
  }

  /** FR-31.4 `unreachable.ignore` names the method: its file (relative path) or `Class.method`. */
  unreachableIgnored(relPath: string, qualifiedName: string): boolean {
    return !!this.unreachableIgnore && (this.unreachableIgnore(relPath) || this.unreachableIgnore(qualifiedName));
  }

  /** FR-7.11 the file's layer hint is silenced by `layerHints.ignore`. */
  layerHintIgnored(relPath: string): boolean {
    return !!this.hintIgnored && this.hintIgnored(relPath);
  }

  layerHintIgnores(): string[] {
    return this.hintGlobs;
  }

  layerRing(layer: string): number | undefined {
    const r = this.rings[layer];
    return typeof r === 'number' && Number.isFinite(r) ? r : undefined;
  }

  /**
   * Display order of layers (bands, lanes), independent of rule order — rules are ordered by
   * matching priority (a "Move to layer" rule goes first), which must not reorder the picture.
   * `layerOrder` in the config wins; otherwise the built-in architectural order, with custom
   * layer names inserted after the layer that precedes them in the configured rules.
   */
  layerOrder(): string[] {
    if (this.explicitOrder?.length) {
      const order = [...this.explicitOrder];
      for (const n of [...this.layers.map((l) => l.name), ...BUILTIN_LAYERS.map((l) => l.name)]) if (!order.includes(n)) order.push(n);
      return order;
    }
    const order = BUILTIN_LAYERS.map((l) => l.name);
    const configured = [...new Set(this.layers.map((l) => l.name))];
    configured.forEach((name, i) => {
      if (order.includes(name)) return;
      const before = configured.slice(0, i).reverse().find((n) => order.includes(n));
      order.splice(before ? order.indexOf(before) + 1 : 0, 0, name);
    });
    return order;
  }

  classify(ref: ClassRef, info: ClassInfo | undefined, usage: UsageContext = {}): Classification {
    if (ref.kind === 'external') return { stereotypes: ['external'], namespace: 'external' };
    if (ref.kind === 'unknown') return { stereotypes: ['unknown'], namespace: 'unknown' };
    const relPath = ref.key.includes('#') ? ref.key.slice(0, ref.key.indexOf('#')) : '';
    const dir = path.posix.dirname(relPath);
    const namespace = dir === '.' ? '' : dir;
    const { layer, reason } = this.layerOf(relPath, dir, ref);
    const test = reason.rule === 'test';

    const matched = this.rules.filter((r) => matchesRule(r, ref, info, relPath));
    const found: StereotypeReason[] = [];
    // a test class says so, first; its folder (`tests/Unit/Services/`) is no role
    if (test) found.push({ stereotype: 'test', text: reason.text });
    // folder-derived roles are the weakest signal: dropped when a configured rule matched
    if (!this.disableBuiltins) found.push(...builtinStereotypes(ref, info, usage, dir, matched.length === 0 && !test));
    found.push(...matched.map((m) => ({ stereotype: m.stereotype, text: m.describe })));
    // one reason per stereotype (the first source found)
    const reasons = found.filter((f, i) => found.findIndex((x) => x.stereotype === f.stereotype) === i);
    return { stereotypes: reasons.map((f) => f.stereotype), layer, namespace, layerReason: reason, stereotypeReasons: reasons };
  }

  /**
   * Configured rules → explicit layer folders (an inbound-adapter folder inside `infrastructure/` →
   * Presentation) → entry files → name hints → role folders (innermost first). FR-7.8: also why —
   * the rule that decided and the earlier ones that did not apply.
   */
  private layerOf(relPath: string, dir: string, ref: ClassRef): { layer?: string; reason: LayerReason } {
    const notApplied: string[] = [];
    const noted: string[] = [];
    const decided = (layer: string | undefined, rule: LayerReason['rule'], text: string, strength: LayerReason['strength'], folders?: string[]) => ({
      layer,
      reason: { rule, text, strength, notApplied, ...(noted.length ? { noted } : {}), ...(relPath ? { path: relPath } : {}), ...(folders?.length ? { folders } : {}) },
    });
    for (const [i, l] of this.layers.entries()) {
      if (!l.test(relPath)) continue;
      // the rule matches when one of its globs does
      const glob = l.globs.find((g) => g.test(relPath))!.glob;
      return decided(l.name, 'config', `rule ${i + 1} in ${this.configName}: \`${glob}\``, 'strong');
    }
    notApplied.push(this.layers.length ? `no rule in ${this.configName} matches` : `no layer rules in ${this.configName}`);
    // test code is in no layer: its folders (`tests/Unit/Services/`) say what it tests, not what it is
    if (relPath && this.isTestFile(relPath)) return decided(undefined, 'test', `test code (\`testFiles\` in ${this.configName}, or the defaults: \`tests/\`, \`*.test.*\`, …)`, 'strong');
    // FR-7.11 the framework's conventional folders
    const presetRule = (l: CompiledLayer, strength: LayerReason['strength']) => {
      const glob = l.globs.find((g) => g.test(relPath))!.glob;
      const folders = glob.replace(/\/\*\*$/, '').split('/');
      return decided(l.name, 'preset', `${this.presetLabel} preset: \`${glob}\``, strength, folders.slice(-1));
    };
    for (const l of this.presetLayers) if (l.test(relPath)) return presetRule(l, 'strong');
    // a note (·), not a miss (✗): the preset recognised the file and gives it no layer on purpose — its code decides
    const note = (line: string) => {
      notApplied.push(line);
      noted.push(line);
    };
    const helper = this.presetNoLayer.find((n) => n.test(relPath));
    // FSD's shared code outside its segments (`shared/store`, `shared/i18n`) has no layer of its own either
    const sharedSegment = this.presetShared && relPath.startsWith(this.presetShared) ? relPath.slice(this.presetShared.length).split('/')[0] : undefined;
    if (helper) note(`${this.presetLabel} preset: \`${helper.segment}/\` is helper code, no layer of its own`);
    else {
      for (const l of this.presetFallback) if (l.test(relPath)) return presetRule(l, 'weak');
      if (sharedSegment && relPath.length > this.presetShared!.length + sharedSegment.length) note(`${this.presetLabel} preset: \`shared/${sharedSegment}/\` is shared code, no layer of its own`);
      else if (this.presetLabel) notApplied.push(`no ${this.presetLabel} preset folder`);
    }
    const original = pathSegments(dir).reverse();
    const segments = original.map((s) => s.toLowerCase());
    for (const [i, seg] of segments.entries()) {
      const hit = BUILTIN_LAYERS.find((l) => l.explicit.includes(seg));
      if (!hit) continue;
      if (hit.name === 'Infrastructure' && isInboundAdapter(segments.slice(0, i), ref)) {
        const k = segments.slice(0, i).findIndex((s) => INBOUND_ADAPTER_FOLDERS.includes(s));
        return decided('Presentation', 'inbound-adapter', `inbound adapter folder \`${original[k]}/\` inside \`${original[i]}/\``, 'strong', [original[i], original[k]]);
      }
      return decided(hit.name, 'folder', `layer folder \`${original[i]}/\``, 'strong', [original[i]]);
    }
    notApplied.push('no layer folder (presentation, application, domain, infrastructure, …) in the path');
    if (isEntryFile(relPath, dir)) return decided('Presentation', 'entry-file', `entry file \`${path.posix.basename(relPath)}\` (composition root)`, 'strong');
    if (ref.kind === 'class' || ref.kind === 'module') {
      for (const [re, layer] of LAYER_NAME_HINTS) {
        const m = re.exec(ref.name);
        if (m) return decided(layer, 'name', `name ends in \`${m[1]}\``, 'weak');
      }
      notApplied.push('the name gives no hint (…Client, …Gateway, …Controller, …)');
    } else notApplied.push(`no name hint for ${ref.kind === 'interface' ? 'an interface' : 'an abstract class'} (usually a port: its folder decides)`);
    // the preset recognised the file and gave no layer on purpose: its folders (FSD's `pages/`, `ui/`) are no roles here
    if (noted.length) return decided(undefined, 'none', 'no rule applies', 'weak');
    for (const [i, seg] of segments.entries()) {
      const hit = BUILTIN_LAYERS.find((l) => l.folders.includes(seg));
      if (hit) return decided(hit.name, 'role-folder', `role folder \`${original[i]}/\``, 'weak', [original[i]]);
    }
    notApplied.push('no role folder (services, controllers, models, repositories, …)');
    return decided(undefined, 'none', 'no rule applies', 'weak');
  }
}

/** FR-7.6 / FR-7.9 the built-in stereotypes, each with the reason it was added. */
function builtinStereotypes(
  ref: ClassRef,
  info: ClassInfo | undefined,
  usage: UsageContext,
  dir: string,
  useFolderRoles: boolean,
): StereotypeReason[] {
  const out: StereotypeReason[] = [];
  const add = (stereotype: string, text: string, extra: Partial<StereotypeReason> = {}) => out.push({ stereotype, text, ...extra });
  if (ref.kind === 'interface') add('interface', 'it is an interface');
  if (ref.kind === 'abstract') add('abstract', 'it is an abstract class');
  if (ref.kind === 'module') add('module', 'a module (file-level functions), not a class');
  if (info?.localFunctions) add('locals', 'its function defines local helper functions');
  if (usage.staticAccess) add('static', 'called statically in this diagram', { inThisDiagram: true });
  else if (info?.allMembersStatic) add('static', 'all its members are static');
  if (info?.hasStaticInstance) add('singleton', 'it holds a static instance of itself');
  else if (info?.isExportedInstance) add('singleton', 'the module exports one instance of it');

  if (ref.kind !== 'module') {
    const roles = new Map<string, StereotypeReason>();
    for (const [re, role] of ROLE_SUFFIXES) {
      const m = re.exec(ref.name);
      if (m && !roles.has(role)) roles.set(role, { stereotype: role, text: `name ends in \`${m[0]}\`` });
    }
    for (const d of info?.decorators ?? []) {
      const role = ROLE_DECORATORS[d];
      if (role && !roles.has(role)) roles.set(role, { stereotype: role, text: `decorator \`${d}\`` });
    }
    if (roles.size === 0 && useFolderRoles) {
      const segments = pathSegments(dir).reverse();
      const seg = segments.find((s) => ROLE_FOLDERS[s.toLowerCase()]);
      if (seg) {
        const role = ROLE_FOLDERS[seg.toLowerCase()];
        roles.set(role, { stereotype: role, text: `folder \`${seg}/\` (only the folder name decided)`, weak: true });
      }
    }
    out.push(...roles.values());
  }
  if (usage.injectedAsAbstraction) add('seam', 'reached through an injected interface or abstract class in this diagram', { inThisDiagram: true });
  // FR-6.7 last on the line: the first part a long line cuts (the tooltip keeps it)
  if (usage.containerSingleton && !out.some((r) => r.stereotype === 'singleton')) add('singleton', 'the DI container makes it once (registered as a singleton)');
  return out;
}

function matchesRule(rule: CompiledRule, ref: ClassRef, info: ClassInfo | undefined, relPath: string): boolean {
  if (rule.name && !rule.name.test(ref.name)) return false;
  if (rule.path && !rule.path(relPath)) return false;
  if (rule.decorator && !(info?.decorators ?? []).includes(rule.decorator.replace(/^@/, ''))) return false;
  if (rule.implements) {
    const supers = [...(info?.implements ?? []), ...(info?.extends ? [info.extends] : [])];
    if (!supers.some((s) => rule.implements!.test(s.name))) return false;
  }
  return true;
}

const ENTRY_NAMES = new Set(['main', 'index', 'program', 'startup', 'server', 'app', 'cli']);
const SOURCE_ROOTS = new Set(['src', 'lib', 'app', 'source', 'bin']);

/**
 * FR-7.3: the composition root — the entry point that wires the application together and drives
 * it (outermost ring, Presentation): `main` / `index` / `program` / `startup` / `server` / `app` /
 * `cli` files at the project root or directly in a source root (`src/`, `lib/`, …); C# `Program.cs`
 * and `Startup.cs` in any project folder.
 */
function isEntryFile(relPath: string, dir: string): boolean {
  const file = path.posix.basename(relPath);
  // no extension (dot -1) or a dotfile (0): the "extension" is no source extension, the base no entry name
  const dot = file.lastIndexOf('.');
  const base = file.slice(0, dot).toLowerCase();
  const ext = file.slice(dot + 1).toLowerCase();
  if (ext === 'cs') return base === 'program' || base === 'startup';
  if (!/^[mc]?[jt]sx?$/.test(ext) || !ENTRY_NAMES.has(base)) return false;
  return dir === '.' || SOURCE_ROOTS.has(path.posix.basename(dir).toLowerCase());
}

/** Folder segments, also split on `.` (dotted project folders such as `Billing.Infrastructure`). */
/**
 * `infrastructure/http/…`: an inbound adapter (routes, controllers) — unless something below says
 * outbound (`clients/`, a `…Client` / `…Gateway` name). `below` = the folders under `infrastructure`.
 */
function isInboundAdapter(below: string[], ref: ClassRef): boolean {
  if (!below.some((s) => INBOUND_ADAPTER_FOLDERS.includes(s))) return false;
  if (below.some((s) => OUTBOUND_ADAPTER_FOLDERS.includes(s))) return false;
  const outboundName = LAYER_NAME_HINTS.find(([, layer]) => layer === 'Infrastructure')![0];
  return !(ref.kind !== 'interface' && outboundName.test(ref.name));
}

function pathSegments(dir: string): string[] {
  return dir === '.' ? [] : dir.split(/[/.]/).filter(Boolean);
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Allows // and /* *\/ comments in the config file. */
export function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
}

export function createClassifier(projectRoot: string): Classifier {
  return new DefaultClassifier(projectRoot);
}
