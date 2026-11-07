import { describe, expect, it } from 'vitest';
import type { SequenceDiagram } from '@seqcall/protocol';
import { tsProject } from './ts-project';

// FR-3.12 these tests check the frames and calls as the code has them: ↯ Fold errors off

// FR-1.10 / FR-1.15 frames whose operand starts or ends at an early exit (a guard's `return`), in the object diagram
// and one level up (FR-28.4): Shop (Application) calling its Repo (Infrastructure), every call crossing the layers.
const frames = (d: SequenceDiagram) => (d.fragments ?? []).map((f) => `${f.id} [${f.operands.map((o) => `${o.guard}] ${o.firstMessageId}..${o.lastMessageId}`).join(' | ')}${f.collapsed ? ' (minimized)' : ''}`);
const exits = (d: SequenceDiagram) => (d.exits ?? []).map((e) => `${e.id} before ${e.beforeId ?? 'the end'}`);

function shop(body: string) {
  return tsProject({
    '.seqcall.json': JSON.stringify({ layers: [{ name: 'Application', match: ['src/app/**'] }, { name: 'Infrastructure', match: ['src/infra/**'] }] }),
    'src/infra/repo.ts': `export class Repo {\n  load(id: string) { return id; }\n  save(id: string) { return id; }\n  log(id: string) { return id; }\n}\n`,
    'src/app/shop.ts': `import { Repo } from '../infra/repo';\nexport class Shop {\n  private repo = new Repo();\n  checkout(id: string, a: boolean, b: boolean, c: boolean, xs: string[]) {\n${body}\n  }\n}\n`,
  });
}

describe('FR-1.15 frames starting or ending at an early exit', () => {
  it('FR-1.10 a frame that starts at a guard\'s returns keeps its place after the frames above it, also one level up', async () => {
    const p = shop(['    if (id) {', '      this.repo.load(id);', '    }', '    if (a) {', '      if (b) return;', '      if (c) return;', '      if (!xs) return;', '      this.repo.save(id);', '    }'].join('\n'));
    const s = p.session();
    await s.setOption('foldErrors', false);
    const d = (await s.openMethod(await p.method('src/app/shop.ts#Shop.checkout')))!;
    expect(d.messages.map((m) => m.id)).toEqual(['root', 'root/0:load', 'root/1:save']);
    // in source order: `if (id)`, then `if (a)`, which starts at its three returns
    expect(frames(d)).toEqual(['root#opt0@0 [id] root/0:load..root/0:load', 'root#opt0@1 [a] root!exit0..root/1:save']);
    expect(exits(d)).toEqual(['root!exit0 before root!exit1', 'root!exit1 before root!exit2', 'root!exit2 before root/1:save']);
    // FR-28.4 one level up (every call crosses): the same frames, each return still drawn before the next one
    const z = (await s.setOption('layerZoom', true))!;
    expect([frames(z), exits(z)]).toEqual([frames(d), exits(d)]);
  });
});

// one level up the self-call place() folds into checkout: its frames move to the root, its exits are not drawn
const PLACE = (body: string[]) =>
  ['    this.place(id, a, b, c, xs);', '    this.repo.log(id);', '  }', '  private place(id: string, a: boolean, b: boolean, c: boolean, xs: string[]) {', '    this.repo.load(id);', ...body].join('\n');

describe('FR-28.4 one level up: frames of a folded method that start or end at its early exits', () => {
  it('FR-28.4 an operand starting at a run of returns spans the calls after them, one ending at a return at the end of the method stops there', async () => {
    const p = shop(PLACE(['    if (a) {', '      if (b) return;', '      if (c) return;', '      this.repo.save(id);', '    }', '    if (b) {', '      this.repo.log(id);', '      return;', '    }', '    const n = id.length;']));
    const s = p.session();
    await s.setOption('foldErrors', false);
    await s.openMethod(await p.method('src/app/shop.ts#Shop.checkout'));
    const d = (await s.expand('root/0:place'))!;
    expect(frames(d)).toEqual(['root/0:place#opt0@1 [a] root/0:place!exit0..root/0:place/1:save', 'root/0:place#opt0@2 [b] root/0:place/2:log..root/0:place!exit2']);
    expect(exits(d)).toEqual(['root/0:place!exit0 before root/0:place!exit1', 'root/0:place!exit1 before root/0:place/1:save', 'root/0:place!exit2 before the end']);
    const z = (await s.setOption('layerZoom', true))!;
    expect(z.messages.map((m) => `${m.id} ${m.parentId}`)).toEqual(['root null', 'root/0:place/0:load root', 'root/0:place/1:save root', 'root/0:place/2:log root', 'root/1:log root']);
    // the frames hold the drawn calls between the exits: not load() before them, not checkout's log() after place()
    expect(frames(z)).toEqual(['root/0:place#opt0@1 [a] root/0:place/1:save..root/0:place/1:save', 'root/0:place#opt0@2 [b] root/0:place/2:log..root/0:place/2:log']);
    expect(z).not.toHaveProperty('exits');
  });

  it('FR-28.4 an operand starting at a return drawn before a minimized frame spans the calls after that frame', async () => {
    const p = shop(PLACE(['    if (a) {', '      if (b) return;', '      for (const x of xs) {', '        this.repo.log(x);', '      }', '      this.repo.save(id);', '    }']));
    const s = p.session();
    await s.setOption('foldErrors', false);
    await s.openMethod(await p.method('src/app/shop.ts#Shop.checkout'));
    const d = (await s.expand('root/0:place'))!;
    const loop = d.fragments!.find((f) => f.kind === 'loop')!.id;
    const m = (await s.collapseFragment(loop))!;
    expect(frames(m)).toEqual([`root/0:place#opt0@1 [a] root/0:place!exit0..root/0:place/2:save`, `${loop} [each x of xs] ${loop}..${loop} (minimized)`]);
    expect(exits(m)).toEqual([`root/0:place!exit0 before ${loop}`]);
    const z = (await s.setOption('layerZoom', true))!;
    expect(frames(z)).toEqual(['root/0:place#opt0@1 [a] root/0:place/2:save..root/0:place/2:save']);
  });
});
