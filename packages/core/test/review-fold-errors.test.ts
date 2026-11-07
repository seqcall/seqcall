import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SequenceDiagram } from '@seqcall/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

// FR-3.12 / FR-24 a review whose change is in an error branch: Shop.place saves the order, its catch undoes the
// payment; the branch makes Refunds.undo notify the customer.
let root = '';
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-fold-errors-')).replace(/\\/g, '/');
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'pipe' }).toString();
  write('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', experimentalDecorators: true, strict: false }, include: ['src'] }));
  write('src/infrastructure/repo.ts', `export class Repo {\n  save(id: string) {\n    return id;\n  }\n}\n`);
  write('src/application/refunds.ts', `export class Refunds {\n  undo(id: string) {\n    return id;\n  }\n  notify(id: string) {\n    return id;\n  }\n}\n`);
  write(
    'src/application/shop.ts',
    `import { Repo } from '../infrastructure/repo';\nimport { Refunds } from './refunds';\nexport class Shop {\n  private repo = new Repo();\n  private refunds = new Refunds();\n  place(id: string) {\n    try {\n      this.repo.save(id);\n    } catch (e) {\n      this.refunds.undo(id);\n      throw e;\n    }\n  }\n}\n`,
  );
  write('src/decorators.ts', `export const Controller = (p?: string) => (t: any) => t;\nexport const Post = (p?: string) => (t: any, k: string) => undefined;\n`);
  write('src/presentation/shop.controller.ts', `import { Controller, Post } from '../decorators';\nimport { Shop } from '../application/shop';\n@Controller('shop')\nexport class ShopController {\n  @Post(':id') place() { return new Shop().place('1'); }\n}\n`);
  git('init', '-q', '-b', 'develop');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/notify');
  write('src/application/refunds.ts', `export class Refunds {\n  undo(id: string) {\n    this.notify(id);\n    return id;\n  }\n  notify(id: string) {\n    return id;\n  }\n}\n`);
  git('commit', '-q', '-am', 'feature');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const PLACE = 'src/application/shop.ts#Shop.place';
const session = () => new DiagramSession({ adapter: createTsAdapter(root), classifier: createClassifier(root), createBaseAdapter: () => createTsAdapter(root) });
const drawn = (d: SequenceDiagram | undefined) => d!.messages.map((m) => m.id);
const removed = (d: SequenceDiagram | undefined) => d!.messages.filter((m) => m.diff?.status === 'removed').map((m) => m.id);

describe('FR-3.12 a review change in an error branch', () => {
  it('FR-3.12 the change count is the same with ↯ on or off; the base flow folds like this one (no calls shown as removed)', async () => {
    const s = session();
    await s.reviewChanges({ base: 'develop' });
    const folded = (await s.openMethodByKey(PLACE))!;
    expect(drawn(folded).some((id) => id.endsWith(':undo'))).toBe(false);
    expect(folded.reviewTotal).toBeGreaterThan(0);
    expect(removed(folded)).toEqual([]);
    const all = (await s.setOption('foldErrors', false))!;
    expect(drawn(all).some((id) => id.endsWith(':undo'))).toBe(true);
    expect(all.reviewTotal).toBe(folded.reviewTotal);
    expect(removed(all)).toEqual([]);
    // the branch shown by hand with ↯ on: drawn in both versions, not removed
    const on = (await s.setOption('foldErrors', true))!;
    const key = on.exits!.find((e) => e.errorPath)!.errorPath!.key;
    const shown = (await s.showErrorPath(key))!;
    expect(drawn(shown).some((id) => id.endsWith(':undo'))).toBe(true);
    expect(removed(shown)).toEqual([]);
  });

  it('FR-3.12 Changes opens the path into the folded branch and shows it', async () => {
    const s = session();
    await s.reviewChanges({ base: 'develop' });
    await s.openMethodByKey(PLACE);
    const d = (await s.smartExpand(undefined, false, 'changes'))!;
    const undo = d.messages.find((m) => m.id.endsWith(':undo'))!;
    expect(undo.expanded).toBe(true);
    expect(d.messages.some((m) => m.methodName === 'notify' && m.diff?.status === 'added')).toBe(true);
  });
});
