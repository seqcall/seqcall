import * as path from 'node:path';

/** Absolute path with forward slashes (the protocol's path convention). */
export function normalizePath(file: string): string {
  return path.resolve(file).replace(/\\/g, '/');
}

/** Path relative to the project root with forward slashes, e.g. "src/services/user-service.ts". */
export function relativePath(projectRoot: string, file: string): string {
  return path.relative(projectRoot, file).replace(/\\/g, '/');
}

export function isUnder(projectRoot: string, file: string): boolean {
  const rel = relativePath(projectRoot, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isInNodeModules(file: string): boolean {
  return /[\\/]node_modules[\\/]/.test(file);
}

/**
 * Package name of a file inside node_modules ("express", "@scope/pkg"); `@types/x` maps to "x".
 * Returns undefined for files outside node_modules.
 */
export function packageNameOf(file: string): string | undefined {
  const m = /(?:^|[\n\r\u2028\u2029]).*[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(file);
  if (!m) return undefined;
  const name = m[1].replace(/\\/g, '/');
  if (name.startsWith('@types/')) {
    const inner = name.slice('@types/'.length);
    // @types/scope__pkg -> @scope/pkg
    return inner.includes('__') ? `@${inner.replace('__', '/')}` : inner;
  }
  return name;
}

/** Display name of a module participant: file base name, or the folder name for index files. */
export function moduleNameOf(relPath: string): string {
  const base = path.posix.basename(relPath).replace(/\.(d\.)?[cm]?[jt]sx?$/, '');
  if (base === 'index') {
    // relPath is relative (a project file), so the folder is '.' at the root, never ''
    const dir = path.posix.basename(path.posix.dirname(relPath));
    return dir !== '.' ? dir : base;
  }
  return base;
}

export const SOURCE_FILE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
