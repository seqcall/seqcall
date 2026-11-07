// The release gate on SonarQube Cloud (docs/TESTING.md §10), run by .github/workflows/sonar.yml after both scans:
//   node scripts/sonar.mjs gate <projectKey>…
// Waits until the server has processed the scans (the scanners' report-task.txt files), then fails when a project
// has an open bug, vulnerability or issue of medium severity or higher in the whole code. The gate is checked here,
// not as a server quality gate, so it does not depend on the plan allowing custom gates, and it judges all the code
// (a release after `set-version` would have no "new code" for the built-in gate to judge).
// Env: SONAR_TOKEN, SONAR_HOST_URL (default https://sonarcloud.io).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = (process.env.SONAR_HOST_URL || 'https://sonarcloud.io').replace(/\/$/, '');

/** Where the scanners write the id of the analysis the server still has to process. */
export const REPORT_TASKS = ['.scannerwork/report-task.txt', 'packages/csharp/.sonarqube/out/.sonar/report-task.txt'];

/**
 * The gate as issue searches: open issues that harm reliability or security (any severity), and open issues of
 * medium severity or higher (any quality). Resolved ones (false positive, accepted with a reason) do not count.
 */
export function gateSearches(projectKey) {
  const open = { componentKeys: projectKey, resolved: 'false', ps: '10' };
  return [
    { ...open, impactSoftwareQualities: 'RELIABILITY,SECURITY' },
    { ...open, impactSeverities: 'MEDIUM,HIGH,BLOCKER' },
  ];
}

/** The `ceTaskUrl` of a scanner's report-task.txt (key=value lines). */
export function ceTaskUrl(reportTask) {
  return /^ceTaskUrl=(.+)$/m.exec(reportTask)?.[1].trim();
}

/** One line per issue: rule, file:line, message. */
export function describeIssue(issue) {
  const file = issue.component?.replace(/^[^:]*:/, '') ?? '?';
  return `${issue.rule}  ${file}${issue.line ? `:${issue.line}` : ''}  ${issue.message}`;
}

function fail(message) {
  console.error(`[sonar] ${message}`);
  process.exit(1);
}

async function api(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.SONAR_TOKEN}` } });
  if (!res.ok) fail(`GET ${url}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Waits until the server has processed the analysis of a report-task.txt (it is asynchronous). */
async function waitForTask(url) {
  for (let i = 0; i < 120; i++) {
    const { task } = await api(url);
    if (task.status === 'SUCCESS') return;
    if (task.status === 'FAILED' || task.status === 'CANCELED') fail(`analysis ${task.id} ${task.status}: ${task.errorMessage ?? ''}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  fail(`analysis not processed within 10 minutes: ${url}`);
}

async function gate(projectKeys) {
  if (!process.env.SONAR_TOKEN) fail('SONAR_TOKEN is not set');
  if (!projectKeys.length) fail('usage: node scripts/sonar.mjs gate <projectKey>…');
  for (const file of REPORT_TASKS) {
    const path = join(repo, file);
    const url = existsSync(path) && ceTaskUrl(readFileSync(path, 'utf8'));
    if (url) await waitForTask(url);
  }
  let failed = false;
  for (const key of projectKeys) {
    const seen = new Map();
    for (const params of gateSearches(key)) {
      const { total, issues } = await api(`${host}/api/issues/search?${new URLSearchParams(params)}`);
      if (total) for (const issue of issues) seen.set(issue.key, issue);
      if (total > issues.length) seen.set(`more:${params.impactSeverities ?? 'quality'}`, { more: total - issues.length });
    }
    const dashboard = `${host}/project/issues?id=${encodeURIComponent(key)}&resolved=false`;
    if (!seen.size) {
      console.log(`[sonar] passed  ${key}`);
      continue;
    }
    failed = true;
    console.error(`[sonar] FAILED  ${key}  ${dashboard}`);
    for (const issue of seen.values()) console.error(issue.more ? `  … and ${issue.more} more` : `  ${describeIssue(issue)}`);
  }
  if (failed) fail('release gate failed: fix the issues, or resolve false positives on the server with the reason');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === 'gate') await gate(process.argv.slice(3));
  else fail('usage: node scripts/sonar.mjs gate <projectKey>…');
}
