import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { phpEntryPoints, type MissingRoute } from '../src/php/entry-points';
import { PhpModel } from '../src/php/model';
import { PhpProject } from '../src/php/project';

// FR-18.7 / FR-18.11 / FR-18.13 entry points of a PHP project, on small projects written per test.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-php-ep-')).replace(/\\/g, '/');
  dirs.push(root);
  fs.writeFileSync(`${root}/composer.json`, '{"name":"shop/app"}');
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(`${root}/${rel}`), { recursive: true });
    fs.writeFileSync(`${root}/${rel}`, text);
  }
  return root;
}

async function scan(files: Record<string, string>, isTest = (rel: string) => rel.startsWith('tests/')) {
  const missing: MissingRoute[] = [];
  const eps = await phpEntryPoints(new PhpModel(new PhpProject(project(files))), isTest, (m) => missing.push(m));
  return { eps, missing, labels: eps.map((e) => `${e.kind} ${e.label}`) };
}

/** A controller with the methods the routes below point at. */
const CONTROLLER = `<?php
namespace App\\Http;
class OrderController {
  public function index() {} public function show() {} public function store() {} public function update() {} public function destroy() {}
  public function create() {} public function edit() {} public function __invoke() {}
}
`;

describe('FR-18.7 PHP entry points: route URIs the scan can know', () => {
  it('a URI built with `.` from literals, class constants (also inherited), method parameter defaults, $this->prop and case functions', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Versions.php': `<?php
namespace App\\Http;
class BaseVersions { const V1 = 'v1'; }
class Versions extends BaseVersions { const NOTHING = 1; }
`,
      'app/RouteProvider.php': `<?php
namespace App\\Http;
use Illuminate\\Support\\Facades\\Route;
class RouteProvider {
  protected $section = 'shop';
  public function map($area = 'admin') {
    Route::get('/' . Versions::V1 . '/orders', [OrderController::class, 'index']);
    Route::get($area . '/orders', [OrderController::class, 'show']);
    Route::get($this->section . '/orders', [OrderController::class, 'store']);
    Route::get($unknown . '/orders', [OrderController::class, 'update']);
    Route::get('/a/' . Missing::V, [OrderController::class, 'destroy']);
    Route::get(str_repeat('x', 2) . '/b', [OrderController::class, 'create']);
    Route::get(strtoupper('x') . '/c', [OrderController::class, 'edit']);
    Route::get(ucfirst('y') . '/' . strtolower('Z'), [OrderController::class, '__invoke']);
  }
}
`,
    });
    // (PHP's case functions on a known value are known too; other functions are not)
    expect(labels).toEqual(['http GET /v1/orders', 'http GET /admin/orders', 'http GET /shop/orders', 'http GET /X/c', 'http GET /Y/z']);
  });

  it('Route::match: the listed verbs; without verbs or with an unknown URI there is no route (not even a missing one)', async () => {
    const { labels, missing } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::match(['get', 'post'], 'orders', [OrderController::class, 'index']);
Route::match([], 'none', [OrderController::class, 'nothing']);
Route::match(['put'], $unknown, [OrderController::class, 'nothing']);
Route::match(['put', , 'patch'], 'gap', [OrderController::class, 'update']);
`,
    });
    expect(labels).toEqual(['http GET /orders', 'http POST /orders', 'http PUT /gap', 'http PATCH /gap']);
    expect(missing).toEqual([]);
  });

  it('Route::any is one ANY route; the same route registered twice is listed once', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::any('hook', [OrderController::class, 'index']);
Route::any('hook', [OrderController::class, 'index']);
`,
    });
    expect(labels).toEqual(['http ANY /hook']);
  });

  it('resource and apiResource routes; a resource with an unknown name or controller has none', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::apiResource('orders', OrderController::class);
Route::resource($unknown, OrderController::class);
Route::resource('carts', $unknown);
`,
    });
    expect(labels).toEqual(['http GET /orders', 'http POST /orders', 'http GET /orders/{id}', 'http PUT /orders/{id}', 'http DELETE /orders/{id}']);
  });
});

describe('FR-18.7 PHP entry points: route actions', () => {
  it("'uses' => 'Ctrl@m', an invokable 'Ctrl' string or Ctrl::class, the group namespace (a leading \\ is absolute)", async () => {
    const { labels, eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
Route::group(['namespace' => 'App\\Http'], function () {
  Route::get('a', ['uses' => 'OrderController@show']);
  Route::get('b', 'OrderController');
  Route::get('c', '\\App\\Http\\OrderController@store');
  Route::get('e', ['OrderController', 'update']);
});
Route::get('d', \\App\\Http\\OrderController::class);
`,
    });
    expect(labels).toEqual(['http GET /a', 'http GET /b', 'http GET /c', 'http GET /e', 'http GET /d']);
    expect(eps.map((e) => e.method.name)).toEqual(['show', '__invoke', 'store', 'update', '__invoke']);
  });

  it("an action built from known parts: 'Ctrl@' . CONST, Ctrl::class . '@m' (fully qualified, no group namespace), [Ctrl::class, CONST]", async () => {
    const { eps, missing } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Paths.php': `<?php
namespace App\\Http;
class Paths { const SHOW = 'Show'; const STORE = 'store'; }
`,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
use App\\Http\\Paths;
Route::group(['namespace' => 'App\\Http'], function () {
  Route::get('a', 'OrderController@' . lcfirst(Paths::SHOW));
  Route::get('b', OrderController::class . '@update');
  Route::get('c', 'OrderController@' . lcfirst($unknown));
});
Route::get('d', [OrderController::class, Paths::STORE]);
`,
    });
    expect(eps.map((e) => `${e.label} ${e.method.key}`)).toEqual([
      'GET /a app/OrderController.php#OrderController.show',
      'GET /b app/OrderController.php#OrderController.update',
      'GET /d app/OrderController.php#OrderController.store',
    ]);
    expect(missing.map((m) => m.route)).toEqual(['GET /c']); // an action the scan cannot evaluate, as before
  });

  it('[$this->controller, m]: the class-string default of the property, else its declared type', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Routes.php': `<?php
namespace App\\Http;
use Illuminate\\Support\\Facades\\Route;
class Routes {
  protected $orders = OrderController::class;
  private OrderController $typed;
  public function map() {
    Route::get('by-default', [$this->orders, 'index']);
    Route::get('by-type', [$this->typed, 'show']);
  }
}
`,
    });
    expect(eps.map((e) => `${e.label} ${e.method.name}`)).toEqual(['GET /by-default index', 'GET /by-type show']);
  });

  it('a route whose action has no method is reported as missing (not for closures) and not listed', async () => {
    const { labels, missing } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::get('gone', [OrderController::class, 'nothing']);
Route::get('closure', function () { return 1; });
Route::get('arrow', fn () => 1);
Route::get('odd', 42);
Route::get('no-action');
`,
    });
    expect(labels).toEqual([]);
    expect(missing).toEqual([
      { route: 'GET /gone', file: 'routes/web.php', controller: 'App\\Http\\OrderController', method: 'nothing' },
      { route: 'GET /odd', file: 'routes/web.php', controller: undefined, method: undefined },
    ]);
  });
});

describe('FR-18.7 PHP entry points: route files, groups and names', () => {
  it('a route file resolves classes through its `use` statements (aliases, inside a namespace block too)', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
namespace {
  use App\\Http\\OrderController as Orders;
  use App\\Http\\{OrderController};
  Route::get('alias', [Orders::class, 'index']);
  Route::get('grouped', [OrderController::class, 'show']);
}
`,
    });
    expect(eps.map((e) => `${e.label} ${e.method.key}`)).toEqual([
      'GET /alias app/OrderController.php#OrderController.index',
      'GET /grouped app/OrderController.php#OrderController.show',
    ]);
  });

  it('group options the scan cannot know are ignored; ->name() with an unknown value gives no route name', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::group(['prefix' => $unknown, 'middleware' => 'auth', 'as' => 'shop.'], function () {
  Route::get('a', [OrderController::class, 'index'])->name($unknown);
  Route::get('b', [OrderController::class, 'show'])->name('b');
});
Route::prefix('x')->group(fn () => Route::get('c', [OrderController::class, 'store']));
`,
    });
    expect(eps.map((e) => `${e.label} ${e.routeName ?? '-'}`)).toEqual(['GET /a -', 'GET /b shop.b', 'GET /x/c -']);
  });

  it('routes registered on an injected router ($this->router) inside a class, and on $router in a route file', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Registrar.php': `<?php
namespace App\\Http;
class Registrar {
  public function __construct(private $router) {}
  public function map() { $this->router->get('injected', [OrderController::class, 'index']); }
}
`,
      'routes/web.php': `<?php
$router->post('plain', [App\\Http\\OrderController::class, 'store']);
`,
    });
    expect(labels).toEqual(['http GET /injected', 'http POST /plain']);
  });
});

describe('FR-18.7 PHP entry points: commands, PHPUnit tests', () => {
  it('Artisan commands: the $signature name, else $name, else Class.handle; Symfony commands by execute()', async () => {
    const command = (name: string, props: string, method = 'handle') => `<?php
namespace App\\Console;
class ${name} extends \\Illuminate\\Console\\Command { ${props} public function ${method}() { return 0; } }
`;
    const { eps } = await scan({
      'app/Console/Expire.php': command('Expire', "protected $signature = '  orders:expire {--days=}';"),
      'app/Console/Named.php': command('Named', "protected $name = 'orders:named';"),
      'app/Console/Bare.php': command('Bare', ''),
      'app/Console/Sym.php': `<?php
namespace App\\Console;
class Sym extends \\Symfony\\Component\\Console\\Command\\Command { protected function execute($in, $out) { return 0; } }
`,
    });
    expect(eps.map((e) => `${e.kind} ${e.label} ${e.method.name}`).sort()).toEqual([
      'cli Bare.handle handle',
      'cli Sym.execute execute',
      'cli orders:expire handle',
      'cli orders:named handle',
    ]);
  });

  it('PHPUnit tests: test… methods, #[Test], @test; not in classes that are no TestCase', async () => {
    const { labels } = await scan({
      'tests/OrderTest.php': `<?php
namespace Tests;
use PHPUnit\\Framework\\Attributes\\Test;
class OrderTest extends \\PHPUnit\\Framework\\TestCase {
  public function testItShips() {}
  #[Test]
  public function it_bills() {}
  #[\\PHPUnit\\Framework\\Attributes\\DataProvider('x')]
  public function helper() {}
  /** @test */
  public function it_refunds() {}
}
`,
      'tests/Support.php': `<?php
namespace Tests;
class Support { public function testNotATest() {} }
`,
    });
    expect(labels).toEqual(['test OrderTest.testItShips', 'test OrderTest.it_bills', 'test OrderTest.it_refunds']);
  });
});

describe('FR-18.11 PHP entry points: routes of first-party packages', () => {
  const pkg = (files: Record<string, string>) => ({
    'vendor/composer/autoload_psr4.php': `<?php
$vendorDir = dirname(__DIR__);
return array('Shop\\\\Routes\\\\' => array($vendorDir . '/shop/routes/src'));
`,
    'vendor/shop/routes/src/OrderController.php': CONTROLLER.replace('App\\Http', 'Shop\\Routes'),
    ...files,
  });

  it('the call site passes its values by position and by name; the same call twice is followed once', async () => {
    const { eps } = await scan(
      pkg({
        'vendor/shop/routes/src/Builder.php': `<?php
namespace Shop\\Routes;
class Builder {
  public function __construct(private $router) {}
  public function register($version, $area = 'shop', $extra = 'x') {
    $this->router->get($version . '/' . $area . '/' . $extra, [OrderController::class, 'index']);
  }
}
`,
        'routes/web.php': `<?php
use Shop\\Routes\\Builder;
Route::group(['prefix' => 'p'], function () {
  app(Builder::class)->register('v1', extra: 'y');
  app(Builder::class)->register('v1', extra: 'y');
  app(Builder::class)->register(area: 'admin', version: 'v2');
});
`,
      }),
    );
    expect(eps.map((e) => `${e.label} ${e.detail}`)).toEqual(['GET /p/v1/shop/y route · routes', 'GET /p/v2/admin/x route · routes']);
  });

  it('a registrar kept in a variable of the route file is followed too', async () => {
    const { labels } = await scan(
      pkg({
        'vendor/shop/routes/src/Builder.php': `<?php
namespace Shop\\Routes;
class Builder {
  public function __construct(private $router) {}
  public function register($v) { $this->router->get($v . '/x', [OrderController::class, 'index']); }
}
`,
        'routes/web.php': `<?php
use Shop\\Routes\\Builder;
$builder = app(Builder::class);
Route::group(['prefix' => 'p'], function () use ($builder) {
  $builder->register('v');
});
`,
      }),
    );
    expect(labels).toEqual(['http GET /p/v/x']);
  });

  it('the group\'s route-name prefix reaches the package; a package registrar that calls itself is followed five calls deep', async () => {
    const { eps } = await scan(
      pkg({
        'vendor/shop/routes/src/Builder.php': `<?php
namespace Shop\\Routes;
class Builder {
  public function __construct(private $router) {}
  public function register($v) {
    $this->router->get($v . '/x', [OrderController::class, 'index'])->name('orders');
    $this->register($v . '/n');
  }
}
`,
        'routes/web.php': `<?php
use Shop\\Routes\\Builder;
Route::group(['prefix' => 'p', 'as' => 'shop.'], function () {
  app(Builder::class)->register('v');
});
`,
      }),
    );
    expect(eps.map((e) => `${e.label} ${e.routeName}`)).toEqual([
      'GET /p/v/x shop.orders',
      'GET /p/v/n/x shop.orders',
      'GET /p/v/n/n/x shop.orders',
      'GET /p/v/n/n/n/x shop.orders',
      'GET /p/v/n/n/n/n/x shop.orders',
      'GET /p/v/n/n/n/n/n/x shop.orders',
    ]);
  });
});

describe('FR-18.7 PHP entry points: route files mounted by a provider', () => {
  it('the prefix / namespace the provider mounts each file with (also from a closure); values it cannot know are left out; nested classes are not read', async () => {
    const { labels, eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/RouteServiceProvider.php': `<?php
namespace App\\Providers;
use Illuminate\\Support\\Facades\\Route;
class RouteServiceProvider {
  protected $namespace = 'App\\Http';
  public function map() {
    Route::prefix('api')->namespace($this->namespace)->group(base_path('routes/api.php'));
    Route::prefix('admin')->middleware(config('x'))->namespace($this->missing)->group(__DIR__ . '/../routes/admin.php');
    Route::prefix('none')->group();
    $later = function () { Route::prefix('hooks')->group(base_path('routes/hooks.php')); };
    $arrow = fn () => Route::prefix('arrow')->group(base_path('routes/arrow.php'));
    Route::prefix('ext')->namespace($other->namespace)->group(base_path('routes/ext.php'));
    $nested = new class { public function map() { Route::prefix('nested')->group(base_path('routes/web.php')); } };
  }
}
`,
      'routes/api.php': `<?php
Route::get('orders', 'OrderController@index');
`,
      'routes/admin.php': `<?php
Route::get('stats', [App\\Http\\OrderController::class, 'show']);
`,
      'routes/hooks.php': `<?php
Route::post('paid', [App\\Http\\OrderController::class, 'store']);
`,
      'routes/web.php': `<?php
Route::get('home', [App\\Http\\OrderController::class, 'create']);
`,
      'routes/arrow.php': `<?php
Route::put('a', [App\\Http\\OrderController::class, 'update']);
`,
      // $other->namespace is not the provider's property: no namespace, the controller is not found
      'routes/ext.php': `<?php
Route::get('e', 'OrderController@edit');
`,
    });
    expect(labels).toEqual(['http GET /admin/stats', 'http GET /api/orders', 'http PUT /arrow/a', 'http POST /hooks/paid', 'http GET /home']);
    expect(eps.find((e) => e.label === 'GET /api/orders')?.method.key).toBe('app/OrderController.php#OrderController.index');
  });
});

describe('FR-18.7 PHP entry points: routes/api.php', () => {
  it('not mounted by a provider: under /api (Laravel\'s default)', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/api.php': `<?php
Route::get('orders', [App\\Http\\OrderController::class, 'index']);
`,
    });
    expect(labels).toEqual(['http GET /api/orders']);
  });
});

describe('FR-18.7 PHP entry points: what the scan cannot know', () => {
  it('class constants that refer to each other in a cycle, a constant of an unknown class: no URI (and no endless loop)', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Paths.php': `<?php
namespace App\\Http;
class Paths { const A = self::B . '/a'; const B = self::A . '/b'; const OK = 'ok'; }
`,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
use App\\Http\\Paths;
Route::get(Paths::A, [OrderController::class, 'index']);
Route::get($paths::OK, [OrderController::class, 'show']);
Route::get(Paths::OK, [OrderController::class, 'store']);
`,
    });
    expect(labels).toEqual(['http GET /ok']);
  });

  it('actions without a method: a controller alone, keyed entries; a resource without a controller; a match with no verb list', async () => {
    const { labels, missing } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::get('alone', [OrderController::class]);
Route::get('keyed', ['controller' => OrderController::class, 'method' => 'index']);
Route::resource('orders');
Route::match('get', 'one', [OrderController::class, 'index']);
`,
    });
    expect(labels).toEqual([]);
    expect(missing).toEqual([
      { route: 'GET /alone', file: 'routes/web.php', controller: undefined, method: undefined },
      { route: 'GET /keyed', file: 'routes/web.php', controller: undefined, method: undefined },
    ]);
  });

  it('group options: keys that are no string and empty slots are skipped; a group without options still applies its body', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::group([$key => 'x', , 'prefix' => 'shop'], function () {
  Route::get('a', [OrderController::class, 'index']);
});
Route::group(function () {
  Route::get('b', [OrderController::class, 'show']);
});
`,
    });
    expect(labels).toEqual(['http GET /shop/a', 'http GET /b']);
  });

  it('->name() without an argument gives no route name', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::get('a', [OrderController::class, 'index'])->name();
`,
    });
    expect(eps.map((e) => `${e.label} ${e.routeName ?? '-'}`)).toEqual(['GET /a -']);
  });

  it('routes registered inside an anonymous class of a route file count too', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
return new class {
  public function map() { Route::get('anon', [OrderController::class, 'index']); }
};
`,
    });
    expect(labels).toEqual(['http GET /anon']);
  });
});

describe('FR-18.7 PHP entry points: half-typed route files', () => {
  it('a call without a callee (php-parser\'s recovery from `foreach ($x as (function () {…})()`) does not stop the scan', async () => {
    const { labels } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
foreach ($versions as
(function () {})();
Route::get('after', [OrderController::class, 'index']);
`,
    });
    expect(labels).toEqual(['http GET /after']);
  });
});

describe('FR-18.7 PHP entry points: commands', () => {
  it('a command without handle() or execute() is no entry point', async () => {
    const { eps } = await scan({
      'app/Console/Draft.php': `<?php
namespace App\\Console;
class Draft extends \\Illuminate\\Console\\Command { protected $signature = 'orders:draft'; }
`,
      'app/Console/Bare.php': `<?php
namespace App\\Console;
class Bare extends \\Illuminate\\Console\\Command {}
`,
    });
    expect(eps).toEqual([]);
  });
});

describe('FR-18.14 PHP entry points: the middleware a route passes', () => {
  const GATE = `<?php
namespace App\\Http;
class Gate { public function handle($request, $next) { return $next($request); } }
`;
  const mw = (eps: { label: string; middleware?: { name: string; source: string; method?: unknown }[] }[], label: string) =>
    eps.find((e) => e.label === label)?.middleware?.map((m) => `${m.source} ${m.name}${m.method ? ' (handle)' : ''}`);

  it('the mount and the groups add theirs (withoutMiddleware / excluded_middleware remove names); values the scan cannot know are shown as written', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Gate.php': GATE,
      'app/Limits.php': `<?php
namespace App\\Http;
class Limits {
  public static function twice() { $a = 1; return 'throttle:2'; }
  public static function none() { return; }
  public static function echoes() { echo 1; }
  public static function hourly($n) { return 'throttle:' . $n; }
}
`,
      'app/RouteServiceProvider.php': `<?php
namespace App\\Providers;
use Illuminate\\Support\\Facades\\Route;
use App\\Http\\Gate;
class RouteServiceProvider {
  public function map() {
    Route::prefix('shop')->middleware([Gate::class, 'web', 'cors', config('x')])->withoutMiddleware('cors')->group(base_path('routes/shop.php'));
  }
}
`,
      'routes/shop.php': `<?php
use App\\Http\\OrderController;
use App\\Http\\Limits;
Route::group(['middleware' => 'auth', 'excluded_middleware' => ['web']], function () {
  Route::get('a', [OrderController::class, 'index'])->middleware($dynamic, Limits::twice(), Limits::none(), Limits::echoes(), Limits::hourly('5'));
});
`,
    });
    // the mount's config('x') cannot be known there: left out (a mount keeps only what it knows)
    expect(mw(eps, 'GET /shop/a')).toEqual([
      'group App\\Http\\Gate (handle)',
      'group auth',
      'route $dynamic',
      'route Limits::twice()',
      'route Limits::none()',
      'route Limits::echoes()',
      'route throttle:5',
    ]);
  });

  it('the HTTP kernel\'s aliases and groups: expanded to their classes (params kept), each marked with the name on the route; exclusions by alias or class', async () => {
    const mwVia = (eps: { label: string; middleware?: { name: string; className?: string; params?: string[]; via?: string; method?: unknown }[] }[], label: string) =>
      eps.find((e) => e.label === label)?.middleware?.map((m) => `${m.name} → ${m.className ?? '-'}${m.params ? ` (${m.params.join(',')})` : ''}${m.via ? ` via ${m.via}` : ''}${m.method ? ' (handle)' : ''}`);
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Http/Gate.php': GATE,
      'app/Http/Middleware/Lock.php': `<?php
namespace App\\Http\\Middleware;
class Lock { public function handle($request, $next, $key = null) { return $next($request); } }
`,
      'app/Http/Kernel.php': `<?php
namespace App\\Http;
use App\\Http\\Middleware\\Lock;
use Illuminate\\Foundation\\Http\\Kernel as HttpKernel;
class Kernel extends HttpKernel {
  protected $middlewareGroups = [
    'web' => [Gate::class, 'lock:session'],
    'api' => ['throttle:api', 'web'],
    'loop' => ['loop'],
    'odd' => 'not a list',
  ];
  protected $routeMiddleware = [
    'lock' => Lock::class,
    'unknown' => $this->dynamic,
  ];
}
`,
      'app/Http/OtherKernel.php': `<?php
namespace App\\Http;
class OtherKernel { protected $routeMiddleware = ['other' => Gate::class]; }
`,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::middleware('api')->group(function () {
  Route::get('a', [OrderController::class, 'index'])->middleware('lock:order', 'other', 'loop', 'unknown');
  Route::get('b', [OrderController::class, 'show'])->withoutMiddleware('lock');
  Route::get('c', [OrderController::class, 'store'])->withoutMiddleware(\\App\\Http\\Gate::class);
});
`,
    });
    expect(mwVia(eps, 'GET /a')).toEqual([
      'throttle:api → - (api) via api',
      'App\\Http\\Gate → App\\Http\\Gate via api (handle)',
      'lock:session → App\\Http\\Middleware\\Lock (session) via api (handle)',
      'lock:order → App\\Http\\Middleware\\Lock (order) via lock (handle)',
      // not a kernel of the framework: its aliases do not count
      'other → -',
      // a group naming itself stops, as its name
      'loop → - via loop',
      'unknown → -',
    ]);
    // the alias excludes every use of it (here: the group's lock:session); a class excludes what resolves to it
    expect(mwVia(eps, 'GET /b')?.map((x) => x.split(' → ')[0])).toEqual(['throttle:api', 'App\\Http\\Gate']);
    expect(mwVia(eps, 'GET /c')?.map((x) => x.split(' → ')[0])).toEqual(['throttle:api', 'lock:session']);
  });

  it('a value only partly known (`Lock::class . \':\' . Kind::CASE`, `\'lock:\' . $key`): its known name resolved, shown as written, no params', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Http/Gate.php': GATE,
      'app/Http/Kernel.php': `<?php
namespace App\\Http;
class Kernel extends \\Illuminate\\Foundation\\Http\\Kernel { protected $routeMiddleware = ['gate' => Gate::class]; }
`,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::get('a', [OrderController::class, 'index'])->middleware(\\App\\Http\\Gate::class . ':' . Kind::SHOP, 'gate:' . $key, 'nope:' . $key, $whole . ':x');
`,
    });
    expect(eps.find((e) => e.label === 'GET /a')?.middleware?.map((m) => `${m.name} → ${m.className ?? '-'}${m.params ? ' (params)' : ''}${m.via ? ` via ${m.via}` : ''}${m.method ? ' (handle)' : ''}`)).toEqual([
      // (a leading backslash is dropped, as on every name)
      "App\\Http\\Gate::class . ':' . Kind::SHOP → App\\Http\\Gate (handle)",
      "'gate:' . $key → App\\Http\\Gate via gate (handle)",
      "'nope:' . $key → -",
      "$whole . ':x' → -",
    ]);
  });

  it('Laravel 10 `$middlewareAliases` like `$routeMiddleware`', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'app/Http/Gate.php': GATE,
      'app/Http/Kernel.php': `<?php
namespace App\\Http;
class Kernel extends \\Illuminate\\Foundation\\Http\\Kernel { protected $middlewareAliases = ['gate' => Gate::class]; }
`,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::get('a', [OrderController::class, 'index'])->middleware('gate');
`,
    });
    expect(eps.find((e) => e.label === 'GET /a')?.middleware).toMatchObject([{ name: 'gate', className: 'App\\Http\\Gate', via: 'gate', method: { name: 'handle' } }]);
  });

  it("the kernel's global stack runs first on every route, the controller's (constructor, base classes first, only / except) last; a name once", async () => {
    const { eps } = await scan({
      'app/Http/Gate.php': GATE,
      'app/Http/Audit.php': `<?php
namespace App\\Http;
class Audit { public function handle($request, $next) { return $next($request); } }
`,
      'app/Http/Kernel.php': `<?php
namespace App\\Http;
class Kernel extends \\Illuminate\\Foundation\\Http\\Kernel {
  protected $middleware = [Audit::class];
  protected $routeMiddleware = ['gate' => Gate::class];
}
`,
      'app/Http/BaseController.php': `<?php
namespace App\\Http;
class BaseController { public function __construct() { $this->middleware('trace'); } }
`,
      'app/Http/OrderController.php': `<?php
namespace App\\Http;
class OrderController extends BaseController {
  public function __construct() {
    parent::__construct();
    $this->middleware('gate')->only('store');
    $this->middleware(['auth', 'trace'])->except(['index']);
    $this->other('x');
    $this->middleware('unknown')->only($this->actions); // names the scan cannot know: no action matches
  }
  public function index() {} public function store() {}
}
`,
      'app/Http/InvoiceController.php': `<?php
namespace App\\Http;
class InvoiceController { public function show() {} }
`,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
use App\\Http\\InvoiceController;
Route::get('a', [OrderController::class, 'index']);
Route::post('b', [OrderController::class, 'store'])->middleware('auth');
Route::get('c', [InvoiceController::class, 'show'])->withoutMiddleware(\\App\\Http\\Audit::class);
`,
    });
    expect(mw(eps, 'GET /a')).toEqual(['global App\\Http\\Audit (handle)', 'controller trace']);
    // 'auth' on the route already: once
    expect(mw(eps, 'POST /b')).toEqual(['global App\\Http\\Audit (handle)', 'route auth', 'controller trace', 'controller gate (handle)']);
    // withoutMiddleware does not remove the global stack (as in Laravel)
    expect(mw(eps, 'GET /c')).toEqual(['global App\\Http\\Audit (handle)']);
  });

  it("a first-party package followed from a group keeps the group's middleware and exclusions", async () => {
    const { eps } = await scan({
      'vendor/composer/autoload_psr4.php': `<?php
$vendorDir = dirname(__DIR__);
return array('Shop\\\\Routes\\\\' => array($vendorDir . '/shop/routes/src'));
`,
      'vendor/shop/routes/src/OrderController.php': CONTROLLER.replace('App\\Http', 'Shop\\Routes'),
      'vendor/shop/routes/src/Builder.php': `<?php
namespace Shop\\Routes;
class Builder {
  public function __construct(private $router) {}
  public function register() {
    $this->router->get('x', ['uses' => '\\Shop\\Routes\\OrderController@index', 'middleware' => ['csrf', 'log']]);
  }
}
`,
      'routes/web.php': `<?php
use Shop\\Routes\\Builder;
Route::middleware('web')->withoutMiddleware('csrf')->group(function () {
  app(Builder::class)->register();
});
`,
    });
    expect(mw(eps, 'GET /x')).toEqual(['group web', 'route log']);
  });

  it('->middleware() links that belong to no route (no verb in the chain, after a group) are ignored', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::prefix('x')->middleware('a');
Route::group([], fn () => null)->middleware('b');
Route::get('y', [OrderController::class, 'index']);
`,
    });
    expect(eps.map((e) => `${e.label} ${e.middleware?.length ?? 0}`)).toEqual(['GET /y 0']);
  });

  it('links before the verb (two of them, another kind of link too); an empty slot in a middleware list is skipped', async () => {
    const { eps } = await scan({
      'app/OrderController.php': CONTROLLER,
      'routes/web.php': `<?php
use App\\Http\\OrderController;
Route::middleware('m')->middleware('n')->get('w', [OrderController::class, 'index']);
Route::domain('shop.test')->middleware('k')->get('d', [OrderController::class, 'store']);
Route::get('z', [OrderController::class, 'show'])->middleware([, 'log']);
`,
    });
    expect([mw(eps, 'GET /w'), mw(eps, 'GET /d'), mw(eps, 'GET /z')]).toEqual([['route m', 'route n'], ['route k'], ['route log']]);
  });
});
