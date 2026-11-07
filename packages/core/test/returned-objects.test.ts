import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SequenceDiagram } from '@seqcall/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { createClassifier } from '../src/classifier-impl';
import { targetNames } from '../src/session/build';
import { DiagramSession } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-returns-')).replace(/\\/g, '/');
fs.mkdirSync(`${root}/src`);
fs.writeFileSync(`${root}/tsconfig.json`, JSON.stringify({ compilerOptions: { target: 'ES2022', strict: false }, include: ['src'] }));
// Enrollment has state (validate() sets it): which object a call goes to matters, the lifelines stay apart (FR-5.10)
fs.writeFileSync(`${root}/src/service.ts`, `export class Enrollment {
  valid = false;
  validate() { this.valid = true; return true; }
}
export class Service {
  private async enroll(ok: boolean): Promise<[Enrollment | null, string]> {
    if (!ok) return [null, 'invalid'];
    const enrollment = new Enrollment();
    return [enrollment, 'ok'];
  }
  async run(ok: boolean) {
    const [enrollment, status] = await this.enroll(ok);
    enrollment.validate();
    this.award(enrollment);
  }
  award(p: Enrollment) { p.validate(); }
  private make() {
    const p = new Enrollment();
    return p;
  }
  runMake() {
    const p = this.make();
    p.validate();
  }
  private pick(a: boolean): [Enrollment, string] {
    const x = new Enrollment();
    const y = new Enrollment();
    return a ? [x, 'a'] : [y, 'b'];
  }
  runPick() {
    const [p] = this.pick(true);
    p.validate();
  }
}
`);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('FR-5.8 returned objects through variables, tuples and destructuring', () => {
  const adapter = createTsAdapter(root);
  const open = async (method: string): Promise<SequenceDiagram> => {
    const s = new DiagramSession({ adapter, classifier: createClassifier(root) });
    await s.openMethodByKey(`src/service.ts#Service.${method}`);
    return (await s.expandAll())!;
  };
  const enrollments = (d: SequenceDiagram) => d.participants.filter((p) => p.className === 'Enrollment');
  const validates = (d: SequenceDiagram) => d.messages.filter((m) => m.methodName === 'validate').map((m) => m.to);

  it('FR-5.8 an array returned with a local variable, destructured by the caller and passed on, is the created object', async () => {
    const d = await open('run');
    const created = d.messages.find((m) => m.kind === 'create')!;
    expect(enrollments(d)).toHaveLength(1);
    expect(validates(d)).toEqual([created.to, created.to]); // in run() and in award(p)
  });

  it('FR-5.8 a returned local variable is the object assigned to it', async () => {
    const d = await open('runMake');
    expect(enrollments(d)).toHaveLength(1);
    expect(validates(d)).toEqual([d.messages.find((m) => m.kind === 'create')!.to]);
  });

  it('FR-5.8 not bound when the returned object is not known (a conditional between two objects)', async () => {
    const d = await open('runPick');
    expect(enrollments(d)).toHaveLength(3); // x, y and the caller's p
  });

  it('FR-5.8 positional destructuring targets of C#, TS and PHP', () => {
    expect(targetNames('(memberEnrollment, orderStatus)')).toEqual(['memberEnrollment', 'orderStatus']);
    expect(targetNames('(Member? p, OrderStatus s)')).toEqual(['p', 's']);
    expect(targetNames('[a, , b]')).toEqual(['a', '', 'b']);
    expect(targetNames('[$order, $status]')).toEqual(['order', 'status']);
    expect(targetNames('list($order, $status)')).toEqual(['order', 'status']);
    expect(targetNames('(_, s)')).toEqual(['', 's']);
    for (const t of ['user', '{a, b}', "['o' => $o]", '(Dictionary<string, int> d, x)', '[[a, b], c]']) expect(targetNames(t)).toBeUndefined();
  });
});
