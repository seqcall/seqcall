import type { PNode } from './ast';
import { nameOf } from './ast';
import type { PhpModel } from './model';
import type { ClassDecl } from './project';
import type { FoundMethod } from './types';

const lower = (s: string) => s.toLowerCase();

/** Laravel's `Casts\Attribute`: the return type of an accessor / mutator method in the Laravel 9+ style. */
const ATTRIBUTE_CAST = 'illuminate\\database\\eloquent\\casts\\attribute';

/** Laravel's `Str::studly`: `loyalty_points` / `loyaltyPoints` → `LoyaltyPoints`. */
export function studly(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
}

/** Laravel's `Str::snake`: `LoyaltyPoints` → `loyalty_points`. */
export function snake(name: string): string {
  return name.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase();
}

/** `getLoyaltyPointsAttribute` / `setLoyaltyPointsAttribute` → `get` / `set` and `LoyaltyPoints`. */
const LEGACY = /^(get|set)(\w+)Attribute$/i;

/** A method returning Laravel's `Attribute` (`loyaltyPoints(): Attribute`): the accessor / mutator of `loyalty_points`. */
function returnsAttribute(model: PhpModel, owner: ClassDecl, node: PNode): boolean {
  return lower(model.types.typeNodeName(node.type, owner.scope, owner) ?? '') === ATTRIBUTE_CAST;
}

/**
 * FR-18.15 the attribute an Eloquent accessor / mutator method serves, in Laravel's studly form (`LoyaltyPoints`):
 * `getLoyaltyPointsAttribute` / `setLoyaltyPointsAttribute`, or `loyaltyPoints(): Attribute`. Undefined for any other method.
 */
export function accessorAttribute(model: PhpModel, owner: ClassDecl, node: PNode): { attribute: string; accessor?: 'get' | 'set' } | undefined {
  const name = nameOf(node);
  const legacy = LEGACY.exec(name);
  if (legacy) return { attribute: studly(legacy[2]), accessor: lower(legacy[1]) as 'get' | 'set' };
  return returnsAttribute(model, owner, node) ? { attribute: studly(name) } : undefined;
}

/** The studly attribute names (lower case) any accessor / mutator of the project serves, per file revision. */
const served = new WeakMap<PhpModel, { revision: number; names: Set<string> }>();

function servedAttributes(model: PhpModel): Set<string> {
  const known = served.get(model);
  if (known && known.revision === model.project.revision) return known.names;
  const names = new Set<string>();
  for (const f of model.project.allFiles()) {
    for (const c of f.classes) for (const m of c.methods.values()) {
      const a = accessorAttribute(model, c, m);
      if (a) names.add(lower(a.attribute));
    }
  }
  served.set(model, { revision: model.project.revision, names });
  return names;
}

/** Whether some accessor / mutator of the project serves the property name (a quick check before any type lookup). */
export function servesAttribute(model: PhpModel, prop: string): boolean {
  return servedAttributes(model).has(lower(studly(prop)));
}

/**
 * FR-18.15 the accessor (read) or mutator (`write`) that `$model->loyalty_points` runs on a class: Laravel turns an
 * attribute it does not hold as a property into `get…Attribute()` / `set…Attribute()` or the `Attribute` method of
 * that name. Undefined when the class declares a real property of that name (PHP does not ask the model then).
 */
export function accessorFor(model: PhpModel, classFqn: string, prop: string, write: boolean): FoundMethod | undefined {
  const attribute = studly(prop);
  const all = model.project.ancestors(classFqn);
  if (all.some((c) => c.properties.has(prop))) return undefined;
  const legacy = model.types.findMethod(classFqn, `${write ? 'set' : 'get'}${attribute}Attribute`);
  if (legacy?.node) return legacy;
  const modern = model.types.findMethod(classFqn, attribute[0].toLowerCase() + attribute.slice(1));
  return modern?.node && returnsAttribute(model, modern.owner, modern.node) ? modern : undefined;
}

/** Whether a quick look at the file may find reads of the attribute (`loyalty_points` or `loyaltyPoints`). */
export function attributeNeedles(attribute: string): string[] {
  return [snake(attribute), lower(attribute)];
}
