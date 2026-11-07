import * as vscode from 'vscode';
import type { CallPathStep, EntryPoint, Finding, FindingKind, HostToSequenceView, ProjectFinding, ReviewIssue, ReviewMethod, ReviewResult, StructureRow } from '@seqcall/protocol';
import { displayRoute } from '@seqcall/core';

/**
 * FR-19.12 / FR-24.14 the Seqcall sidebar's Design Issues and Review views: the lists of the panel's ⌂ menu
 * that stay in sight while working. Nothing runs by itself — the views start empty (a welcome with the button),
 * the scan / review runs on request, and a result the panel asked for shows here too. A row opens what the
 * panel's row opens (the flow with the evidence, the flow down to a changed method, a file).
 */

type ScanMsg = Extract<HostToSequenceView, { type: 'projectFindings' }>;
type ReviewMsg = Extract<HostToSequenceView, { type: 'review' }>;

/** What a row runs: an intent of the sequence view (sent through the controller), or opening a file. */
export type SidebarAction = { kind: 'intent'; msg: Parameters<SidebarActions['run']>[0] } | { kind: 'file'; path: string };

export interface SidebarActions {
  run(msg: { type: 'openFinding'; entryPoint: EntryPoint; finding: ProjectFinding['finding'] } | { type: 'openReviewIssue'; issue: ReviewIssue } | { type: 'openReviewStructure'; row: StructureRow } | { type: 'openPath'; steps: CallPathStep[]; entryPoint?: EntryPoint }): void;
}

export interface SidebarNode {
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  /** Children (a group); absent: a row. */
  children?: SidebarNode[];
  /** A group open at first. */
  expanded?: boolean;
  action?: SidebarAction;
  id?: string;
}

/** The common tree of both views: nodes in, tree items out; a click runs the node's action. */
abstract class SidebarTree implements vscode.TreeDataProvider<SidebarNode> {
  protected readonly changed = new vscode.EventEmitter<SidebarNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  /** The line on top of the list (the view's message). */
  message: string | undefined;

  constructor(protected readonly onUpdate: () => void) {}

  protected abstract roots(): SidebarNode[];

  getTreeItem(n: SidebarNode): vscode.TreeItem {
    const item = new vscode.TreeItem(n.label, n.children ? (n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    if (n.description) item.description = n.description;
    if (n.tooltip) item.tooltip = n.tooltip;
    if (n.icon) item.iconPath = new vscode.ThemeIcon(n.icon);
    if (n.id) item.id = n.id;
    if (n.action) item.command = { command: 'seqcall.sidebarOpen', title: 'Open', arguments: [n.action] };
    return item;
  }

  getChildren(n?: SidebarNode): SidebarNode[] {
    return n ? (n.children ?? []) : this.roots();
  }

  protected update(): void {
    this.changed.fire(undefined);
    this.onUpdate();
  }
}

// one icon per kind (the codicon nearest the panel's glyph ⟳ ◆ ∞ ⇅ ◉ ⧉ ⚠), not ⚠ for all
const GROUPS: { kind: FindingKind; title: string; icon: string }[] = [
  { kind: 'io-in-loop', title: 'I/O in loops (N+1)', icon: 'sync' },
  { kind: 'io-in-domain', title: 'I/O in Domain', icon: 'database' },
  { kind: 'cyclic-collaboration', title: 'Cyclic collaborations', icon: 'references' },
  { kind: 'dependency-cycle', title: 'Dependency cycles', icon: 'references' },
  { kind: 'layer-ping-pong', title: 'Layer ping-pong', icon: 'arrow-both' },
  { kind: 'god-class', title: 'God classes', icon: 'symbol-class' },
  { kind: 'too-many-dependencies', title: 'Too many dependencies', icon: 'type-hierarchy-sub' },
  // the flow's ⚠, the map and Review list them too — one per class pair
  { kind: 'layer-violation', title: 'Layer violations', icon: 'warning' },
];

/** FR-7.16 a layer violation resting on a guessed layer says so, with the guesses on hover. */
const issueTitle = (f: Finding): string => (f.possible ? f.title.replace(/^Layer violation/, 'Possible layer violation') : f.title);
const issueTip = (f: Finding): string[] => [issueTitle(f), f.detail ?? '', ...(f.possible ?? [])];

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** `GET /users/{id}`, `CLI orders:expire`, `TEST OrderTest.it_works`. */
export function entryText(e: EntryPoint): string {
  const kind: Record<EntryPoint['kind'], string> = { http: '', route: 'ROUTE ', ui: 'UI ', cli: 'CLI ', job: 'JOB ', handler: 'HANDLER ', test: 'TEST ' };
  // FR-19.23 a method no entry point reaches (scanned as if it were one)
  if (e.unreached) return `${e.label} (${e.unreachedWhy ?? 'no entry point reaches it'})`;
  return `${kind[e.kind]}${e.kind === 'http' ? displayRoute(e.label) : e.label}`; // as in the panel
}

/** FR-19.12 the project-wide design issues (FR-19.9) as a list in the sidebar. */
export class DesignIssuesTree extends SidebarTree {
  private state: ScanMsg | undefined;

  /** Running / done / … — for the title bar's buttons. */
  status(): ScanMsg['state'] | undefined {
    return this.state?.state;
  }

  onMessage(m: ScanMsg): void {
    // progress keeps the last result's project; a new result replaces everything
    this.state = { ...m, project: m.project ?? this.state?.project };
    const s = this.state;
    this.message =
      s.state === 'running'
        ? `Scanning ${s.project ?? 'the project'}… ${s.total ? `${s.done ?? 0} / ${s.total} flows` : ''}`.trim()
        : s.state === 'done'
          ? `${s.project ?? 'project'} · ${plural(s.findings?.length ?? 0, 'issue')} in ${plural(s.total ?? 0, 'entry point')}${s.unreached?.scanned ? ` and ${plural(s.unreached.scanned, 'method')} no flow opened` : ''}${s.truncated ? ` · ${s.truncated} cut by the expand limit` : ''}`
          : s.state === 'cancelled'
            ? 'Scan cancelled.'
            : s.state === 'error'
              ? (s.error ?? 'The scan failed.')
              : undefined;
    this.update();
  }

  protected roots(): SidebarNode[] {
    const s = this.state;
    if (!s || s.state !== 'done') return []; // the welcome (not scanned yet) or the message says it
    const findings = s.findings ?? [];
    if (!findings.length) return [{ label: s.total === 0 ? 'No entry points to scan (a library?)' : 'No design issues found', icon: 'pass' }];
    return GROUPS.map((g) => ({ g, list: findings.filter((f) => f.finding.kind === g.kind) }))
      .filter((x) => x.list.length)
      .map(({ g, list }) => ({
        label: g.title,
        description: String(list.length),
        icon: g.icon,
        expanded: true,
        id: `di:${g.kind}`,
        children: list.map((f) => ({
          label: issueTitle(f.finding),
          description: `${entryText(f.entryPoint)}${f.others ? ` +${f.others} more` : ''}`,
          tooltip: [...issueTip(f.finding), `Found in ${entryText(f.entryPoint)}${f.others ? ` (and ${f.others} more entry points)` : ''}`].join('\n'),
          icon: 'circle-small-filled',
          id: `di:${f.finding.id}:${f.entryPoint.method.key}`,
          action: { kind: 'intent', msg: { type: 'openFinding', entryPoint: f.entryPoint, finding: f.finding } },
        })),
      }));
  }
}

const methodName = (m: ReviewMethod) => (m.method.owner.kind === 'module' ? m.method.name : `${m.method.owner.name}.${m.method.name}`);
const where = (i: ReviewIssue) => (i.at ? `${i.at.file.replace(/^.*\//, '')}:${i.at.line}` : 'in a changed class');
/** FR-29 a structure row's words (as the panel's). */
const STRUCTURE_NOUN: Record<string, string> = { edge: 'dependency', violation: 'layer violation', entry: 'entry point', io: 'I/O kind', client: 'I/O client', cycle: 'cycle' };
const structureWhat = (row: StructureRow): string => {
  if (row.kind === 'layer-changed') return 'class changed layer';
  if (row.kind === 'role-changed') return 'class changed role';
  // FR-7.16 resting on a guessed layer
  const noun = `${row.possible ? 'possible ' : ''}${STRUCTURE_NOUN[row.kind.replace(/-(added|removed)$/, '')]}`;
  const level = row.kind.startsWith('io') || row.kind.startsWith('client') ? ' in the layer' : row.kind.startsWith('edge') || row.kind.startsWith('cycle') ? (row.level === 'package' ? ' between packages' : ' between layers') : '';
  return row.kind.endsWith('-added') ? `new ${noun}${level}` : `${noun}${level} removed`;
};
const structureTitle = (row: StructureRow): string => (row.kind.startsWith('entry') && row.entryPoint ? entryText(row.entryPoint) : row.title);

/** FR-24.14 the branch review (FR-24) as a list in the sidebar. */
export class ReviewTree extends SidebarTree {
  private state: ReviewMsg | undefined;

  status(): ReviewMsg['state'] | undefined {
    return this.state?.state;
  }

  result(): ReviewResult | undefined {
    return this.state?.state === 'done' ? this.state.result : undefined;
  }

  onMessage(m: ReviewMsg): void {
    this.state = m;
    const r = m.result;
    this.message =
      m.state === 'running'
        ? `${m.phase ?? 'Reviewing'}…${m.total ? ` ${m.done ?? 0} / ${m.total}` : ''}`
        : m.state === 'done' && r
          ? `${r.branch ?? 'HEAD'} vs ${r.base} · ${plural(r.methods.length, 'changed method')} · ${plural(r.issues.length, 'issue')}${r.structure ? (r.structure.rows.length ? ` · ${plural(r.structure.rows.length, 'structural change')}` : ' · shape unchanged') : ''}${r.reused ? ' · nothing changed since' : ''}`
          : m.state === 'cancelled'
            ? 'Review cancelled.'
            : m.state === 'error'
              ? (m.error ?? 'The review failed.')
              : undefined;
    this.update();
  }

  /** End review: back to the welcome. */
  clear(): void {
    this.state = undefined;
    this.message = undefined;
    this.update();
  }

  protected roots(): SidebarNode[] {
    const r = this.result();
    if (!r) return [];
    if (!r.files.length) return [{ label: 'No changes in this project', description: r.compare?.outside.length ? `${r.compare.outside.length} outside it` : undefined, icon: 'info' }];
    const out: SidebarNode[] = [];
    // FR-29 Level 0 first: what the branch did to the shape (the panel's Structure group)
    if (r.structure?.rows.length) {
      const st = r.structure;
      out.push({
        label: 'Structure',
        description: `${st.rows.length}${st.notCompared ? ` · ${st.notCompared} not compared` : ''}`,
        tooltip: `What the branch changed in the shape: dependencies and cycles between layers / packages, I/O kinds and clients per layer, layer violations, classes that changed layer or role, entry points — over every entry point's flow, compared with the base${st.notCompared ? `\n${plural(st.notCompared, 'affected entry point')} not compared (limit)` : ''}`,
        icon: 'type-hierarchy',
        expanded: true,
        id: 'rv:structure',
        children: st.rows.map((row, k) => {
          const openable = !!row.entryPoint && row.kind !== 'entry-removed';
          const from = row.entryPoint && !row.kind.startsWith('entry') ? ` · ← ${entryText(row.entryPoint)}` : '';
          return {
            label: structureTitle(row),
            description: `${structureWhat(row)}${row.detail ? ` · ${row.detail}` : ''}${from}`,
            tooltip: [structureTitle(row), `${structureWhat(row)}${row.detail ? `: ${row.detail}` : ''}`, ...(row.pairs?.length ? [row.pairs.map((p) => `${p.fromName} → ${p.toName}`).join('\n')] : []), openable ? (row.level === 'layer' ? 'Opens the flow zoomed to layers, at this call' : 'Opens the flow at this call') : 'Only the base has it: nothing to open'].join('\n'),
            icon: row.kind === 'layer-changed' || row.kind === 'role-changed' ? 'diff-renamed' : row.kind.endsWith('-added') ? 'diff-added' : 'diff-removed',
            id: `rv:structure:${k}:${row.kind}:${row.title}`,
            ...(openable ? { action: { kind: 'intent' as const, msg: { type: 'openReviewStructure' as const, row } } } : {}),
          };
        }),
      });
    } else if (r.structure) out.push({ label: 'No structural change', description: 'same layers, packages, violations and entry points as the base', icon: 'pass', id: 'rv:structure' });
    if (r.issues.length) {
      out.push({
        label: 'Issues',
        description: String(r.issues.length),
        icon: 'warning',
        expanded: true,
        id: 'rv:issues',
        children: r.issues.map((i, k) => ({
          label: issueTitle(i.finding),
          description: `${where(i)}${i.entryPoint ? ` · ← ${entryText(i.entryPoint)}` : ''}`,
          tooltip: [...issueTip(i.finding), i.where === 'changed-lines' ? 'Its evidence is on a changed line.' : 'In a class the branch changed.'].filter(Boolean).join('\n'),
          icon: i.where === 'changed-lines' ? 'error' : 'warning',
          id: `rv:issue:${k}:${i.finding.id}`,
          action: { kind: 'intent', msg: { type: 'openReviewIssue', issue: i } },
        })),
      });
    }
    // entry points with the changed methods they reach (most first), as in the panel
    const reached = new Map<string, { entryPoint: EntryPoint; methods: { m: ReviewMethod; steps: CallPathStep[] }[] }>();
    for (const m of r.methods) {
      for (const x of m.reachedFrom) {
        const id = `${x.entryPoint.kind}|${x.entryPoint.label}`;
        const g = reached.get(id) ?? { entryPoint: x.entryPoint, methods: [] };
        g.methods.push({ m, steps: x.steps });
        reached.set(id, g);
      }
    }
    const methodRow = (m: ReviewMethod, steps: CallPathStep[], entryPoint: EntryPoint | undefined, id: string): SidebarNode => ({
      label: methodName(m),
      description: `${m.status} · ${plural(m.lines.length, 'line')}${m.tests ? ` · ${plural(m.tests, 'test')}` : ' · no test calls it'}`,
      tooltip: entryPoint ? 'Open the flow from the entry point, expanded down to this method' : 'Open its diagram',
      icon: m.status === 'added' ? 'diff-added' : 'diff-modified',
      id,
      action: { kind: 'intent', msg: entryPoint ? { type: 'openPath', steps, entryPoint } : { type: 'openPath', steps } },
    });
    if (reached.size) {
      out.push({
        label: 'Entry points affected',
        description: String(reached.size),
        icon: 'debug-start',
        expanded: true,
        id: 'rv:reached',
        children: [...reached.values()]
          .sort((a, b) => b.methods.length - a.methods.length)
          .map((g, k) => ({
            label: entryText(g.entryPoint),
            description: plural(g.methods.length, 'changed method'),
            tooltip: `${g.entryPoint.label} — its changed methods below; a method opens the flow down to it`,
            icon: 'symbol-event',
            id: `rv:ep:${k}:${g.entryPoint.label}`,
            children: g.methods.map(({ m, steps }, j) => methodRow(m, steps, g.entryPoint, `rv:ep:${k}:${j}`)),
          })),
      });
    }
    const unreached = r.methods.filter((m) => !m.reachedFrom.length && !m.notWalked);
    if (unreached.length) {
      out.push({
        label: 'Changed, no static caller',
        description: String(unreached.length),
        tooltip: 'Called dynamically (container, untyped factory), by the framework, or not yet',
        icon: 'question',
        id: 'rv:unreached',
        children: unreached.map((m, k) => methodRow(m, [{ methodKey: m.method.key }], undefined, `rv:un:${k}`)),
      });
    }
    const notWalked = r.methods.filter((m) => m.notWalked);
    if (notWalked.length) {
      out.push({
        label: 'Changed, callers not walked (limit)',
        description: String(notWalked.length),
        tooltip: 'Too many changed methods: who reaches these is unknown',
        icon: 'question',
        id: 'rv:notwalked',
        children: notWalked.map((m, k) => methodRow(m, [{ methodKey: m.method.key }], undefined, `rv:nw:${k}`)),
      });
    }
    return out;
  }
}
