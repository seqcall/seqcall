import { describe, expect, it } from 'vitest';
import type { ContainerBinding } from '../src/adapter';
import { DefaultClassifier } from '../src/classifier-impl';
import type { Classifier } from '../src/classifier';
import { at, call, cls, fakeSession, meth, type World } from './fake-world';

// FR-8.6 the DI container's registrations as the session reads them: per refresh, per host application; an adapter
// that fails to answer.
const ctl = cls('src/Api/ShopController.cs', 'ShopController');
const iRepo = cls('src/Core/IRepo.cs', 'IRepo', 'interface');
const sql = cls('src/Infra/SqlRepo.cs', 'SqlRepo');
const mem = cls('src/Infra/MemRepo.cs', 'MemRepo');
const find = meth(iRepo, 'Find', { hasBody: false });
// the root has no declaration (a method known only by key): its file comes from the key
const get = meth(ctl, 'Get', { declaration: undefined });
const bindings: ContainerBinding[] = [
  { abstract: iRepo.key, concrete: sql.key, range: at('Api/Program.cs', 3), hosts: ['Api'] },
  { abstract: iRepo.key, concrete: mem.key, range: at('Worker/Program.cs', 3), hosts: ['Worker'] },
];
const world = (adapter: World['adapter']): World => ({
  methods: [get, find],
  calls: { [get.key]: [call(0, find, { receiver: { kind: 'field', name: '_repo' } })] },
  impls: { [find.key]: [meth(sql, 'Find'), meth(mem, 'Find')] },
  adapter: { getBindings: async () => bindings, ...adapter },
});
const chosen = async (w: World, classifier?: Classifier) => {
  const d = (await fakeSession(w, classifier ? { classifier } : {}).openMethodByKey(get.key))!;
  return d.messages.find((m) => m.id === 'root/0:Find')!.polymorphic?.selectedKey;
};

describe('FR-8.6 registrations per host application', () => {
  it('FR-8.6 the root runs in the Api: its registration; the hosts asked for the file under the project root', async () => {
    const asked: string[] = [];
    const base = new DefaultClassifier('/nowhere', {});
    // a host's classifier without a project root: the adapter's root
    const classifier: Classifier = { classify: (r, i, u) => base.classify(r, i, u), layerOrder: () => [], reloadConfig: () => undefined };
    expect(await chosen(world({ getHostsOf: async (f: string) => (asked.push(f), ['Api']) }), classifier)).toBe(sql.key);
    expect(asked).toEqual(['/p/src/Api/ShopController.cs']);
  });

  it('FR-8.6 the hosts cannot be told (the request fails): the registration in effect over all of them', async () => {
    expect(await chosen(world({ getHostsOf: async () => Promise.reject(new Error('no project')) }))).toBe(mem.key);
  });

  it('FR-8.6 the registrations cannot be read: none applies, every implementation is offered', async () => {
    const d = (await fakeSession(world({ getBindings: async () => Promise.reject(new Error('sidecar gone')) })).openMethodByKey(get.key))!;
    expect(d.messages.find((m) => m.id === 'root/0:Find')!.polymorphic).toMatchObject({ selectedKey: undefined, implementations: [{ key: sql.key }, { key: mem.key }] });
  });
});
