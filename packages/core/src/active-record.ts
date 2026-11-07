import type { ClassRef } from '@seqcall/protocol';
import type { ClassInfo } from './adapter';

/** FR-19 library base classes of Active Record models (their I/O is by design). */
const ACTIVE_RECORD_BASE = /Illuminate\\Database\\Eloquent\\|Illuminate\\Foundation\\Auth\\User\b|Eloquent\\Model\b|Jenssegers\\Mongodb\\|\bActiveRecord\b/;

export interface ActiveRecordBase {
  /** The library model base that makes it one. */
  base: ClassRef;
  /** The class's own base when the model base is further up (`Invoice extends Order`, `Order extends Model`). */
  via?: ClassRef;
}

/** A base class of a package that could not be read (no `vendor/`, not in Composer's map): a model or not is unknown. */
export interface UnreadBase {
  unread: ClassRef;
  via?: ClassRef;
}

/**
 * The base class of a library class (`lib:` key), read from the package's source: the base, `null` when it has none,
 * `'unread'` when the source could not be read, `undefined` while it is being fetched.
 */
export type LibraryBase = (libKey: string) => ClassRef | null | 'unread' | undefined;

/**
 * FR-7.14 / FR-19 an Active Record model (Eloquent, Rails-style): up the `extends` chain to a model base of a library.
 * `undefined` while a class info of the chain is not known yet (`info` looks it up). Library bases are followed
 * through `libraryBase` when the adapter can read them; without it, a library base ends the chain (not a model).
 */
export function activeRecordBase(classKey: string, info: (key: string) => ClassInfo | undefined, libraryBase?: LibraryBase): ActiveRecordBase | UnreadBase | false | undefined {
  const own = info(classKey);
  if (!own) return undefined;
  const via = own.extends;
  const tag = (base: ClassRef) => (via && via.key !== base.key ? { via } : {});
  let parent = own.extends;
  for (let depth = 0; depth < 8 && parent; depth++) {
    // Eloquent models and Laravel's model bases (Auth\\User, Pivot …), Rails-style ActiveRecord
    if (ACTIVE_RECORD_BASE.test(parent.key) || /^(Eloquent|ActiveRecord)$/.test(parent.name)) return { base: parent, ...tag(parent) };
    if (parent.key === 'unknown') return false;
    let next: ClassRef | null;
    if (parent.key.startsWith('lib:')) {
      if (!libraryBase) return false;
      const b = libraryBase(parent.key);
      if (b === undefined) return undefined;
      if (b === 'unread') return { unread: parent, ...tag(parent) };
      next = b;
    } else {
      const at = info(parent.key);
      if (!at) return undefined;
      next = at.extends ?? null;
    }
    parent = next ?? undefined;
  }
  return false;
}

/** The answer is a model (not an unread base). */
export function isModel(ar: ActiveRecordBase | UnreadBase | false | undefined): ar is ActiveRecordBase {
  return !!ar && 'base' in ar;
}
