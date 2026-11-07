import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ClassNode, ClassRelation, EntryPoint } from '@seqcall/protocol';
import { afterAll, describe, expect, it } from 'vitest';
import { buildAppLevel, mergeScans, type EntryPointScan } from '../src/app-map';
import { possibleOf } from '../src/class-diagram';
import { createClassifier } from '../src/classifier-impl';
import { classViewText } from '../src/flow-text';
import { createPhpAdapter } from '../src/php/php-adapter';
import { diffStructure } from '../src/review/structure-diff';
import { DiagramSession } from '../src/session';

// FR-7.16 a violation is only as sure as the layers it rests on: when a weak rule (a name, a role folder, the code's
// evidence) decided a layer of either class, the violation is possible — said in both diagrams, the map and the review.
const roots: string[] = [];
const project = (files: Record<string, string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-possible-')).replace(/\\/g, '/');
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
};
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const php = (ns: string, body: string) => `<?php\n\nnamespace ${ns};\n\n${body}\n`;
const GUESS = '`Pricing` is Application by a guess: role folder `Services/`';

describe('FR-7.16 a violation resting on a guessed layer is possible', () => {
  it('FR-7.16 both diagrams: Domain → Infrastructure (layer folders) is certain, Domain → a role folder\'s Application is possible, with the guess', async () => {
    const root = project({
      'src/Domain/Order.php': php(
        'Shop\\Domain',
        `use Shop\\Infrastructure\\Db;
use Shop\\Services\\Pricing;

class Order
{
    public function __construct(private Db $db, private Pricing $pricing) {}

    public function place(): int
    {
        $this->db->save();
        return $this->pricing->price();
    }
}`,
      ),
      // an entry point, for the codebase map
      'routes/web.php': "<?php\n\nuse Illuminate\\Support\\Facades\\Route;\nuse Shop\\Domain\\Order;\n\nRoute::post('/orders', [Order::class, 'place']);\n",
      'src/Infrastructure/Db.php': php('Shop\\Infrastructure', 'class Db\n{\n    public function save(): void\n    {\n        echo 1;\n    }\n}'),
      'src/Services/Pricing.php': php('Shop\\Services', 'class Pricing\n{\n    public function price(): int\n    {\n        return rand(1, 9);\n    }\n}'),
    });
    const s = new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) });
    await s.openMethodByKey('src/Domain/Order.php#Order.place');
    const d = (await s.expandAll())!;
    const cd = (await s.getClassDiagram())!;
    // the class diagram: the relations
    const relation = (to: string) => cd.relations.find((r) => r.violation && r.to.endsWith(`#${to}`))!;
    expect([relation('Db').possible, relation('Pricing').possible]).toEqual([undefined, [GUESS]]);
    // the issues, the same list in both diagrams: the guess is part of the evidence
    for (const findings of [d.findings, cd.findings]) {
      const v = (findings ?? []).filter((f) => f.kind === 'layer-violation');
      expect(v.map((f) => [f.title, f.possible])).toEqual([
        ['Layer violation: Order → Db', undefined],
        ['Layer violation: Order → Pricing', [GUESS]],
      ]);
      expect(v[1].evidence!.at(-1)).toBe(GUESS);
    }
    // the objects' cards in the sequence diagram
    const box = (name: string) => d.participants.find((p) => p.className === name)!;
    expect(box('Order').layerViolations).toEqual(['depends on Infrastructure: Db', `depends on Application: Pricing (possible: ${GUESS})`]);
    expect(box('Pricing').layerViolations).toEqual([`Domain depends on it: Order (possible: ${GUESS})`]);
    // the text (Share → Copy as text): the guess under the relation
    const text = classViewText(root, cd, d);
    expect(text).toContain(`  ⚠ possible: Domain → Application: an inner layer depends on an outer layer\n    ${GUESS}`);
    expect(text).toContain('  ⚠ Domain → Infrastructure: an inner layer depends on an outer layer');
    // the codebase map, from the real scan of the project
    const map = (await new DiagramSession({ adapter: createPhpAdapter(root), classifier: createClassifier(root) }).getAppMap(''))!;
    expect([map.violations, map.possibleViolations, map.violationList!.map((v) => [v.toName, v.possible])]).toEqual([2, 1, [['Db', undefined], ['Pricing', [GUESS]]]]);
  });

  it('FR-7.16 an edge merging broken relations is possible only when all of them are: one certain one makes it certain', () => {
    const r = (possible?: string[]): ClassRelation => ({ id: 'x', kind: 'dependency', from: 'a', to: 'b', violation: 'v', ...(possible ? { possible } : {}) });
    expect(possibleOf([r(['a guess']), r(['a guess', 'b guess'])])).toEqual({ possible: ['a guess', 'b guess'] });
    expect(possibleOf([r(['a guess']), r()])).toEqual({});
    expect(possibleOf([])).toEqual({});
  });

  const cls = (key: string, layer: string): ClassNode => ({ key, name: key.replace(/^.*#/, ''), kind: 'class', stereotypes: [], layer, namespace: '', methods: [{ name: 'run', isStatic: false, signature: 'run()' }] });
  const ep = (label: string): EntryPoint => ({ kind: 'http', label, method: { key: `src/x.ts#X.${label}`, name: label, owner: { key: 'src/x.ts#X', name: 'X', kind: 'class' } } as EntryPoint['method'] });
  const scan = (label: string, classes: ClassNode[], relations: ClassRelation[]): EntryPointScan => ({ entry: ep(label), files: new Set(classes.map((c) => c.key.replace(/#.*$/, ''))), classes, relations, findings: [], truncated: false });
  const order = cls('src/domain/Order.ts#Order', 'Domain');
  const db = cls('src/infra/Db.ts#Db', 'Infrastructure');
  const pricing = cls('src/services/Pricing.ts#Pricing', 'Application');
  const VIOL = 'Domain → Infrastructure: an inner layer depends on an outer layer';

  it('FR-7.16 codebase map: the possible ones counted apart, each listed with its guess; a flow seeing the violation first gives it', () => {
    const base: ClassRelation = { id: 'p', kind: 'dependency', from: order.key, to: pricing.key, calls: [] };
    const model = mergeScans([
      scan('GET /a', [order, db], [{ id: 'd', kind: 'dependency', from: order.key, to: db.key, calls: [], violation: VIOL }]),
      // the first flow shows the relation without a layer rule broken, the second (later classified) with it
      scan('GET /b', [order, pricing], [base]),
      scan('GET /c', [order, pricing], [{ ...base, violation: 'Domain → Application: an inner layer depends on an outer layer', possible: [GUESS] }]),
      // a later flow sees the same Db relation (no rule broken first, certain later): certain
      scan('GET /d', [order, db], [{ id: 'd2', kind: 'dependency', from: db.key, to: order.key, calls: [] }]),
      scan('GET /e', [order, db], [{ id: 'd2', kind: 'dependency', from: db.key, to: order.key, calls: [], violation: VIOL }]),
    ]);
    const top = buildAppLevel(model, '', { layerOrder: ['Presentation', 'Application', 'Domain', 'Infrastructure'], computedAt: 't' });
    expect([top.violations, top.possibleViolations]).toEqual([3, 1]);
    expect(top.violationList!.map((v) => [v.toName, v.possible])).toEqual([
      ['Db', undefined],
      ['Pricing', [GUESS]],
      ['Order', undefined],
    ]);
    // the packages' edges: `src/services` only by a guess
    const edge = (to: string) => top.diagram.relations.find((r) => r.to.includes(to))!;
    expect([edge('services').possible, edge('infra').possible]).toEqual([[GUESS], undefined]);
  });

  it('FR-7.16 review: a new possible violation says so', () => {
    const show = ep('GET /orders');
    const base = { scans: [scan('GET /orders', [order, pricing], [])], entryPoints: [show] };
    const branch = { scans: [scan('GET /orders', [order, pricing], [{ id: 'p', kind: 'dependency', from: order.key, to: pricing.key, calls: [], violation: VIOL, possible: [GUESS] }])], entryPoints: [show] };
    expect(diffStructure(base, branch).find((r) => r.kind === 'violation-added')!.possible).toEqual([GUESS]);
  });
});
