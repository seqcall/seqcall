import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ClassRef } from '@seqcall/protocol';
import type { ClassInfo } from '../src/adapter';
import { configFileOf, createClassifier, DefaultClassifier, isConfigFile, stripJsonComments } from '../src/classifier-impl';
import { C, FIXTURE_ROOT, sharedAdapter } from './helpers';

const adapter = sharedAdapter();
const configured = createClassifier(FIXTURE_ROOT);
/** Same project, built-in heuristics only. */
const builtin = new DefaultClassifier(FIXTURE_ROOT, {});

const classify = async (classifier = configured, key: string, usage = {}) => {
  const info = (await adapter.getClassInfo(key))!;
  return classifier.classify(info.ref, info, usage);
};

describe('Classifier: built-in heuristics (FR-7.1, FR-7.3)', () => {
  it('FR-7.1 role stereotypes from name suffix and decorators', async () => {
    expect((await classify(builtin, C.UserController)).stereotypes).toContain('controller');
    expect((await classify(builtin, C.UserService)).stereotypes).toEqual(['service']);
    expect((await classify(builtin, C.SqlUserRepository)).stereotypes).toEqual(['repository']);
    const decorated: ClassInfo = { ...(await adapter.getClassInfo(C.UserService))!, decorators: ['Controller'] };
    const ref: ClassRef = { key: 'src/web/thing.ts#Thing', name: 'Thing', kind: 'class' };
    expect(builtin.classify(ref, { ...decorated, ref }).stereotypes).toEqual(['controller']);
  });

  it('FR-7.1 «static», «singleton», «interface», «abstract», «module», «external», «unknown»', async () => {
    expect((await classify(builtin, C.Logger)).stereotypes).toEqual(['static']);
    expect((await classify(builtin, C.Database)).stereotypes).toEqual(['singleton']);
    expect((await classify(builtin, C.BillingService)).stereotypes).toEqual(['singleton', 'service']);
    expect((await classify(builtin, C.UserRepository)).stereotypes).toEqual(['interface', 'repository']);
    expect((await classify(builtin, C.Notifier)).stereotypes).toEqual(['abstract']);
    expect((await classify(builtin, C.format)).stereotypes).toEqual(['module']);
    expect(builtin.classify({ key: 'lib:express', name: 'express', kind: 'external' }, undefined).stereotypes).toEqual(['external']);
    expect(builtin.classify({ key: 'unknown', name: 'unknown', kind: 'unknown' }, undefined).stereotypes).toEqual(['unknown']);
  });

  it('FR-7.1 usage-dependent «static» and «seam»', async () => {
    expect((await classify(builtin, C.Database, { staticAccess: true })).stereotypes).toContain('static');
    expect((await classify(builtin, C.UserRepository, { injectedAsAbstraction: true })).stereotypes).toContain('seam');
  });

  it('FR-7.1 folder names give a role when name/decorators do not', async () => {
    expect((await classify(builtin, C.StripeGateway)).stereotypes).toEqual(['service']);
  });

  it('FR-7.3 layer inferred from well-known folder names; namespace = folder path', async () => {
    expect(await classify(builtin, C.UserController)).toMatchObject({ layer: 'Presentation', namespace: 'src/controllers' });
    expect(await classify(builtin, C.UserService)).toMatchObject({ layer: 'Application', namespace: 'src/services' });
    expect(await classify(builtin, C.User)).toMatchObject({ layer: 'Domain', namespace: 'src/domain' });
    expect(await classify(builtin, C.SqlUserRepository)).toMatchObject({ layer: 'Infrastructure', namespace: 'src/adapters' });
    expect((await classify(builtin, C.Database)).layer).toBe('Infrastructure');
    expect(await classify(builtin, C.Logger)).toEqual(expect.objectContaining({ layer: undefined, namespace: 'src/util' }));
    expect(builtin.layerOrder()).toEqual(['Presentation', 'Application', 'Domain', 'Infrastructure']);
  });
});

describe('Classifier: .seqcall.json (FR-7.2)', () => {
  it('FR-7.2 layer rules (path glob → layer) override inference and define band order', async () => {
    expect((await classify(configured, C.UserRepository)).layer).toBe('Ports');
    expect((await classify(configured, C.ReportGenerator)).layer).toBe('Presentation');
    expect((await classify(configured, C.Notifier)).layer).toBe('Infrastructure');
    expect(configured.layerOrder()).toEqual(['Presentation', 'Application', 'Ports', 'Domain', 'Infrastructure']);
  });

  it('FR-7.2 stereotype rules match by path, name regex and implemented/extended type', async () => {
    expect((await classify(configured, C.UserRepository)).stereotypes).toEqual(['interface', 'repository', 'port']);
    expect((await classify(configured, C.StripeGateway)).stereotypes).toEqual(['gateway']);
    expect((await classify(configured, C.EmailNotifier)).stereotypes).toEqual(['notifier']);
  });

  it('FR-7.2 decorator rules, disabling built-ins, and reloadConfig', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-'));
    try {
      const write = (cfg: object) => fs.writeFileSync(path.join(dir, '.seqcall.json'), JSON.stringify(cfg));
      write({ stereotypes: [{ stereotype: 'di', match: { decorator: 'Injectable' } }], disableBuiltinStereotypes: true });
      const c = createClassifier(dir);
      const info = (await adapter.getClassInfo(C.UserService))!;
      expect(c.classify(info.ref, info).stereotypes).toEqual(['di']);
      write({ layers: [{ name: 'Core', match: ['src/**'] }] });
      c.reloadConfig();
      expect(c.classify(info.ref, info)).toMatchObject({ stereotypes: ['service'], layer: 'Core' });
      expect(c.layerOrder()[0]).toBe('Core');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FR-7.3 layer detection: explicit layer folders, name hints, role folders', () => {
  const bare = createClassifier(fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-layers-')));
  const layer = (key: string, kind: ClassRef['kind'] = 'class') => bare.classify({ key, name: key.split('#')[1], kind }, undefined).layer;

  it('an explicit layer folder anywhere in the path beats a role folder below it (hexagonal modules)', async () => {
    expect(layer('apps/backend/src/modules/products/infrastructure/api/apiProducts.repository.ts#ApiProductsRepository')).toBe('Infrastructure');
    // …except inbound adapters (http/, routes/, controllers/ … under infrastructure/): Presentation
    expect(layer('src/modules/products/infrastructure/http/products.controller.ts#ProductsController')).toBe('Presentation');
    expect(layer('src/modules/products/infrastructure/persistence/knexProducts.repository.ts#KnexProductsRepository')).toBe('Infrastructure');
    expect(layer('src/modules/products/application/ports/productsRepository.ts#ProductsRepository', 'interface')).toBe('Application');
    expect(layer('src/modules/products/domain/entities/product.ts#Product')).toBe('Domain');
  });

  it('FR-7.3 inbound adapters inside infrastructure/ (http, routes, controllers, cli…) are Presentation; the outbound side stays Infrastructure', () => {
    const mod = (rel: string, name = 'x') => ({ key: `${rel}#<module>`, name, kind: 'module' as const });
    const cls = (rel: string, name: string) => ({ key: `${rel}#${name}`, name, kind: 'class' as const });
    expect(builtin.classify(mod('src/modules/users/infrastructure/http/users/get.route.ts'), undefined).layer).toBe('Presentation');
    expect(builtin.classify(cls('src/Shop.Infrastructure/Controllers/OrdersController.cs', 'OrdersController'), undefined).layer).toBe('Presentation');
    expect(builtin.classify(mod('src/infra/cli/commands/sync.ts'), undefined).layer).toBe('Presentation');
    // outbound: an external API wrapper, clients below http/, client / gateway names
    expect(builtin.classify(mod('src/modules/orders/infrastructure/api/apiOrders.repository.ts'), undefined).layer).toBe('Infrastructure');
    expect(builtin.classify(mod('src/infrastructure/http/clients/payments.ts'), undefined).layer).toBe('Infrastructure');
    expect(builtin.classify(cls('src/Shop.Infrastructure/Http/PaymentApiClient.cs', 'PaymentApiClient'), undefined).layer).toBe('Infrastructure');
    expect(builtin.classify(cls('src/infrastructure/http/stripe.gateway.ts', 'StripeGateway'), undefined).layer).toBe('Infrastructure');
    expect(builtin.classify(mod('src/infrastructure/persistence/users.repository.ts'), undefined).layer).toBe('Infrastructure');
    // an inbound folder above infrastructure/ does not count
    expect(builtin.classify(mod('src/http/infrastructure/db.ts'), undefined).layer).toBe('Infrastructure');
  });

  it('FR-7.8 why a class is in its layer: the rule that decided, its strength, the rules checked before it', () => {
    const cls = (rel: string, name: string, kind: 'class' | 'interface' = 'class') => ({ key: `${rel}#${name}`, name, kind });
    const why = (c: DefaultClassifier, rel: string, name: string, kind?: 'class' | 'interface') => c.classify(cls(rel, name, kind), undefined).layerReason!;
    // a Laravel package's exception handler: only the role folder decided
    expect(why(builtin, 'src/Core/Services/ErrorReportService.php', 'ErrorReportService')).toEqual({
      rule: 'role-folder',
      text: 'role folder `Services/`',
      strength: 'weak',
      notApplied: [
        'no layer rules in .seqcall.json',
        'no layer folder (presentation, application, domain, infrastructure, …) in the path',
        'the name gives no hint (…Client, …Gateway, …Controller, …)',
      ],
      path: 'src/Core/Services/ErrorReportService.php',
      folders: ['Services'],
    });
    expect(why(builtin, 'src/ApiClient/Http/RequestClient.php', 'RequestClient')).toMatchObject({ rule: 'name', text: 'name ends in `Client`', strength: 'weak' });
    expect(why(builtin, 'src/Shop.Infrastructure/Repos/SqlRepo.cs', 'SqlRepo')).toMatchObject({ rule: 'folder', text: 'layer folder `Infrastructure/`', strength: 'strong' });
    expect(why(builtin, 'src/infrastructure/http/users.route.ts', 'UsersRoute')).toMatchObject({ rule: 'inbound-adapter', text: 'inbound adapter folder `http/` inside `infrastructure/`', folders: ['infrastructure', 'http'] });
    // what starts work without a request drives the application like a route: Presentation, as the routes beside it
    expect(why(builtin, 'src/infrastructure/jobs/payment-reconciler.ts', 'PaymentReconciler')).toMatchObject({ rule: 'inbound-adapter', text: 'inbound adapter folder `jobs/` inside `infrastructure/`' });
    for (const f of ['workers', 'consumers', 'scheduler']) expect(builtin.classify({ key: `src/infrastructure/${f}/order-${f}.ts#Order${f}`, name: `Order${f}`, kind: 'class' }, undefined).layer).toBe('Presentation');
    // outside infrastructure/ the folder names nothing new; an outbound name still wins
    expect(builtin.classify({ key: 'src/jobs/x.ts#X', name: 'X', kind: 'class' }, undefined).layer).not.toBe('Presentation');
    expect(builtin.classify({ key: 'src/infrastructure/jobs/queue-client.ts#QueueClient', name: 'QueueClient', kind: 'class' }, undefined).layer).toBe('Infrastructure');
    // a dotted project folder: the part that decided
    expect(why(builtin, 'src/Shop.Infrastructure/Repos/SqlRepo.cs', 'SqlRepo').folders).toEqual(['Infrastructure']);
    expect(why(builtin, 'src/main.ts', 'Main')).toMatchObject({ rule: 'entry-file', text: 'entry file `main.ts` (composition root)' });
    // an interface: no name hint by design, its folder decides
    expect(why(builtin, 'src/api/paymentGateway.ts', 'PaymentGateway', 'interface').notApplied).toContain('no name hint for an interface (usually a port: its folder decides)');
    expect(why(builtin, 'src/misc/Thing.ts', 'Thing')).toMatchObject({ rule: 'none', text: 'no rule applies' });
    // a configured rule names itself and the glob that matched
    const custom = new DefaultClassifier(FIXTURE_ROOT, { layers: [{ name: 'Domain', match: ['src/enums/**'] }, { name: 'Application', match: ['src/x/**', 'src/Core/**'] }] });
    expect(why(custom, 'src/Core/Services/A.php', 'A')).toEqual({ rule: 'config', text: 'rule 2 in .seqcall.json: `src/Core/**`', strength: 'strong', notApplied: [], path: 'src/Core/Services/A.php' });
    expect(why(custom, 'src/other/B.php', 'B').notApplied[0]).toBe('no rule in .seqcall.json matches');
  });

  it('FR-7.9 why a box carries each stereotype: name, decorator, folder (weak), usage in this diagram, a config rule', () => {
    const ref = (rel: string, name: string, kind: ClassRef['kind'] = 'class') => ({ key: `${rel}#${name}`, name, kind });
    const reasons = (c: DefaultClassifier, r: ClassRef, info?: ClassInfo, usage = {}) => c.classify(r, info, usage).stereotypeReasons;
    expect(reasons(builtin, ref('src/Core/Services/ShopSettingsService.php', 'ShopSettingsService'), undefined, { injectedAsAbstraction: true, staticAccess: true })).toEqual([
      { stereotype: 'static', text: 'called statically in this diagram', inThisDiagram: true },
      { stereotype: 'service', text: 'name ends in `Service`' },
      { stereotype: 'seam', text: 'reached through an injected interface or abstract class in this diagram', inThisDiagram: true },
    ]);
    const info = { ref: ref('src/a.ts', 'Users'), decorators: ['Injectable'], implements: [], methods: [] } as unknown as ClassInfo;
    expect(reasons(builtin, ref('src/a.ts', 'Users'), info)).toEqual([{ stereotype: 'service', text: 'decorator `Injectable`' }]);
    expect(reasons(builtin, ref('src/repositories/users.ts', 'Users'))).toEqual([{ stereotype: 'repository', text: 'folder `repositories/` (only the folder name decided)', weak: true }]);
    expect(reasons(builtin, ref('src/ports/clock.ts', 'Clock', 'interface'))).toEqual([{ stereotype: 'interface', text: 'it is an interface' }, { stereotype: 'port', text: 'folder `ports/` (only the folder name decided)', weak: true }]);
    // a configured rule names itself and its criteria; it also drops the weak folder role
    const custom = new DefaultClassifier(FIXTURE_ROOT, { stereotypes: [{ stereotype: 'job', match: { name: 'Job$', path: 'app/Jobs/**' } }] });
    expect(reasons(custom, ref('app/Jobs/repositories/SendJob.php', 'SendJob'))).toEqual([{ stereotype: 'job', text: 'rule 1 in .seqcall.json: name `Job$`, path `app/Jobs/**`' }]);
    // the stereotypes themselves are what they were
    expect(custom.classify(ref('app/Jobs/repositories/SendJob.php', 'SendJob'), undefined).stereotypes).toEqual(['job']);
  });

  it('test code: «test», no layer — its folders say what it tests (Services/ is no «service» / Application); your own rules still win', () => {
    const cls = (rel: string, name: string) => ({ key: `${rel}#${name}`, name, kind: 'class' as const });
    const c = builtin.classify(cls('tests/Unit/Services/OrderServiceTest.php', 'OrderServiceTest'), undefined);
    expect(c.layer).toBeUndefined();
    expect(c.stereotypes).toEqual(['test']);
    expect(c.layerReason).toMatchObject({ rule: 'test', strength: 'strong' });
    expect(c.layerReason!.text).toMatch(/^test code/);
    expect(builtin.classify(cls('src/services/order.service.spec.ts', 'OrderServiceSpec'), undefined).layer).toBeUndefined();
    // a rule of yours decides first; `testFiles` replaces the defaults (here: nothing is test code)
    const ruled = new DefaultClassifier(FIXTURE_ROOT, { layers: [{ name: 'Application', match: ['tests/**'] }] });
    expect(ruled.classify(cls('tests/Unit/Services/OrderServiceTest.php', 'OrderServiceTest'), undefined).layer).toBe('Application');
    const none = new DefaultClassifier(FIXTURE_ROOT, { testFiles: [] });
    expect(none.classify(cls('tests/Unit/Services/OrderServiceTest.php', 'OrderServiceTest'), undefined)).toMatchObject({ layer: 'Application', stereotypes: ['service'] });
  });

  it('FR-7.11 the Laravel preset: detected from composer.json, after your own rules, named in the explanation; "none" turns it off', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-preset-'));
    try {
      fs.writeFileSync(path.join(tmp, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^8.0' } }));
      const cls = (rel: string, name: string) => ({ key: `${rel}#${name}`, name, kind: 'class' as const });
      const laravel = new DefaultClassifier(tmp);
      const c = (rel: string, name: string, k = laravel) => k.classify(cls(rel, name), undefined);
      expect(c('app/Models/Bet.php', 'Bet').layer).toBe('Domain');
      expect(c('app/Http/Requests/StoreBetRequest.php', 'StoreBetRequest').layer).toBe('Presentation');
      expect(c('app/Providers/RouteServiceProvider.php', 'RouteServiceProvider').layer).toBe('Presentation');
      expect(c('app/Jobs/SendReceipt.php', 'SendReceipt').layer).toBe('Application');
      expect(c('app/DTO/ShoppingCart.php', 'ShoppingCart').layer).toBe('Application');
      expect(c('app/Mail/Welcome.php', 'Welcome').layer).toBe('Infrastructure');
      expect(c('app/Models/Bet.php', 'Bet').layerReason).toMatchObject({ rule: 'preset', text: 'Laravel preset: `app/Models/**`', strength: 'strong', folders: ['Models'] });
      // project-specific folders are not the preset's business: the built-in rules still apply
      expect(c('app/Services/CartService.php', 'CartService').layerReason?.notApplied).toContain('no Laravel preset folder');
      // your rules come first; "none" turns the preset off; an explicit preset works without composer.json
      const own = new DefaultClassifier(tmp, { layers: [{ name: 'Application', match: ['app/Models/**'] }] });
      expect(c('app/Models/Bet.php', 'Bet', own).layerReason?.rule).toBe('config');
      expect(c('app/Jobs/SendReceipt.php', 'SendReceipt', new DefaultClassifier(tmp, { preset: 'none' })).layer).toBeUndefined(); // only the preset knows Jobs/
      expect(c('app/Models/Bet.php', 'Bet', new DefaultClassifier(FIXTURE_ROOT, { preset: 'laravel' })).layer).toBe('Domain');
      expect(c('app/Models/Bet.php', 'Bet', new DefaultClassifier(FIXTURE_ROOT, {})).layer).toBe('Domain'); // the built-in `models/` role folder
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FR-7.11 the Feature-Sliced Design preset: detected from its layer folders; the segment decides (api, model, ui), then the layer; FSD\'s import order as the dependency rule', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-fsd-'));
    try {
      for (const l of ['app', 'pages', 'widgets', 'entities', 'shared']) fs.mkdirSync(path.join(tmp, 'src', l), { recursive: true });
      const mod = (rel: string) => ({ key: `${rel}#<module>`, name: rel.split('/').pop()!.replace(/\.tsx?$/, ''), kind: 'module' as const });
      const fsd = new DefaultClassifier(tmp);
      const c = (rel: string, k = fsd) => k.classify(mod(rel), undefined);
      // as a Feature-Sliced Design frontend
      expect(c('src/shared/api/catalog.queries.ts').layer).toBe('Infrastructure');
      expect(c('src/pages/products/api/products.queries.ts').layer).toBe('Infrastructure');
      expect(c('src/pages/products/model/products.loader.ts').layer).toBe('Application');
      expect(c('src/entities/user/model/user.ts').layer).toBe('Domain');
      expect(c('src/pages/products/ui/layout/page.tsx').layer).toBe('Presentation');
      expect(c('src/shared/ui/button.tsx').layer).toBe('Presentation');
      expect(c('src/app/routes/login.tsx').layer).toBe('Presentation');
      // lib/ and config/ are helper segments in every FSD layer: no layer of their own (the file's code decides)
      for (const f of ['src/pages/products/index/lib/products.utils.ts', 'src/entities/user/lib/format.ts', 'src/shared/lib/dates.ts', 'src/widgets/nav/config/items.ts']) {
        expect(c(f).layer, f).toBeUndefined();
      }
      // a file outside any segment: its FSD layer, a weak signal (a whole folder, not a segment)
      expect(c('src/pages/products/index.ts').layerReason).toMatchObject({ rule: 'preset', text: 'Feature-Sliced Design preset: `src/pages/**`', strength: 'weak' });
      expect(c('src/entities/user/index.ts').layer).toBe('Domain');
      expect(c('src/pages/products/ui/page.tsx').layerReason?.strength).toBe('strong');
      // on purpose, and the card says so (not "no preset folder")
      expect(c('src/shared/lib/dates.ts').layerReason?.notApplied).toContain('Feature-Sliced Design preset: `lib/` is helper code, no layer of its own');
      expect(c('src/shared/lib/dates.ts').layerReason?.notApplied).not.toContain('no Feature-Sliced Design preset folder');
      expect(c('src/pages/products/index/lib/products.utils.ts').layerReason?.noted).toEqual(['Feature-Sliced Design preset: `lib/` is helper code, no layer of its own']);
      // shared code outside FSD's segments: no layer either, said as such
      expect(c('src/shared/store/jotai.ts').layerReason?.noted).toEqual(['Feature-Sliced Design preset: `shared/store/` is shared code, no layer of its own']);
      expect(c('src/features/x/helpers/a.ts').layerReason?.noted).toBeUndefined();
      expect(c('src/shared/api/client.ts').layerReason).toMatchObject({ rule: 'preset', text: 'Feature-Sliced Design preset: `src/**/api/**`', folders: ['api'] });
      // shared lowest: a model may use api (no violation), api may not use a model
      expect(fsd.layerRing('Infrastructure')!).toBeLessThan(fsd.layerRing('Application')!);
      expect(fsd.layerRing('Domain')!).toBeLessThan(fsd.layerRing('Application')!);
      expect(fsd.layerRing('Application')!).toBeLessThan(fsd.layerRing('Presentation')!);
      // a project's own dependency rule wins; "none" turns it off; not detected without FSD's folders
      expect(new DefaultClassifier(tmp, { dependencyRule: { Domain: 0, Infrastructure: 2 } }).layerRing('Infrastructure')).toBe(2);
      expect(c('src/shared/api/client.ts', new DefaultClassifier(tmp, { preset: 'none' })).layerReason?.rule).not.toBe('preset');
      expect(c('src/shared/api/client.ts', new DefaultClassifier(FIXTURE_ROOT, {})).layerReason?.rule).not.toBe('preset');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('without an explicit layer folder, concrete clients/gateways are Infrastructure and controllers Presentation', async () => {
    expect(layer('src/api/shopApiClient.ts#ShopApiClient')).toBe('Infrastructure');
    expect(layer('src/web/user-controller.ts#UserController')).toBe('Presentation');
    // interfaces are ports: their folder decides
    expect(layer('src/api/paymentGateway.ts#PaymentGateway', 'interface')).toBe('Presentation');
  });

  it('FR-7.3 entry files at a source root are the composition root (Presentation), interfaces declared there too', async () => {
    expect(layer('src/main.ts#<module>', 'module')).toBe('Presentation');
    expect(layer('src/main.ts#Streams', 'interface')).toBe('Presentation');
    expect(layer('index.js#<module>', 'module')).toBe('Presentation');
    expect(layer('apps/backend/src/server.ts#<module>', 'module')).toBe('Presentation');
    expect(layer('lib/cli.mjs#<module>', 'module')).toBe('Presentation');
    // not an entry name, or not at a source root (barrels deeper down)
    expect(layer('src/run.ts#<module>', 'module')).toBeUndefined();
    expect(layer('src/util/index.ts#<module>', 'module')).toBeUndefined();
    // an explicit layer folder still wins
    expect(layer('src/application/index.ts#<module>', 'module')).toBe('Application');
  });

  it('role folders remain the fallback', async () => {
    expect(layer('src/api/routes.ts#Routes')).toBe('Presentation');
    expect(layer('src/services/billing.ts#Billing')).toBe('Application');
    expect(layer('src/repositories/user.ts#UserStore')).toBe('Infrastructure');
  });
});

describe('FR-7.3 layer detection: C# / .NET solution conventions', () => {
  const bare = createClassifier(fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-cs-')));
  const classify = (key: string, kind: ClassRef['kind'] = 'class', decorators: string[] = []) => {
    const ref: ClassRef = { key, name: key.split('#')[1], kind };
    const info: ClassInfo = {
      ref,
      decorators,
      implements: [],
      fields: [],
      constructorParams: [],
      hasPrivateConstructor: false,
      hasStaticInstance: false,
      allMembersStatic: false,
      isExportedInstance: false,
      methods: [],
    };
    return bare.classify(ref, info);
  };

  it('FR-7.3 Program.cs / Startup.cs are the composition root in any project folder', () => {
    expect(classify('src/Worker/Program.cs#Program').layer).toBe('Presentation');
    expect(classify('src/Api/Startup.cs#Startup').layer).toBe('Presentation');
    expect(classify('src/Shop.Infrastructure/Program.cs#Program').layer).toBe('Infrastructure'); // explicit folder wins
  });

  it('explicit layer names inside dotted project folders count', () => {
    expect(classify('src/Billing.Infrastructure/ApiClient/X.cs#X').layer).toBe('Infrastructure');
    expect(classify('src/Billing.Application/Orders/PlaceOrder.cs#PlaceOrder').layer).toBe('Application');
    expect(classify('src/Shop.Presentation/Pages/Index.cs#IndexModel').layer).toBe('Presentation');
  });

  it('a Clean Architecture "Core" project is Application; an explicit Domain folder inside it wins', () => {
    expect(classify('src/Billing.Core/Services/CouponService.cs#CouponService')).toMatchObject({
      layer: 'Application',
      stereotypes: ['service'],
      namespace: 'src/Billing.Core/Services',
    });
    expect(classify('src/Billing.Core/Domain/Coupon.cs#Coupon').layer).toBe('Domain');
    expect(classify('src/Billing.Core/Interfaces/IVoucherRepository.cs#IVoucherRepository', 'interface').layer).toBe('Application');
    expect(classify('src/Interfaces/IClock.cs#IClock', 'interface').layer).toBeUndefined();
  });

  it('a Web project is Presentation; [ApiController] makes a «controller»', () => {
    expect(classify('src/Billing.Web/Controllers/CouponsController.cs#CouponsController', 'class', ['ApiController', 'Route'])).toMatchObject({
      layer: 'Presentation',
      stereotypes: ['controller'],
    });
    expect(classify('src/Sample.Web/Endpoints/Health.cs#Health').layer).toBe('Presentation');
    expect(classify('src/Sample.Web/Endpoints/Status.cs#Status', 'class', ['ApiController']).stereotypes).toEqual(['controller']);
  });
});

describe('FR-7.6 layer display order is independent of rule priority', () => {
  const withConfig = (cfg: object) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-order-'));
    fs.writeFileSync(path.join(dir, '.seqcall.json'), JSON.stringify(cfg));
    return createClassifier(dir);
  };

  it('a "Move to layer" rule at the front does not move Domain to the front', () => {
    const c = withConfig({ layers: [{ name: 'Domain', match: ['src/Core/Utils/DateUtil.cs'] }, { name: 'Domain', match: ['src/Core/Utils/Enums.cs'] }] });
    expect(c.layerOrder()).toEqual(['Presentation', 'Application', 'Domain', 'Infrastructure']);
  });

  it('custom layers keep their configured position relative to the built-in ones', () => {
    const c = withConfig({ layers: [
      { name: 'Domain', match: ['src/x.ts'] }, // priority rule first
      { name: 'Presentation', match: ['src/web/**'] }, { name: 'Application', match: ['src/app/**'] },
      { name: 'Ports', match: ['src/ports/**'] }, { name: 'Infrastructure', match: ['src/infra/**'] },
    ] });
    expect(c.layerOrder()).toEqual(['Presentation', 'Application', 'Ports', 'Domain', 'Infrastructure']);
  });

  it('an explicit layerOrder wins', () => {
    const c = withConfig({ layerOrder: ['Infrastructure', 'Domain'], layers: [{ name: 'Gateways', match: ['g/**'] }] });
    expect(c.layerOrder()).toEqual(['Infrastructure', 'Domain', 'Gateways', 'Presentation', 'Application']);
  });
});

describe('Classifier: configs at the edges (FR-7.2, FR-7.11, FR-25.3)', () => {
  const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'seqcall-cls-'));
  const ref = (key: string, kind: ClassRef['kind'] = 'class'): ClassRef => ({ key, name: key.replace(/^.*#/, ''), kind });

  it('FR-25.3 a borrowed config: not JSON, not an object, or with a pattern that could freeze the editor is refused; cleared, the file is used again', () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, '.seqcall.json'), JSON.stringify({ layers: [{ name: 'Domain', match: 'src/**' }] }));
      const c = new DefaultClassifier(root);
      const layer = () => c.classify(ref('src/a.ts#A'), undefined).layer;
      expect(layer()).toBe('Domain');
      expect(() => c.setConfigOverride('{ nope')).toThrow(/^The shared \.seqcall\.json is not valid JSON: /);
      for (const text of ['[]', 'null', '7']) expect(() => c.setConfigOverride(text)).toThrow('The shared .seqcall.json is not an object.');
      expect(() => c.setConfigOverride(JSON.stringify({ stereotypes: [{ stereotype: 'x', match: { name: '(a+)+$' } }] }))).toThrow(
        'The shared .seqcall.json was not used: the stereotype rule "x" has a pattern that repeats a repeated group (`(a+)+$`), which can freeze the editor.',
      );
      expect(() => c.setConfigOverride(JSON.stringify({ stereotypes: [{ stereotype: 'x', match: { implements: 'I'.repeat(201) } }] }))).toThrow(/has a pattern that is longer than 200 characters\.$/);
      expect(layer()).toBe('Domain'); // nothing changed
      // a pattern that is no string is not checked (the rule is skipped when compiled); a null rule is skipped
      c.setConfigOverride(JSON.stringify({ layers: [{ name: 'Application', match: 'src/**' }], stereotypes: [null, { stereotype: 'odd', match: { name: 5 } }] }));
      expect(layer()).toBe('Application');
      // reloading keeps the borrowed config
      c.reloadConfig();
      expect(layer()).toBe('Application');
      c.setConfigOverride(undefined);
      expect(layer()).toBe('Domain');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('FR-7.2 the config file is .seqcall.json in the project root', () => {
    expect(configFileOf('/p/app')).toBe('/p/app/.seqcall.json');
    expect(configFileOf('/p/app/')).toBe('/p/app/.seqcall.json');
    expect([isConfigFile('/p/app/.seqcall.json'), isConfigFile('x/seqcall.json'), isConfigFile('x/.other.json')]).toEqual([true, false, false]);
  });

  it('FR-7.2 a config file that is not JSON is reported and the defaults apply; settings of the wrong type are ignored', () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, '.seqcall.json'), '{ "layers": [');
      const broken = new DefaultClassifier(root);
      expect(broken.configError).toMatch(/^\.seqcall\.json: /);
      expect(broken.classify(ref('src/domain/a.ts#A'), undefined).layer).toBe('Domain');
      const typed = new DefaultClassifier(root, { associationNames: 'all', findings: 'x' as never, pipeline: false as never, dependencyRule: { Domain: 0, Web: 'x' as never } });
      expect([typed.associationNames(), typed.findingsConfig(), typed.pipelineConfig(), typed.layerRing('Domain'), typed.layerRing('Web')]).toEqual(['all', undefined, undefined, 0, undefined]);
      const objects = new DefaultClassifier(root, { findings: { maxDependencies: 3 }, pipeline: { route: false } });
      expect([objects.associationNames(), objects.findingsConfig(), objects.pipelineConfig()]).toEqual(['non-obvious', { maxDependencies: 3 }, { route: false }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('FR-7.2 stereotype rules: malformed ones are skipped, an invalid regex is reported, a rule without criteria matches every class', () => {
    const c = new DefaultClassifier('/nowhere', {
      stereotypes: [
        { stereotype: 'bad', match: { name: '(' } },
        { stereotype: 'everything', match: {} },
        // malformed: no criteria, no stereotype
        { stereotype: 'nameless' } as never,
        { match: {} } as never,
        { stereotype: 'decorated', match: { decorator: '@Injectable' } },
      ],
      disableBuiltinStereotypes: true,
    });
    expect(c.configError).toMatch(/^\.seqcall\.json: invalid rule for "bad": /);
    const r = c.classify(ref('src/a.ts#A'), undefined);
    expect(r.stereotypes).toEqual(['everything']);
    expect(r.stereotypeReasons).toEqual([{ stereotype: 'everything', text: 'rule 2 in .seqcall.json' }]);
    // a decorator rule needs the decorator: no class info, or other decorators, do not match
    const info = (decorators?: string[]) => ({ ref: ref('src/a.ts#A'), ...(decorators ? { decorators } : {}) }) as unknown as ClassInfo;
    expect(c.classify(ref('src/a.ts#A'), info(['Injectable'])).stereotypes).toEqual(['everything', 'decorated']);
    expect(c.classify(ref('src/a.ts#A'), info()).stereotypes).toEqual(['everything']);
  });

  it('FR-7.2 a layer rule with one glob as a string, one without globs; a class without a file has no path; an abstract class gets no name hint', () => {
    const c = new DefaultClassifier('/nowhere', { layers: [{ name: 'Empty' } as never, { name: 'Domain', match: 'model/**' as never }] });
    expect(c.classify(ref('model/a.ts#A'), undefined).layerReason).toMatchObject({ rule: 'config', text: 'rule 2 in .seqcall.json: `model/**`', path: 'model/a.ts' });
    expect(c.classify(ref('Global'), undefined).layerReason).not.toHaveProperty('path');
    expect(c.classify(ref('src/misc/Base.ts#Base', 'abstract'), undefined).layerReason!.notApplied).toContain('no name hint for an abstract class (usually a port: its folder decides)');
  });

  it('FR-7.2 the config may have comments; text in strings that looks like one stays', () => {
    expect(JSON.parse(stripJsonComments('{ "url": "http://x/*y*/", // the url\n /* more */ "n": 1 }'))).toEqual({ url: 'http://x/*y*/', n: 1 });
  });

  it('FR-7.3 files without an extension, or dotfiles, are no entry files', () => {
    const c = new DefaultClassifier('/nowhere', {});
    expect(c.classify(ref('src/main#main', 'module'), undefined).layerReason!.rule).not.toBe('entry-file');
    expect(c.classify(ref('src/.main#main', 'module'), undefined).layerReason!.rule).not.toBe('entry-file');
  });

  it('FR-7.11 FSD: its layer folders at the project root; configured as "fsd" without them, its globs start at src/', () => {
    const root = tmpRoot();
    try {
      for (const l of ['app', 'pages', 'entities', 'features', 'shared']) fs.mkdirSync(path.join(root, l));
      const atRoot = new DefaultClassifier(root);
      expect(atRoot.classify(ref('entities/user/model/user.ts#<module>', 'module'), undefined).layerReason).toMatchObject({ rule: 'preset', text: 'Feature-Sliced Design preset: `entities/*/model/**`' });
      const configured = new DefaultClassifier('/nowhere', { preset: 'FSD' });
      expect(configured.classify(ref('src/entities/user/model/user.ts#<module>', 'module'), undefined).layerReason).toMatchObject({ rule: 'preset', text: 'Feature-Sliced Design preset: `src/entities/*/model/**`' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

