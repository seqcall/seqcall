import { describe, expect, it } from 'vitest';
import { tsProject } from './ts-project';

// FR-19.18 a method of another class (or module) handed in as a function value: the class that wrote the reference
// depends on the method's class — the sender of the call whose arguments handed it over (`Message.handedBy`).
describe('FR-19.18 the writer of a method reference', () => {
  it('FR-19.18 a function passed under an import alias: no argument names it, the call right above handed it over', async () => {
    const p = tsProject({
      'src/fmt.ts': `export function plainText(x: string) { return x; }\n`,
      'src/each.ts': `export class Each {\n  run(xs: string[], f: (x: string) => string) { return xs.map((x) => f(x)); }\n}\n`,
      'src/app.ts': `import { plainText as asText } from './fmt';\nimport { Each } from './each';\nexport class App {\n  go() { return new Each().run(['a'], asText); }\n}\n`,
    });
    const s = p.session();
    await s.openMethod(await p.method('src/app.ts#App.go'));
    const d = (await s.expand('root/1:run'))!;
    // the parameter runs the aliased function: `f` bound to plainText, the arguments only say `asText`
    const f = d.messages.find((m) => m.viaParameter === 'f')!;
    expect([f.id, f.methodName, f.methodKey]).toEqual(['root/1:run/1:f', 'plainText', 'src/fmt.ts#<module>.plainText']);
    expect(d.messages.find((m) => m.id === 'root/1:run')!.args).toEqual(["['a']", 'asText']);
    const cd = (await s.getClassDiagram())!;
    const rels = cd.relations.filter((r) => r.kind === 'dependency').map((r) => `${r.from} → ${r.to}: ${r.calls!.map((c) => c.label).join(', ')}`);
    // App wrote the reference (its call to run is right above), Each only runs its parameter
    expect(rels).toEqual(['src/app.ts#App → src/each.ts#Each: go → new Each', 'src/app.ts#App → src/each.ts#Each: go → run', 'src/app.ts#App → src/fmt.ts#<module>: go → plainText']);
    const handed = cd.relations.find((r) => r.to === 'src/fmt.ts#<module>')!;
    expect(handed.calls![0]).toMatchObject({ messageId: 'root/1:run/1:f', callSite: d.messages.find((m) => m.id === 'root/1:run')!.callSite });
  });

  it('FR-19.18 an aliased function passed on through a second call before it runs: the first call handed it over, in both diagrams', async () => {
    const p = tsProject({
      'src/infrastructure/fmt.ts': `export function plainText(x: string) { return x; }\n`,
      'src/domain/each.ts': `export class Each {\n  run(xs: string[], f: (x: string) => string) { return this.loop(xs, f); }\n  loop(xs: string[], g: (x: string) => string) { return xs.map((x) => g(x)); }\n}\n`,
      'src/application/app.ts': `import { plainText as asText } from '../infrastructure/fmt';\nimport { Each } from '../domain/each';\nexport class App {\n  go() { return new Each().run(['a'], asText); }\n}\n`,
    });
    const s = p.session();
    await s.openMethod(await p.method('src/application/app.ts#App.go'));
    await s.expand('root/1:run');
    const d = (await s.expand('root/1:run/0:loop'))!;
    // `g` runs plainText; no argument on the way says plainText (`asText`, then `f`)
    const g = d.messages.find((m) => m.viaParameter === 'g')!;
    expect([g.methodName, g.handedBy]).toEqual(['plainText', 'root/1:run']);
    const cd = (await s.getClassDiagram())!;
    const toFmt = cd.relations.filter((r) => r.to === 'src/infrastructure/fmt.ts#<module>').map((r) => `${r.from}: ${r.calls!.map((c) => c.label).join(', ')}`);
    expect(toFmt).toEqual(['src/application/app.ts#App: go → plainText']);
    // FR-19.17 the sequence diagram charges the same class: App, not Each, depends on the Infrastructure function
    const violations = (cls: string) => d.participants.find((x) => x.className === cls)?.layerViolations ?? [];
    expect(violations('Each')).toEqual([]);
    expect(violations('App')).toEqual(['depends on Infrastructure: fmt']);
  });
});
