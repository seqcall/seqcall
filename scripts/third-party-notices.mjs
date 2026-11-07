// THIRD-PARTY-NOTICES.txt for the release packages: the licences of the code they bundle (npm packages inside the
// esbuild bundles, NuGet packages of the C# sidecar). MIT, BSD, Apache-2.0 and EPL-2.0 all require their notice to
// ship with every copy; EPL-2.0 also asks to say where the source is (the "source" of each component).
//
// The esbuild builds record which npm packages ended up in a bundle (saveBundleMeta, in node_modules/.cache); the
// packaging scripts then call writeNotices with the bundles and the C# sidecar folder of their package. A component
// without a licence text, or under a licence not in ALLOWED, stops the build: a new dependency cannot ship unnoticed.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const metaDir = join(repo, 'node_modules/.cache/seqcall-notices');

/** Licences whose terms the packages meet by shipping the notice (and, for EPL-2.0, naming the source). */
export const ALLOWED = ['MIT', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'EPL-2.0'];

const LICENSE_FILE = /^(licen[cs]e|copying)([-.](md|txt|mit))?$/i;
const NOTICE_FILE = /^(notice|third-?party-?notice[\w-]*)(\.(md|txt|rtf))?$/i;

const MIT = (copyright) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/**
 * The licence a package is used under, from its SPDX expression: the first allowed choice of an `OR`, every part of
 * an `AND` allowed. Throws for anything else.
 */
export function chooseLicense(expression, component) {
  const expr = String(expression ?? '').replace(/[()]/g, ' ').trim();
  if (!expr) throw new Error(`${component}: no licence declared`);
  if (/ AND /.test(expr)) {
    const parts = expr.split(/ AND /).map((p) => p.trim());
    if (parts.every((p) => ALLOWED.includes(p))) return parts.join(' AND ');
  } else {
    const choice = expr.split(/ OR /).map((p) => p.trim()).find((p) => ALLOWED.includes(p));
    if (choice) return choice;
  }
  throw new Error(`${component}: licence "${expression}" is not in the allowed list (${ALLOWED.join(', ')}) of scripts/third-party-notices.mjs`);
}

/** The package folder (`…/node_modules/<name>` or `…/node_modules/@scope/<name>`) of a bundled file, if any. */
export function packageDirOf(file) {
  const parts = resolve(file).split(sep);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0 || i + 1 >= parts.length) return undefined;
  return parts.slice(0, i + (parts[i + 1].startsWith('@') ? 3 : 2)).join(sep);
}

/** Records the npm packages an esbuild build (run with `metafile: true`) put into its output, under `name`. */
export function saveBundleMeta(name, result, absWorkingDir = process.cwd()) {
  const dirs = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
      const dir = bytesInOutput > 0 && packageDirOf(join(absWorkingDir, input.replace(/^[a-z-]+:/, '')));
      if (dir) dirs.add(dir);
    }
  }
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, `${name}.json`), JSON.stringify({ packages: [...dirs].sort() }, null, 2));
}

function bundlePackages(name) {
  const file = join(metaDir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`no record of the bundle "${name}": build it first (npm run build -w @seqcall/${name})`);
  return JSON.parse(readFileSync(file, 'utf8')).packages;
}

/**
 * Plain text of a simple RTF document (the notices some NuGet packages carry): paragraphs and text kept; font and
 * colour tables, `{\\* …}` destinations (field instructions, generator) and control words dropped.
 */
export function rtfToText(rtf) {
  let out = '';
  const skip = [false];
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === '{') {
      const ahead = rtf.slice(i + 1, i + 12);
      skip.push(skip.at(-1) || /^\\(\*|fonttbl|colortbl|stylesheet|info)/.test(ahead));
    } else if (ch === '}') skip.pop();
    else if (ch === '\\') {
      const next = rtf[i + 1];
      if ('\\{}'.includes(next)) {
        if (!skip.at(-1)) out += next;
        i++;
      } else if (next === "'") {
        if (!skip.at(-1)) out += String.fromCharCode(parseInt(rtf.slice(i + 2, i + 4), 16));
        i += 3;
      } else {
        const word = /^([a-z]+)(-?\d+)? ?/i.exec(rtf.slice(i + 1));
        if (!word) continue;
        if (!skip.at(-1) && (word[1] === 'par' || word[1] === 'line')) out += '\n';
        if (!skip.at(-1) && word[1] === 'tab') out += '\t';
        i += word[0].length;
      }
    } else if (ch !== '\r' && ch !== '\n' && !skip.at(-1)) out += ch;
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

const read = (file) => {
  const text = readFileSync(file, 'utf8');
  return (/\.rtf$/i.test(file) ? rtfToText(text) : text).replace(/\r\n/g, '\n').trim();
};
const filesIn = (dir, pattern) => (existsSync(dir) ? readdirSync(dir).filter((f) => pattern.test(f)).sort() : []);
const repoUrl = (repository) => {
  const url = typeof repository === 'string' ? repository : repository?.url;
  return url
    ?.replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^(github:)?([\w.-]+\/[\w.-]+)$/, 'https://github.com/$2');
};

/** An npm package as a component: licence id, its licence and notice texts, where its source is. */
export function npmComponent(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const id = `${pkg.name} ${pkg.version}`;
  const licenses = filesIn(dir, LICENSE_FILE).map((f) => read(join(dir, f)));
  if (!licenses.length) throw new Error(`${id}: no licence file in ${dir}`);
  return {
    name: pkg.name,
    version: pkg.version,
    license: chooseLicense(pkg.license ?? pkg.licenses?.map((l) => l.type).join(' OR '), id),
    source: repoUrl(pkg.repository) ?? pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`,
    licenses,
    notices: filesIn(dir, NOTICE_FILE).map((f) => read(join(dir, f))),
  };
}

const tag = (xml, name) => new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`).exec(xml)?.[1].trim();
const attr = (xml, name, attribute) => new RegExp(`<${name}\\s[^>]*${attribute}="([^"]*)"`).exec(xml)?.[1];
const unescapeXml = (s) => s?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/**
 * The NuGet packages whose files a published .NET app ships (its `<app>.deps.json`: packages with runtime, native
 * or resource assets), with their licences from the local NuGet cache. NuGet packages mostly declare an SPDX
 * expression instead of a licence file; for MIT the standard text is written with the package's copyright.
 */
export function nugetComponents(appDir, nugetRoot = process.env.NUGET_PACKAGES || join(homedir(), '.nuget/packages')) {
  const depsFile = filesIn(appDir, /\.deps\.json$/)[0];
  if (!depsFile) throw new Error(`no .deps.json in ${appDir}`);
  const deps = JSON.parse(readFileSync(join(appDir, depsFile), 'utf8'));
  const components = [];
  for (const target of Object.values(deps.targets)) {
    for (const [key, assets] of Object.entries(target)) {
      const library = deps.libraries[key];
      if (library?.type !== 'package' || !(assets.runtime || assets.native || assets.resources)) continue;
      const dir = join(nugetRoot, library.path);
      const nuspecFile = filesIn(dir, /\.nuspec$/)[0];
      if (!nuspecFile) throw new Error(`${key}: not in the NuGet cache ${nugetRoot} (dotnet restore)`);
      const nuspec = readFileSync(join(dir, nuspecFile), 'utf8');
      const [name, version] = key.split('/');
      const type = attr(nuspec, 'license', 'type');
      const license = type === 'expression' ? chooseLicense(tag(nuspec, 'license'), key) : undefined;
      let licenses = type === 'file' ? [read(join(dir, tag(nuspec, 'license')))] : filesIn(dir, LICENSE_FILE).map((f) => read(join(dir, f)));
      if (!licenses.length && license === 'MIT') licenses = [MIT(unescapeXml(tag(nuspec, 'copyright')) || `Copyright (c) the ${name} authors`).trim()];
      if (!licenses.length) throw new Error(`${key}: no licence text (licence "${tag(nuspec, 'license') ?? tag(nuspec, 'licenseUrl')}")`);
      components.push({
        name,
        version,
        license: license ?? chooseLicense(undefined, key),
        source: attr(nuspec, 'repository', 'url') ?? tag(nuspec, 'projectUrl') ?? `https://www.nuget.org/packages/${name}/${version}`,
        licenses,
        notices: filesIn(dir, NOTICE_FILE).map((f) => read(join(dir, f))),
      });
    }
  }
  return components;
}

/** The notices file: a list of the components, then each distinct licence and notice text once. */
export function renderNotices(components) {
  const sorted = [...new Map(components.map((c) => [`${c.name}@${c.version}`, c])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const group = (texts) => {
    const byText = new Map();
    for (const c of sorted) for (const t of texts(c)) byText.set(t, [...(byText.get(t) ?? []), `${c.name} ${c.version}`]);
    return byText;
  };
  const rule = '='.repeat(80);
  const out = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'Seqcall bundles the following third-party components, each under its own licence (Seqcall itself: LICENSE).',
    'Each component is unmodified; its source is at the address given.',
    '',
    ...sorted.map((c) => `- ${c.name} ${c.version} (${c.license}): ${c.source}`),
  ];
  for (const [text, users] of group((c) => c.licenses)) out.push('', rule, `Licence of: ${users.join(', ')}`, rule, '', text);
  for (const [text, users] of group((c) => c.notices)) out.push('', rule, `Notices of: ${users.join(', ')}`, rule, '', text);
  return `${out.join('\n')}\n`;
}

/**
 * Writes the notices of one package: the npm packages of the named esbuild bundles, npm packages copied as they
 * are (`npm`: package names, resolved from the repo root), the NuGet packages of the C# sidecar in `csharp`.
 */
export function writeNotices(outFile, { bundles = [], npm = [], csharp } = {}) {
  const dirs = new Set(bundles.flatMap(bundlePackages));
  for (const name of npm) dirs.add(join(repo, 'node_modules', name));
  const components = [...dirs].map(npmComponent);
  if (csharp && existsSync(csharp)) components.push(...nugetComponents(csharp));
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderNotices(components));
  return components;
}
