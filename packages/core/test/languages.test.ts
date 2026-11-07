import { describe, expect, it } from 'vitest';
import { composerOwnerRoot, createAdapter, isAnalysedFile, languageOfFile } from '../src/languages';
import { RpcLanguageAdapter } from '../src/rpc/rpc-adapter';
import { TsAdapter } from '../src/ts/ts-adapter';

// The language of a file, the files the analysis reads, and the adapter per language (FR-18.1 for PHP; the same
// table decides C# and TypeScript).
describe('FR-18.1 the language and the analysed files', () => {
  it('FR-18.1 a file is C# by .cs, PHP by .php (any case), else JavaScript / TypeScript', () => {
    expect(['/a/Order.cs', '/a/ORDER.CS', '/a/Shop.PHP', '/a/shop.ts', '/a/shop.mjs', '/a/README.md'].map(languageOfFile)).toEqual([
      'csharp',
      'csharp',
      'php',
      'typescript',
      'typescript',
      'typescript',
    ]);
  });

  it('FR-18.1 C#: not build output (bin/, obj/), also with Windows separators', () => {
    expect(isAnalysedFile('/s/Shop/Order.cs')).toBe(true);
    expect(isAnalysedFile('/s/Shop/obj/Debug/Gen.cs')).toBe(false);
    expect(isAnalysedFile('C:\\s\\Shop\\bin\\Gen.cs')).toBe(false);
  });

  it('FR-18.1 JavaScript / TypeScript: source extensions only, not node_modules or declaration files', () => {
    expect(['/a/src/x.ts', '/a/src/x.cjs', '/a/src/x.tsx', '/a/src/x.json', '/a/node_modules/p/x.js', '/a/src/x.d.ts', '/a/src/x.d.mts'].map(isAnalysedFile)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('FR-18.9 a file in vendor/ of a Composer project belongs to that project; elsewhere none', () => {
    const roots = new Set(['/w/shop']);
    const has = (dir: string) => roots.has(dir);
    expect(composerOwnerRoot('/w/shop/vendor/acme/pay/src/P.php', has)).toBe('/w/shop');
    expect(composerOwnerRoot('C:\\w\\shop\\vendor\\acme\\P.php', (d) => d === 'C:/w/shop')).toBe('C:/w/shop');
    // a vendor/ folder outside a Composer project, no vendor/ at all, vendor/ at the start of the path
    expect(composerOwnerRoot('/w/tools/vendor/x/P.php', has)).toBeUndefined();
    expect(composerOwnerRoot('/w/shop/src/P.php', has)).toBeUndefined();
    expect(composerOwnerRoot('/vendor/x/P.php', () => true)).toBeUndefined();
  });

  it('FR-18.1 one adapter per language: TypeScript by default, C# through the sidecar protocol', () => {
    expect(createAdapter('typescript', '/w/app')).toBeInstanceOf(TsAdapter);
    expect(createAdapter('csharp', '/w/app')).toBeInstanceOf(RpcLanguageAdapter);
  });
});
