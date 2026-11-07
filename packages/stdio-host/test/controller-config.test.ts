import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessController } from '../src/controller';
import { lastRender, positionOf, recordingSink, sampleAppCopy, shopProject, type Recorded } from './controller-helpers';

// Explicit user actions that write the project's .seqcall.json (FR-7.5, FR-7.11, FR-12.16, FR-19.10)
// through the HeadlessController, on a copy of fixtures/sample-app: the file, the log, the re-render; a file that
// cannot be written; a borrowed config (FR-25.3) that must not be written.

const CONFIG = '.seqcall.json';
let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups) await f();
  cleanups = [];
});

async function openedCopy(): Promise<{ c: HeadlessController; r: Recorded; root: string; config: string }> {
  const p = sampleAppCopy();
  const r = recordingSink();
  const c = new HeadlessController(r.sink, { workspace: p.root });
  cleanups.push(async () => {
    await c.dispose();
    fs.chmodSync(p.root, 0o755);
    if (fs.existsSync(p.file(CONFIG)) && fs.statSync(p.file(CONFIG)).isFile()) fs.chmodSync(p.file(CONFIG), 0o644);
    p.rm();
  });
  const file = p.file('src/controllers/user-controller.ts');
  await c.openAt(file, positionOf(file, 'this.validate(id);'));
  return { c, r, root: p.root, config: p.file(CONFIG) };
}

const layerOf = (r: Recorded, className: string) => lastRender(r.seq).participants.find((p) => p.className === className)?.layer;
const renders = (r: Recorded) => r.seq.filter((m) => m.type === 'render').length;

describe('HeadlessController: config writes', () => {
  it('FR-7.5 / FR-7.12 a layer for a class file or a scope glob is written and the diagram re-rendered; a library class has no file to match', async () => {
    const { c, r, config } = await openedCopy();
    expect(layerOf(r, 'UserService')).toBe('Application');
    await c.onSequenceMessage({ type: 'setLayer', classKey: 'src/services/user-service.ts#UserService', className: 'UserService', layer: 'Domain' });
    expect(JSON.parse(fs.readFileSync(config, 'utf8')).layers.find((l: { name: string }) => l.name === 'Domain').match).toContain('src/services/user-service.ts');
    expect(layerOf(r, 'UserService')).toBe('Domain');
    await c.onClassMessage({ type: 'setLayer', classKey: 'src/util/logger.ts#Logger', className: 'Logger', layer: 'Infrastructure', match: 'src/util/**' });
    expect(layerOf(r, 'Logger')).toBe('Infrastructure');
    expect(r.logs('info')).toEqual([`layer: src/services/user-service.ts → Domain (${CONFIG})`, `layer: src/util/** → Infrastructure (${CONFIG})`]);
    const text = fs.readFileSync(config, 'utf8');
    const count = renders(r);
    await c.onSequenceMessage({ type: 'setLayer', classKey: 'lib:node#console', className: 'console', layer: 'Domain' });
    expect(fs.readFileSync(config, 'utf8')).toBe(text);
    expect(renders(r)).toBe(count);
  });

  it('FR-19.10 / FR-7.11 ignore patterns from either view are added to the config, logged, and re-rendered', async () => {
    const { c, r, config } = await openedCopy();
    const count = renders(r);
    await c.onSequenceMessage({ type: 'ignoreFinding', pattern: 'UserService.findUser' });
    await c.onClassMessage({ type: 'ignoreFinding', pattern: 'Logger' });
    await c.onSequenceMessage({ type: 'ignoreLayerHint', pattern: 'src/util/**' });
    await c.onClassMessage({ type: 'ignoreLayerHint', pattern: 'src/legacy/**' });
    const json = JSON.parse(fs.readFileSync(config, 'utf8'));
    expect(json.findings.ignore).toEqual(['UserService.findUser', 'Logger']);
    expect(json.layerHints.ignore).toEqual(['src/util/**', 'src/legacy/**']);
    expect(r.logs('info')).toEqual([
      `findings.ignore += UserService.findUser (${CONFIG})`,
      `findings.ignore += Logger (${CONFIG})`,
      `layerHints.ignore += src/util/** (${CONFIG})`,
      `layerHints.ignore += src/legacy/** (${CONFIG})`,
    ]);
    expect(renders(r)).toBe(count + 4); // the config reloaded each time
  });

  it('FR-19.22 the diagrams list what is ignored; Stop ignoring from either view takes it out, logged and re-rendered', async () => {
    const { c, r, config } = await openedCopy();
    await c.onSequenceMessage({ type: 'ignoreFinding', pattern: 'UserService.findUser' });
    await c.onSequenceMessage({ type: 'ignoreLayerHint', pattern: 'src/util/**' });
    expect(lastRender(r.seq).ignored).toEqual({ findings: ['UserService.findUser'], layerHints: ['src/util/**'] });
    await c.onClassMessage({ type: 'ready' });
    const cls = r.cls.filter((m) => m.type === 'render').at(-1);
    expect(cls?.type === 'render' && cls.diagram.ignored).toEqual({ findings: ['UserService.findUser'], layerHints: ['src/util/**'] });
    const count = renders(r);
    await c.onClassMessage({ type: 'unignoreFinding', pattern: 'UserService.findUser' });
    expect(lastRender(r.seq).ignored).toEqual({ layerHints: ['src/util/**'] });
    await c.onSequenceMessage({ type: 'unignoreLayerHint', pattern: 'src/util/**' });
    expect(lastRender(r.seq).ignored).toBeUndefined();
    const json = JSON.parse(fs.readFileSync(config, 'utf8'));
    expect([json.findings.ignore, json.layerHints.ignore]).toEqual([[], []]);
    expect(r.logs('info').slice(-2)).toEqual([`findings.ignore -= UserService.findUser (${CONFIG})`, `layerHints.ignore -= src/util/** (${CONFIG})`]);
    expect(renders(r)).toBe(count + 2);
    // no config file at all: nothing to take out, nothing written
    fs.rmSync(config);
    await c.onSequenceMessage({ type: 'unignoreFinding', pattern: 'Logger' });
    expect(fs.existsSync(config)).toBe(false);
    expect(renders(r)).toBe(count + 2);
  });

  it('FR-12.16 "Adjust the rule" adds the default dependency rule once and opens the config at it', async () => {
    const { c, r, config } = await openedCopy();
    const first = renders(r);
    await c.onSequenceMessage({ type: 'openDependencyRule' });
    expect(renders(r)).toBe(first + 1); // the config read again: re-rendered
    const text = fs.readFileSync(config, 'utf8');
    const line = text.split('\n').findIndex((l) => l.includes('"dependencyRule"'));
    expect(line).toBeGreaterThan(0);
    const at = { line, character: 0 };
    expect(r.other.filter((o) => o.kind === 'navigate')).toEqual([{ kind: 'navigate', arg: { file: config, start: at, end: at } }]);
    expect(r.logs('info')).toEqual([`dependencyRule: the default added to ${CONFIG}`]);
    // there now: opened, not written again
    const count = renders(r);
    await c.onClassMessage({ type: 'openDependencyRule' });
    expect(fs.readFileSync(config, 'utf8')).toBe(text);
    expect(r.other.filter((o) => o.kind === 'navigate')).toHaveLength(2);
    expect(r.logs('info')).toHaveLength(1);
    expect(renders(r)).toBe(count);
  });

  it('FR-7.5 / FR-7.11 / FR-12.16 / FR-19.10 a config that cannot be written: logged, nothing re-rendered, nothing opened', async () => {
    const { c, r, config } = await openedCopy();
    const text = fs.readFileSync(config, 'utf8');
    fs.chmodSync(config, 0o444);
    const count = renders(r);
    await c.onSequenceMessage({ type: 'setLayer', classKey: 'src/services/user-service.ts#UserService', className: 'UserService', layer: 'Domain' });
    await c.onSequenceMessage({ type: 'ignoreFinding', pattern: 'Logger' });
    await c.onSequenceMessage({ type: 'ignoreLayerHint', pattern: 'src/util/**' });
    await c.onSequenceMessage({ type: 'openDependencyRule' });
    await c.onSequenceMessage({ type: 'unignoreFinding', pattern: 'Logger' });
    expect(r.logs('error')).toEqual(Array(5).fill(`cannot write ${config}: EACCES: permission denied, open '${config}'`));
    expect(r.logs('info')).toEqual([]);
    expect(fs.readFileSync(config, 'utf8')).toBe(text);
    expect(renders(r)).toBe(count);
    expect(r.other.some((o) => o.kind === 'navigate')).toBe(false);
    // a read-only config that has the rule already: only opened (nothing to write)
    fs.chmodSync(config, 0o644);
    fs.writeFileSync(config, JSON.stringify({ dependencyRule: { rings: [] } }, null, 2));
    fs.chmodSync(config, 0o444);
    await c.onSequenceMessage({ type: 'openDependencyRule' });
    expect(r.logs('error')).toHaveLength(5);
    expect(r.other.filter((o) => o.kind === 'navigate')).toEqual([{ kind: 'navigate', arg: { file: config, start: { line: 1, character: 0 }, end: { line: 1, character: 0 } } }]);
  });

  it('FR-12.16 a config that cannot be read (a folder of that name) is reported like a failed write, not thrown', async () => {
    const { c, r, config } = await openedCopy();
    fs.rmSync(config);
    fs.mkdirSync(config);
    await c.onSequenceMessage({ type: 'openDependencyRule' });
    await c.onSequenceMessage({ type: 'ignoreFinding', pattern: 'Logger' });
    expect(r.logs('error')).toEqual([`cannot write ${config}: EISDIR: illegal operation on a directory, read`, `cannot write ${config}: EISDIR: illegal operation on a directory, read`]);
    expect(r.other.some((o) => o.kind === 'navigate')).toBe(false);
  });

  it('FR-25.3 while a shared diagram\'s layer config is in use no config write happens, from either view', async () => {
    const { c, r, config } = await openedCopy();
    await c.onSequenceMessage({ type: 'copyState' });
    const copied = r.seq.at(-1)!;
    if (copied.type !== 'diagramState' || !copied.text) throw new Error(JSON.stringify(copied));
    const json = JSON.parse(copied.text);
    json.config = JSON.stringify({ layers: [{ name: 'Borrowed', match: ['src/services/**'] }] });
    await c.onSequenceMessage({ type: 'openState', text: JSON.stringify(json) });
    await c.onSequenceMessage({ type: 'useSharedConfig', on: true });
    expect(layerOf(r, 'UserService')).toBe('Borrowed');
    const text = fs.readFileSync(config, 'utf8');
    await c.onSequenceMessage({ type: 'openDependencyRule' });
    await c.onClassMessage({ type: 'ignoreFinding', pattern: 'Logger' });
    await c.onClassMessage({ type: 'ignoreLayerHint', pattern: 'src/util/**' });
    await c.onClassMessage({ type: 'setLayer', classKey: 'src/util/logger.ts#Logger', className: 'Logger', layer: 'Domain' });
    await c.onClassMessage({ type: 'unignoreFinding', pattern: 'Logger' });
    expect(fs.readFileSync(config, 'utf8')).toBe(text);
    expect(r.logs('error')).toEqual(Array(5).fill(`the shared diagram's layer config is in use: ${CONFIG} not changed (Back to my config first)`));
    expect(r.other.some((o) => o.kind === 'navigate')).toBe(false);
  });

  it('FR-7.5 / FR-7.11 / FR-12.16 / FR-19.10 a project without a config: each action creates it with just its own entry', async () => {
    const p = shopProject();
    const r = recordingSink();
    const c = new HeadlessController(r.sink, { workspace: p.root });
    cleanups.push(async () => {
      await c.dispose();
      p.rm();
    });
    const file = p.file('src/presentation/orders.controller.ts');
    await c.openAt(file, positionOf(file, 'return new OrderService().place()'));
    const config = p.file(CONFIG);
    const created = () => {
      const json = JSON.parse(fs.readFileSync(config, 'utf8'));
      fs.rmSync(config);
      return json;
    };
    await c.onSequenceMessage({ type: 'setLayer', classKey: 'src/domain/order.ts#Order', className: 'Order', layer: 'Core' });
    expect(created()).toEqual({ layers: [{ name: 'Core', match: ['src/domain/order.ts'] }] });
    await c.onSequenceMessage({ type: 'ignoreFinding', pattern: 'Order' });
    expect(created()).toEqual({ findings: { ignore: ['Order'] } });
    await c.onSequenceMessage({ type: 'ignoreLayerHint', pattern: 'src/domain/**' });
    expect(created()).toEqual({ layerHints: { ignore: ['src/domain/**'] } });
    await c.onSequenceMessage({ type: 'openDependencyRule' });
    expect(Object.keys(created())).toEqual(['dependencyRule']);
    expect(r.other.filter((o) => o.kind === 'navigate').map((o) => (o.arg as { start: { line: number } }).start.line)).toEqual([1]);
  });
});
