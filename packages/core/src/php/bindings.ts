import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContainerBinding } from '../adapter';
import { isNestedFunction, nameOf, rangeOf, walk, type PNode } from './ast';
import type { PhpModel } from './model';
import type { ClassDecl } from './project';
import type { PhpContext } from './types';

/**
 * FR-8.6 Laravel container bindings, read from the service providers the application registers: the project's
 * own (`app/Providers`, any class extending a `…ServiceProvider`), those listed in `config/app.php` → `providers`,
 * and those packages declare for auto-discovery (`vendor/composer/installed.json` → `extra.laravel.providers`;
 * only first-party packages are analysed). Only provider classes are loaded, not whole packages.
 *
 * - `$this->app->bind(I::class, B::class)` / `singleton` / `scoped` (also through `app()`, `App::`, `$app`):
 *   B for every consumer of I;
 * - `$this->app->when(A::class)->needs(I::class)->give(B::class)` (A may be an array): B for A only.
 *
 * The implementation is a class name, or the first class a closure builds (`fn ($app) => $app->make(B::class, …)`,
 * `new B(…)`, `app(B::class)`, `resolve(B::class)`). Bindings to strings or values are left out.
 */
export function containerBindings(model: PhpModel): ContainerBinding[] {
  const out: ContainerBinding[] = [];
  for (const provider of providerClasses(model)) {
    for (const method of provider.methods.values()) {
      if (!method.body) continue;
      const ctx: PhpContext = { file: provider.file, scope: provider.scope, cls: provider, callable: method };
      const keyOf = (fqn: string | undefined) => {
        const c = model.project.classByFqn(fqn);
        return c ? model.classRef(c).key : undefined;
      };
      const classOf = (n: PNode | undefined): string | undefined => {
        if (!n) return undefined;
        if (n.kind === 'staticlookup' && nameOf(n.offset) === 'class') return model.types.classRefName(n.what, ctx);
        if (n.kind === 'string') return String(n.value).replace(/^\\/, '');
        return undefined;
      };
      /** `B::class`, or the first class a closure builds. */
      const concreteOf = (n: PNode | undefined): string | undefined => {
        if (!n) return undefined;
        if (n.kind !== 'closure' && n.kind !== 'arrowfunc') return classOf(n);
        let found: string | undefined;
        walk(n.body ?? n, (x) => {
          if (found) return false;
          if (x.kind === 'new') found = model.types.classRefName(x.what, ctx);
          else if (x.kind === 'call' && /^(make|app|resolve|makeWith|build)$/i.test(nameOf(x.what?.offset ?? x.what))) found = classOf(x.arguments?.[0]);
        });
        return found;
      };
      const add = (abstract: string | undefined, concrete: string | undefined, node: PNode, consumer?: string, lifetime?: string) => {
        const a = keyOf(abstract);
        const c = keyOf(concrete);
        if (!a || !c || a === c) return;
        out.push({ abstract: a, concrete: c, ...(consumer ? { consumer } : {}), range: rangeOf(provider.file.abs, node), ...(lifetime ? { lifetime } : {}) });
      };
      walk(method.body, (n) => {
        if (n !== method.body && isNestedFunction(n) && n.kind !== 'closure' && n.kind !== 'arrowfunc') return false;
        if (n.kind !== 'call' || n.what?.kind !== 'propertylookup' && n.what?.kind !== 'staticlookup') return;
        const verb = nameOf(n.what.offset).toLowerCase();
        if (verb === 'give') {
          // ->when(A)->needs(I)->give(B)
          // (by the verbs only: a node that is no call has no arguments, so it binds nothing)
          const needs = n.what.what;
          const when = needs.what?.what;
          if (nameOf(needs.what?.offset).toLowerCase() !== 'needs' || nameOf(when.what?.offset).toLowerCase() !== 'when') return;
          const abstract = classOf(needs.arguments?.[0]);
          const concrete = concreteOf(n.arguments?.[0]);
          const consumers = when.arguments?.[0]?.kind === 'array' ? when.arguments[0].items.map((i: PNode) => classOf(i.value)) : [classOf(when.arguments?.[0])];
          for (const consumer of consumers) {
            const k = keyOf(consumer);
            if (k) add(abstract, concrete, n, k);
          }
        } else if (verb === 'bind' || verb === 'singleton' || verb === 'scoped' || verb === 'bindif' || verb === 'singletonif') {
          // FR-6.7 `singleton` / `scoped` make one object (per request); `bind` a new one each time
          add(classOf(n.arguments?.[0]), concreteOf(n.arguments?.[1]), n, undefined, verb.startsWith('singleton') ? 'singleton' : verb === 'scoped' ? 'scoped' : 'transient');
        }
      });
    }
  }
  return out;
}

/** The service providers the application registers (project, config/app.php, package auto-discovery). */
function providerClasses(model: PhpModel): ClassDecl[] {
  const root = model.project.root;
  const out = new Map<string, ClassDecl>();
  const add = (c: ClassDecl | undefined) => {
    if (c && c.kind === 'class') out.set(c.fqn.toLowerCase(), c);
  };
  // the project's own: any class extending a …ServiceProvider (directly or through a project class)
  for (const f of model.project.projectFiles()) {
    for (const c of f.classes) if (model.project.ancestors(c.fqn).some((a) => a.extends.some((e) => /ServiceProvider$/.test(e)))) add(c);
  }
  // config/app.php → providers
  try {
    const text = fs.readFileSync(path.join(root, 'config', 'app.php'), 'utf8');
    const block = /'providers'\s*=>[^[]*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
    for (const m of block.matchAll(/(?<![\w\\])\\?([\w\\]+)::class/g)) add(model.project.classByFqn(m[1]));
  } catch {
    // no config/app.php
  }
  // package auto-discovery (first-party packages load on demand; others stay unknown)
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'composer', 'installed.json'), 'utf8')) as
      | { packages?: { extra?: { laravel?: { providers?: string[] } } }[] }
      | { extra?: { laravel?: { providers?: string[] } } }[];
    const packages = Array.isArray(installed) ? installed : installed.packages ?? [];
    for (const p of packages) for (const fqn of p.extra?.laravel?.providers ?? []) add(model.project.classByFqn(fqn));
  } catch {
    // no vendor/
  }
  return [...out.values()];
}

