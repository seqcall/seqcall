import { applyEdits, findNodeAtLocation, modify, parse, parseTree, type FormattingOptions } from 'jsonc-parser/lib/esm/main.js'; // ESM build: the UMD default uses runtime-relative requires that break bundling
import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { LayerScope } from '@seqcall/protocol';
import { CONFIG_FILE_NAME, DEFAULT_DEPENDENCY_RULE } from './classifier-impl';

export { CONFIG_FILE_NAME };

const FORMAT: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };

/**
 * The text to edit: `{}` for none, else the file — when it holds a JSON object (or nothing yet, only comments). A
 * config that is `null`, an array or a single value cannot take a setting without losing what it holds: a clear
 * error instead (the hosts show it as "cannot write …").
 */
function editable(text: string | undefined): string {
  const src = text && text.trim() ? text : '{}\n';
  const value: unknown = parse(src);
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`${CONFIG_FILE_NAME} does not hold a JSON object (${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}); fix it by hand first`);
  }
  return src;
}

interface LayerRuleJson {
  name?: unknown;
  match?: unknown;
}

/**
 * Puts the file at `relPath` (relative to the project root, forward slashes) into `layer` by
 * adding `{ "name": layer, "match": [relPath] }` at the front of `layers` in
 * `.seqcall.json` — first rule wins, so it overrides broader rules. An existing rule
 * that matches exactly this one path is replaced. Comments and formatting are preserved
 * (jsonc-parser). `text` undefined/empty creates a new config.
 */
export function setFileLayer(text: string | undefined, relPath: string, layer: string): string {
  return setLayerRule(text, relPath, layer);
}

/**
 * FR-7.12 the same for any glob (`app/Managers/**`, `**\/*Manager.php`): `{ "name": layer, "match": [glob] }` at the
 * front of `layers` (first rule wins); an existing rule for exactly this glob is replaced.
 */
export function setLayerRule(text: string | undefined, relPath: string, layer: string): string {
  let src = editable(text);
  const config = (parse(src) ?? {}) as { layers?: LayerRuleJson[] };
  const layers = Array.isArray(config.layers) ? config.layers : [];
  // Drop earlier single-path rules for this file (highest index first keeps indices valid).
  for (let i = layers.length - 1; i >= 0; i--) {
    const m = layers[i]?.match;
    if (Array.isArray(m) && m.length === 1 && m[0] === relPath) src = applyEdits(src, modify(src, ['layers', i], undefined, { formattingOptions: FORMAT }));
  }
  const rule = { name: layer, match: [relPath] };
  const hasLayers = Array.isArray((parse(src) as { layers?: unknown } | undefined)?.layers);
  const edits = hasLayers
    ? modify(src, ['layers', 0], rule, { formattingOptions: FORMAT, isArrayInsertion: true })
    : modify(src, ['layers'], [rule], { formattingOptions: FORMAT });
  const out = applyEdits(src, edits);
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * FR-19.10 silences a finding: appends `pattern` (a `Class.method` / class-name glob) to `findings.ignore`
 * in `.seqcall.json`, keeping comments and formatting; no duplicate. `text` undefined/empty creates
 * a new config.
 */
export function addFindingIgnore(text: string | undefined, pattern: string): string {
  const src = editable(text);
  const config = (parse(src) ?? {}) as { findings?: { ignore?: unknown } };
  const ignore = Array.isArray(config.findings?.ignore) ? (config.findings!.ignore as unknown[]) : undefined;
  if (ignore?.includes(pattern)) return src;
  const edits = ignore
    ? modify(src, ['findings', 'ignore', ignore.length], pattern, { formattingOptions: FORMAT, isArrayInsertion: true })
    : modify(src, ['findings', 'ignore'], [pattern], { formattingOptions: FORMAT });
  const out = applyEdits(src, edits);
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * FR-7.11 silences a layer hint: appends `pattern` (a file glob relative to the project root) to `layerHints.ignore`
 * in `.seqcall.json`, keeping comments and formatting; no duplicate. `text` undefined/empty creates a config.
 */
export function addLayerHintIgnore(text: string | undefined, pattern: string): string {
  const src = editable(text);
  const config = (parse(src) ?? {}) as { layerHints?: { ignore?: unknown } };
  const ignore = Array.isArray(config.layerHints?.ignore) ? (config.layerHints!.ignore as unknown[]) : undefined;
  if (ignore?.includes(pattern)) return src;
  const edits = ignore
    ? modify(src, ['layerHints', 'ignore', ignore.length], pattern, { formattingOptions: FORMAT, isArrayInsertion: true })
    : modify(src, ['layerHints', 'ignore'], [pattern], { formattingOptions: FORMAT });
  const out = applyEdits(src, edits);
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * FR-19.22 Stop ignoring: removes `pattern` from `findings.ignore` / `layerHints.ignore`, keeping comments and
 * formatting; the text unchanged when the pattern is not there.
 */
export function removeIgnore(text: string | undefined, section: 'findings' | 'layerHints', pattern: string): string | undefined {
  const config = (parse(text ?? '') ?? {}) as Record<string, { ignore?: unknown } | undefined>;
  const ignore = config[section]?.ignore;
  const at = Array.isArray(ignore) ? ignore.indexOf(pattern) : -1;
  if (at < 0) return text;
  const out = applyEdits(text!, modify(text!, [section, 'ignore', at], undefined, { formattingOptions: FORMAT }));
  return out.endsWith('\n') ? out : `${out}\n`;
}

/** Relative path of the file declaring a class/module key (`<relPath>#<Name>`). */
export function relPathOfKey(classKey: string): string | undefined {
  const i = classKey.indexOf('#');
  return i > 0 && !classKey.startsWith('lib:') ? classKey.slice(0, i) : undefined;
}

/**
 * FR-12.16 "Adjust the rule" on a layer violation: the config with a `dependencyRule` (the default one,
 * added when missing — `text` undefined/empty creates a new config) and the 0-based line of that key, to
 * open the file there. `changed`: the text was edited (the host writes it, with Undo).
 */
export function ensureDependencyRule(text: string | undefined): { text: string; line: number; changed: boolean } {
  let src = editable(text);
  const has = (parse(src) as { dependencyRule?: unknown } | undefined)?.dependencyRule !== undefined;
  if (!has) {
    src = applyEdits(src, modify(src, ['dependencyRule'], DEFAULT_DEPENDENCY_RULE, { formattingOptions: FORMAT }));
    if (!src.endsWith('\n')) src += '\n';
  }
  const node = findNodeAtLocation(parseTree(src)!, ['dependencyRule']);
  // the property (its key: the value's parent); none in a broken config (`"dependencyRule": }`): the top of the file
  const offset = node ? node.parent!.offset : 0;
  const line = src.slice(0, offset).split('\n').length - 1;
  return { text: src, line, changed: !has };
}


const SKIP = new Set(['vendor', 'node_modules', '.git', 'bin', 'obj', 'dist', 'build', 'storage', '.idea', '.vscode']);

/** Files below `dir` (relative paths from `root`) with the extension `ext`; `vendor/` only when `dir` is inside it. */
function filesWithExt(root: string, dir: string, ext: string): string[] {
  const out: string[] = [];
  const visit = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && depth < 30) visit(child, depth + 1);
      } else if (e.isFile() && e.name.endsWith(ext)) out.push(child);
    }
  };
  visit(dir, 0);
  return out;
}

/**
 * FR-7.12 the scopes "Move to layer" offers for a class: its file, its folder and up to two folders above it (all files
 * there, below too; not the top level such as `app/`), and —
 * when the file is named after the class (PHP, C#) and the name ends in a role word — every class named like it
 * (`OrderManager` → `**\/*Manager.php`, within the same first-party package for a file in `vendor/`). Counted on disk.
 */
export function layerScopes(projectRoot: string, classKey: string, className: string): LayerScope[] {
  const rel = relPathOfKey(classKey);
  if (!rel) return [];
  const ext = path.posix.extname(rel);
  const dir = path.posix.dirname(rel);
  const out: LayerScope[] = [{ kind: 'file', glob: rel, files: 1 }];
  // its folder and the folders above it, down to the second level (`app/Managers/`; inside a package, below its own folder)
  const parts = dir === '.' ? [] : dir.split('/');
  const floor = rel.startsWith('vendor/') ? 4 : 2;
  for (let n = parts.length; n >= floor && out.length < 4; n--) {
    const folder = parts.slice(0, n).join('/');
    out.push({ kind: 'folder', glob: `${folder}/**`, files: filesWithExt(projectRoot, folder, ext).length });
  }
  if (parts.length && parts.length < floor) out.push({ kind: 'folder', glob: `${dir}/**`, files: filesWithExt(projectRoot, dir, ext).length });
  // a folder holding only this file says nothing more than the file
  for (let i = out.length - 1; i > 0; i--) if (out[i].kind === 'folder' && out[i].files <= 1) out.splice(i, 1);
  const suffix = /[a-z0-9]([A-Z][a-z0-9]+)$/.exec(className)?.[1];
  if (suffix && suffix.length > 2 && path.posix.basename(rel, ext) === className) {
    const pkg = /^(vendor\/[^/]+\/[^/]+)\//.exec(rel)?.[1];
    const glob = `${pkg ? `${pkg}/` : ''}**/*${suffix}${ext}`;
    const match = picomatch(glob, { dot: true });
    const files = filesWithExt(projectRoot, pkg ?? '', ext).filter((f) => match(f)).length;
    if (files > 1) out.push({ kind: 'name', glob, files });
  }
  return out;
}
