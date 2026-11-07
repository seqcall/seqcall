import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DiffTarget, HostToClassView, HostToSequenceView, Position, SequenceDiagram } from '@seqcall/protocol';
import { vi } from 'vitest';
import { DiagramSession } from '@seqcall/core';
import type { HostSink } from '../src/controller';

// Shared by the HeadlessController tests (controller-*.test.ts): a sink that records what the host receives, temp
// projects, positions in source text.

export const REPO = path.resolve(__dirname, '../../..').replace(/\\/g, '/');
export const SAMPLE_APP = `${REPO}/fixtures/sample-app`;

export function positionOf(file: string, needle: string): Position {
  const text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not in ${file}`);
  const before = text.slice(0, at).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

export interface Recorded {
  sink: HostSink;
  seq: HostToSequenceView[];
  cls: HostToClassView[];
  /** navigate / showClassDiagram / openDiff / log:<level> / progress, in order. */
  other: { kind: string; arg?: unknown }[];
  logs(level: 'info' | 'error'): string[];
}

/** `diff`: the host has a diff viewer (Rider); without it a reviewed call's file opens at the line. */
export function recordingSink(opts: { diff?: boolean } = {}): Recorded {
  const seq: HostToSequenceView[] = [];
  const cls: HostToClassView[] = [];
  const other: { kind: string; arg?: unknown }[] = [];
  const sink: HostSink = {
    postSequence: (m) => seq.push(m),
    postClass: (m) => cls.push(m),
    navigate: (range) => other.push({ kind: 'navigate', arg: range }),
    showClassDiagram: () => other.push({ kind: 'showClassDiagram' }),
    log: (level, message) => other.push({ kind: `log:${level}`, arg: message }),
    progress: (title) => other.push({ kind: 'progress', arg: title }),
    ...(opts.diff ? { openDiff: (target: DiffTarget, keepFocus?: boolean) => other.push({ kind: 'openDiff', arg: { target, keepFocus } }) } : {}),
  };
  const logs = (level: 'info' | 'error') => other.filter((o) => o.kind === `log:${level}`).map((o) => String(o.arg));
  return { sink, seq, cls, other, logs };
}

export function lastRender(msgs: HostToSequenceView[]): SequenceDiagram {
  const r = msgs.filter((m) => m.type === 'render').pop();
  if (!r || r.type !== 'render') throw new Error(`no render in ${JSON.stringify(msgs.map((m) => m.type))}`);
  return r.diagram;
}

/** A temp folder (forward slashes) with `files` written; `rm()` removes it. */
export function tempProject(prefix: string, files: Record<string, string> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `seqcall-${prefix}-`)).replace(/\\/g, '/');
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
    return `${root}/${rel}`;
  };
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  return { root, put, file: (rel: string) => `${root}/${rel}`, rm: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** A copy of fixtures/sample-app in a temp folder (config writes and file edits stay out of the fixture). */
export function sampleAppCopy() {
  const p = tempProject('sample');
  fs.cpSync(SAMPLE_APP, p.root, { recursive: true, filter: (src) => !src.includes('node_modules') });
  return p;
}

export const TSCONFIG = JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false, types: [] }, include: ['src'] });

/**
 * FR-17.5 the background I/O scans the controller starts after each render (it does not wait for them): `settled()`
 * waits for those started so far, so a test counts posts without a late badge render in between. Restored by
 * `vi.restoreAllMocks()`.
 */
export function trackScans() {
  const scans: Promise<unknown>[] = [];
  const scan = DiagramSession.prototype.scanSideEffects;
  vi.spyOn(DiagramSession.prototype, 'scanSideEffects').mockImplementation(function (this: DiagramSession) {
    const p = scan.call(this);
    scans.push(p.catch(() => undefined));
    return p;
  });
  return { settled: async () => void (await Promise.all(scans)), started: () => scans.length };
}

/**
 * A small layered shop (made-up): three HTTP endpoints, a Domain → Infrastructure call (a layer violation, FR-19), the
 * layers from the folder names. `files` adds or replaces files.
 */
export function shopProject(prefix = 'shop', files: Record<string, string> = {}) {
  return tempProject(prefix, {
    'tsconfig.json': TSCONFIG,
    'src/decorators.ts': 'export const Controller = (p?: string) => (t: any) => t;\nexport const Get = (p?: string) => (t: any, k: string) => undefined;\n',
    'src/infrastructure/db.ts': 'export class Db {\n  save(x: string) {\n    return x;\n  }\n}\n',
    'src/domain/order.ts': "import { Db } from '../infrastructure/db';\nexport class Order {\n  total() {\n    new Db().save('total');\n    return 1;\n  }\n}\n",
    'src/application/order-service.ts':
      "import { Order } from '../domain/order';\nexport class OrderService {\n  place() {\n    return new Order().total();\n  }\n  list() {\n    return [this.place()];\n  }\n}\n",
    'src/presentation/orders.controller.ts':
      "import { Controller, Get } from '../decorators';\nimport { OrderService } from '../application/order-service';\n@Controller('orders')\nexport class OrdersController {\n  @Get(':id') show() {\n    return new OrderService().place();\n  }\n  @Get('') list() {\n    return new OrderService().list();\n  }\n  @Get('count') count() {\n    return 0;\n  }\n}\n",
    ...files,
  });
}
