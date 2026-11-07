/**
 * FR-34 the memory report's text, shared by hosts: one line per loaded project, and a one-line summary.
 */
import type { ProcessMemory } from '@seqcall/protocol';

export interface ProjectMemory {
  /** The project folder's name. */
  name: string;
  language: 'typescript' | 'csharp' | 'php';
  analysis?: ProcessMemory;
  base?: ProcessMemory;
}

const LANGUAGE: Record<ProjectMemory['language'], string> = { typescript: 'TypeScript', csharp: 'C#', php: 'PHP' };

export const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** The bytes the projects' own processes hold (analysis and base versions). */
export function processBytes(projects: ProjectMemory[]): number {
  return projects.reduce((sum, p) => sum + (p.analysis?.workingSet ?? 0) + (p.base?.workingSet ?? 0), 0);
}

/**
 * One line per project. `inHost`: what to say about analysis that runs inside the host's own process (VS Code: the
 * extension host, shared with other extensions).
 */
export function memoryLines(projects: ProjectMemory[], inHost: string): string[] {
  if (!projects.length) return ['No project loaded.'];
  return projects.map((p) => {
    const head = `${p.name} (${LANGUAGE[p.language]})`;
    if (p.language !== 'csharp') return `${head}: ${inHost}`;
    const a = p.analysis;
    const analysis = a ? `C# analysis ${megabytes(a.workingSet)}${a.managedHeap ? ` (managed heap ${megabytes(a.managedHeap)})` : ''}, pid ${a.pid}` : 'C# analysis not running';
    return `${head}: ${analysis}${p.base ? `; base version for the review ${megabytes(p.base.workingSet)}, pid ${p.base.pid}` : ''}`;
  });
}

/** The notification's line: what the analysis processes hold, or that none runs. */
export function memorySummary(projects: ProjectMemory[]): string {
  const running = projects.filter((p) => p.analysis || p.base);
  if (!running.length) return 'No analysis process is running (TypeScript and PHP are analysed inside the editor\'s process).';
  return `The C# analysis holds ${megabytes(processBytes(running))} (${running.length} project${running.length === 1 ? '' : 's'}).`;
}
