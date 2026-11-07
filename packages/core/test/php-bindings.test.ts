import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PhpAdapter } from '../src/php/php-adapter';

// FR-8.6 Laravel container bindings, on small projects written per test.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function open(files: Record<string, string>): PhpAdapter {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-bind-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return new PhpAdapter(root);
}

async function bindings(files: Record<string, string>): Promise<string[]> {
  const short = (k?: string) => k?.replace(/^.*#/, '');
  return (await open(files).getBindings()).map((b) => `${short(b.consumer) ?? '*'} ${short(b.abstract)} → ${short(b.concrete)} @${b.range.start.line}`);
}

/** The classes the providers below bind. */
const DOMAIN = `<?php
namespace App;
interface Gateway {}
class Stripe implements Gateway {}
class Paypal implements Gateway {}
class Checkout {}
class Refunds {}
`;

const provider = (body: string, name = 'AppServiceProvider', head = '') => `<?php
namespace App\\Providers;
use App\\Gateway;
use App\\Stripe;
use App\\Paypal;
use App\\Checkout;
use App\\Refunds;
${head}
class ${name} extends \\Illuminate\\Support\\ServiceProvider {
  public function register() {
${body}
  }
}
`;

describe('FR-8.6 PHP container bindings: what is bound', () => {
  it('class names by ::class or as strings; a closure: its first `new` (the outer one), or make / app / resolve of a class', async () => {
    const lines = await bindings({
      'app/Domain.php': DOMAIN,
      'app/Providers/AppServiceProvider.php': provider(`
    $this->app->bind(Gateway::class, Stripe::class);
    $this->app->singleton('App\\\\Gateway', '\\\\App\\\\Paypal');
    $this->app->scoped(Gateway::class, function ($app) { $log = strlen('x'); return new Stripe(new Paypal()); });
    $this->app->bindIf(Gateway::class, fn ($app) => $app->make(Paypal::class));
    $this->app->singletonIf(Gateway::class, fn () => app(Stripe::class));
    App::bind(Gateway::class, fn () => resolve(Paypal::class));`),
    });
    expect(lines).toEqual(['* Gateway → Stripe @11', '* Gateway → Paypal @12', '* Gateway → Stripe @13', '* Gateway → Paypal @14', '* Gateway → Stripe @15', '* Gateway → Paypal @16']);
  });

  it('no binding: values the scan cannot know, library classes, a class bound to itself, a closure that builds nothing, half-typed calls', async () => {
    const lines = await bindings({
      'app/Domain.php': DOMAIN,
      'app/Providers/AppServiceProvider.php': provider(`
    $this->app->bind($name, Stripe::class);
    $this->app->bind(Gateway::class, $concrete);
    $this->app->bind(Gateway::class, Stripe::NAME);
    $this->app->bind(Gateway::class, \\Vendor\\Lib\\Client::class);
    $this->app->bind(\\Vendor\\Lib\\Contract::class, Stripe::class);
    $this->app->singleton(Stripe::class);
    $this->app->singleton(Stripe::class, Stripe::class);
    $this->app->bind(Gateway::class, fn () => config('x'));
    $this->app->bind(Gateway::class, function ($app) { return $app->get('stripe'); });
    $this->app->bind(Gateway::class, fn () => );
    $this->app->bind();
    $this->app->give(Stripe::class);
    $this->app->instance(Gateway::class, new Stripe());`),
    });
    expect(lines).toEqual([]);
  });

  it('a class declared inside a provider method is not read; closures are', async () => {
    const lines = await bindings({
      'app/Domain.php': DOMAIN,
      'app/Providers/AppServiceProvider.php': provider(`
    $logger = new class { public function boot($app) { $app->bind(Gateway::class, Paypal::class); } };
    $this->app->booted(function () { $this->app->bind(Gateway::class, Stripe::class); });`),
    });
    expect(lines).toEqual(['* Gateway → Stripe @12']);
  });
});

describe('FR-8.6 PHP container bindings: contextual (when → needs → give)', () => {
  it('one consumer, a list of consumers (also written as strings); consumers and chains the scan cannot know are left out', async () => {
    const lines = await bindings({
      'app/Domain.php': DOMAIN,
      'app/Providers/AppServiceProvider.php': provider(`
    $this->app->when(Checkout::class)->needs(Gateway::class)->give(Stripe::class);
    $this->app->when([Checkout::class, 'App\\\\Refunds', , \\Vendor\\Lib\\Other::class])->needs(Gateway::class)->give(Paypal::class);
    $this->app->when($consumer)->needs(Gateway::class)->give(Paypal::class);
    $this->app->when(Checkout::class)->wants(Gateway::class)->give(Paypal::class);
    $this->app->for(Checkout::class)->needs(Gateway::class)->give(Paypal::class);
    $this->app->needs(Gateway::class)->give(Paypal::class);
    $this->app->when(Checkout::class)->give(Paypal::class);
    $builder->needs(Gateway::class)->give(Paypal::class);
    $give->give(Paypal::class);`),
    });
    expect(lines).toEqual(['Checkout Gateway → Stripe @11', 'Checkout Gateway → Paypal @12', 'Refunds Gateway → Paypal @12']);
  });
});

describe('FR-8.6 PHP container bindings: which providers', () => {
  it('project classes extending a …ServiceProvider (also through a project base); abstract methods have nothing to read', async () => {
    const lines = await bindings({
      'app/Domain.php': DOMAIN,
      'app/Providers/BaseProvider.php': `<?php
namespace App\\Providers;
abstract class BaseProvider extends \\Illuminate\\Support\\ServiceProvider { abstract public function gateways(); }
`,
      'app/Providers/PayProvider.php': `<?php
namespace App\\Providers;
use App\\Gateway;
use App\\Stripe;
class PayProvider extends BaseProvider {
  public function gateways() {}
  public function register() { $this->app->bind(Gateway::class, Stripe::class); }
}
`,
      'app/Services/NotAProvider.php': `<?php
namespace App\\Services;
class NotAProvider { public function register() { $this->app->bind(\\App\\Gateway::class, \\App\\Paypal::class); } }
`,
    });
    expect(lines).toEqual(['* Gateway → Stripe @6']);
  });

  it("config/app.php → 'providers' (classes only, not interfaces or unknown names); without the list, none from it", async () => {
    const files = {
      'app/Domain.php': DOMAIN,
      'app/Setup/Registrar.php': `<?php
namespace App\\Setup;
use App\\Gateway;
use App\\Stripe;
class Registrar { public function register() { $this->app->bind(Gateway::class, Stripe::class); } }
interface Registers { public function register(); }
`,
    };
    expect(
      await bindings({
        ...files,
        'config/app.php': `<?php
return [
  'name' => 'Shop',
  'providers' => [
    App\\Setup\\Registrar::class,
    \\App\\Setup\\Registers::class,
    Vendor\\Missing\\Provider::class,
  ],
];
`,
      }),
    ).toEqual(['* Gateway → Stripe @4']);
    expect(await bindings({ ...files, 'config/app.php': "<?php return ['name' => 'Shop'];" })).toEqual([]);
  });

  it('package auto-discovery: installed.json of Composer 2 ({packages}) and 1 (a list); packages without providers', async () => {
    const files = {
      'app/Domain.php': DOMAIN,
      'vendor/composer/autoload_psr4.php': `<?php
$vendorDir = dirname(__DIR__);
return array('Shop\\\\Pay\\\\' => array($vendorDir . '/shop/pay/src'));
`,
      'vendor/shop/pay/src/PayProvider.php': `<?php
namespace Shop\\Pay;
class PayProvider { public function register() { $this->app->bind(\\App\\Gateway::class, \\App\\Paypal::class); } }
`,
    };
    const pkgs = [{ name: 'shop/other' }, { name: 'shop/plain', extra: { branch: 'x' } }, { name: 'shop/pay', extra: { laravel: { providers: ['Shop\\Pay\\PayProvider'] } } }];
    expect(await bindings({ ...files, 'vendor/composer/installed.json': JSON.stringify({ packages: pkgs }) })).toEqual(['* Gateway → Paypal @2']);
    expect(await bindings({ ...files, 'vendor/composer/installed.json': JSON.stringify(pkgs) })).toEqual(['* Gateway → Paypal @2']);
    expect(await bindings({ ...files, 'vendor/composer/installed.json': JSON.stringify({ dev: true }) })).toEqual([]);
  });
});
