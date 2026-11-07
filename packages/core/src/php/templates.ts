import * as fs from 'node:fs';
import { studly } from './accessors';

/** Folders never holding the project's own templates. */
const SKIP = new Set(['vendor', 'node_modules', 'storage', 'bootstrap']);
/** `->name(`, `::name(` and `name(`: a call in a template's PHP (`{{ $order->total() }}`, `@if(Shop::open())`). */
const CALL = /(?:->|::)\s*([A-Za-z_]\w*)\s*\(|(?<![\w$>:\\])([A-Za-z_]\w*)\s*\(/g;
/** `->loyalty_points` not followed by `(`: an attribute read, which may run an Eloquent accessor (FR-18.15). */
const PROPERTY = /->\s*([A-Za-z]\w*)\b(?!\s*\()/g;

/** FR-31.3 the names called (and FR-18.15 the accessors read) in the project's Blade templates (`*.blade.php`), lower case, with how often. */
export function bladeCallNames(root: string): Map<string, number> {
  const names = new Map<string, number>();
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) visit(p);
      else if (e.name.endsWith('.blade.php')) {
        const text = fs.readFileSync(p, 'utf8');
        const add = (name: string) => names.set(name, (names.get(name) ?? 0) + 1);
        for (const m of text.matchAll(CALL)) add((m[1] ?? m[2]).toLowerCase());
        // the accessor names an attribute read stands for: `getLoyaltyPointsAttribute`, `loyaltyPoints(): Attribute`
        for (const m of text.matchAll(PROPERTY)) {
          const attribute = studly(m[1]);
          add(`get${attribute}attribute`.toLowerCase());
          add(attribute.toLowerCase());
        }
      }
    }
  };
  visit(root);
  return names;
}
