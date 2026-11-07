#!/usr/bin/env node
/**
 * Comment rule (AGENTS.md, Conventions): comments say why, not what happened. This finds the parts of the rule a
 * pattern can see — history ("no longer shows"), dates, numbers measured on a run — in comment lines of the
 * project's code (packages/, scripts/; not tests or fixtures). Whether a comment only repeats the code is left to
 * review.
 *
 *   node scripts/check-comments.mjs --staged   lines the staged diff adds (the pre-commit hook; exit 1 on a hit)
 *   node scripts/check-comments.mjs --all      every tracked file (the existing hits)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CODE = /\.(ts|tsx|js|mjs|cjs|cs|kt|kts|lua|vim)$/;
const NOT_CODE = /(?:(?:^|\/)(?:test|tests|__tests__|fixtures|dist|node_modules)\/)|(?:\.test\.)|(?:Tests?\/)|(?:\.d\.ts$)/;

/** Whether the rule applies to a repo-relative path. */
export function checkedFile(path) {
  return /^(packages|scripts)\//.test(path) && CODE.test(path) && !NOT_CODE.test(path);
}

/**
 * The comment part of a source line, or undefined. Lines inside a block comment start with `*`; a `//` after code
 * counts too, but not one in a URL (`http://`). Lua: `--`; Vim script: `#` (Vim9) or `"` (legacy).
 */
export function commentOf(line, path) {
  const s = line.trim();
  if (path.endsWith('.lua')) return s.startsWith('--') ? s.slice(2) : undefined;
  if (path.endsWith('.vim')) return /^["#]/.test(s) ? s.slice(1) : undefined;
  if (/^(\/\/|\/\*|\*(?!\/))/.test(s)) return s.replace(/^(\/{2,3}|\/\*\*?|\*)/, '');
  const trailing = /(?<![:\w])\/\/\s(.*)$/.exec(s);
  return trailing ? trailing[1] : undefined;
}

/** Code spans, quoted examples and XML doc tags are examples of a format, not a statement about the code's past. */
function prose(comment) {
  return comment.replace(/`[^`]*`/g, '``').replace(/"[^"]*"/g, '""').replace(/<c>.*?<\/c>/g, '');
}

export const RULES = [
  {
    kind: 'history',
    // what the code did before: the commit message says that. "no longer exists" (a contract) is fine.
    re: /\b((was|were|did|had) previously|formerly|used to (be|have|show|draw|run|call|return|do|use|read|walk|mark|list)|was (removed|replaced|changed|renamed)|no longer (shows?|draws?|uses?|calls?|runs?|needs?|marks?|lists?|walks?)|(until|before) (now|this change)|old behaviou?r)\b/i,
  },
  // a spec named by its version date (`MCP 2025-06-18`) is no date note
  { kind: 'date', re: /(?<!\b(MCP|spec|version|protocol) )\b20\d\d-[01]\d-[0-3]\d\b/i },
  {
    kind: 'measurement',
    // a number from a run (timings, shares, counts on some project), not a constant the code sets
    re: /\b\d+(\.\d+)?\s?(ms|s) of \d+(\.\d+)?\s?(ms|s)\b|\b(large|real|reference|big) [\w -]{0,30}(app|project|solution|repo|codebase)\b[^.;]*?:\s*(\d|$)|\b(took|measured)\b[^.;]*\d|\bwere repeats\b|\b\d+(\.\d+)?\s?% of the\b/i,
  },
];

/** The rules a comment breaks. */
export function breaks(comment) {
  const p = prose(comment);
  return RULES.filter((r) => r.re.test(p)).map((r) => r.kind);
}

/** Hits in whole files: [{ file, line, kind, text }]. */
export function hitsInFile(path, source) {
  const out = [];
  source.split('\n').forEach((line, i) => {
    const c = commentOf(line, path);
    if (c !== undefined) for (const kind of breaks(c)) out.push({ file: path, line: i + 1, kind, text: line.trim() });
  });
  return out;
}

/** Hits in the lines a unified diff (`git diff -U0`) adds. */
export function hitsInDiff(diff) {
  const out = [];
  let file;
  let line = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l.startsWith('+++ b/') ? l.slice(6) : undefined;
    else if (l.startsWith('@@')) line = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith('+') && file && checkedFile(file)) {
      const c = commentOf(l.slice(1), file);
      if (c !== undefined) for (const kind of breaks(c)) out.push({ file, line, kind, text: l.slice(1).trim() });
      line++;
    } else if (l.startsWith(' ')) line++;
  }
  return out;
}

export function report(hits) {
  return hits.map((h) => `${h.file}:${h.line}  [${h.kind}]  ${h.text.slice(0, 160)}`).join('\n');
}

function main(mode) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (mode === '--all') {
    const hits = git('ls-files').split('\n').filter(checkedFile).flatMap((f) => hitsInFile(f, readFileSync(f, 'utf8')));
    console.log(report(hits));
    console.log(`\n${hits.length} hits`);
    return 0;
  }
  if (mode === '--staged') {
    const hits = hitsInDiff(git('diff', '--cached', '-U0', '--no-color', '--diff-filter=AM'));
    if (!hits.length) return 0;
    console.error(`${report(hits)}\n\nComments say why, not what happened: no history, dates or measured numbers (AGENTS.md, Conventions).\nPut those in the commit message. Skip the check: git commit --no-verify`);
    return 1;
  }
  console.error('usage: check-comments.mjs --staged | --all');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv[2]);
