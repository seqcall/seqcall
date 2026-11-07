import { describe, expect, it } from 'vitest';
import { at, call, cls, fakeSession, meth } from './fake-world';

// why a call's target is unknown, in the words of its language: a PHP or C# call never needs node_modules.
const shop = cls('src/shop.ts', 'Shop');
const place = meth(shop, 'place');

async function reason(file: string): Promise<string | undefined> {
  const s = fakeSession({ methods: [place], calls: { [place.key]: [call(0, undefined, { range: at(file, 3), methodName: 'send', expressionText: 'mailer.send()' })] } });
  const d = (await s.openMethodByKey(place.key))!;
  return d.messages.find((m) => m.id === 'root/0:send')!.unresolved; // unknown: named by its expression
}

describe('the unknown-call reason per language', () => {
  it('TypeScript / JavaScript: node_modules; PHP: vendor/ and the container; C#: dotnet restore', async () => {
    expect(await reason('src/shop.ts')).toBe('Its declaration was not found: a library that is not installed (node_modules), or a dynamic call.');
    const php = (await reason('app/Services/Shop.php'))!;
    expect(php).toContain('vendor/ — run composer install');
    expect(php).toContain('`app()->make(…)`');
    expect(php).not.toContain('node_modules');
    const cs = (await reason('src/Shop/Shop.CS'))!; // the extension in any case
    expect(cs).toBe('Its declaration was not found: a library whose packages are not restored (run dotnet restore), or a dynamic call.');
  });
});
