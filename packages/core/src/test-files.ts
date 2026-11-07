import * as fs from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import { configFileOf, type ClassifierConfig, DEFAULT_TEST_FILE_GLOBS, stripJsonComments } from './classifier-impl';
import { configGeneration } from './config-generation';

export { DEFAULT_TEST_FILE_GLOBS } from './classifier-impl';

/**
 * Decides whether a project-relative path is test code: `testFiles` from `.seqcall.json`
 * (replacing the defaults when given), re-read when the config file changes.
 */
export class TestFileMatcher {
  private stamp = '';
  private test: (relPath: string) => boolean = picomatch(DEFAULT_TEST_FILE_GLOBS, { dot: true });
  /** When the config file was last looked at (ms), and the root's config generation then. */
  private checkedAt = Number.NEGATIVE_INFINITY;
  private generation = -1;

  constructor(
    private readonly projectRoot: string,
    /** How long a look at the config file holds (ms): an edit of `testFiles` counts from then on. */
    private readonly recheckMs = 2000,
  ) {}

  isTest(relPath: string): boolean {
    this.refresh();
    let hit = this.answers.get(relPath);
    if (hit === undefined) {
      hit = this.test(relPath);
      this.answers.set(relPath, hit);
    }
    return hit;
  }

  /** Answers per path while the globs stay the same (the glob match itself is slow in long scans). */
  private answers = new Map<string, boolean>();

  private refresh(): void {
    // a stat per question is slow in long scans: the PHP implementation search asks for every candidate class —
    // the file is looked at again after `recheckMs`, or at once when the config was reloaded (saved)
    const now = performance.now();
    const generation = configGeneration(this.projectRoot);
    if (now - this.checkedAt < this.recheckMs && generation === this.generation) return;
    this.checkedAt = now;
    this.generation = generation;
    const file = configFileOf(this.projectRoot);
    let stamp = 'none';
    try {
      const st = fs.statSync(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      stamp = 'none';
    }
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    let globs = DEFAULT_TEST_FILE_GLOBS;
    if (stamp !== 'none') {
      try {
        const config = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8'))) as ClassifierConfig;
        if (Array.isArray(config.testFiles)) globs = config.testFiles.filter((g) => typeof g === 'string');
      } catch {
        // invalid config: the classifier reports it; keep the defaults
      }
    }
    // an empty list matches nothing (picomatch's array matcher returns false when no glob matches)
    this.test = picomatch(globs, { dot: true });
    this.answers = new Map();
  }
}
