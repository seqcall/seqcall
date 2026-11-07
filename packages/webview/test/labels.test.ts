import { describe, expect, it } from 'vitest';
import type { Message } from '@seqcall/protocol';
import { abbreviateArgument, describeHideFilter, formatLocation, fitArgumentList, formatMessageLabel, fullCallText, shortType, stripComments, truncate } from '../src/sequence/labels';
import { fitStereotypes, fitText, estimateTextWidth, shownStereotypes, stereotypeText } from '../src/measure';
import { cloneSequence } from '../dev/mock-data';

const d = cloneSequence();
const byId = (id: string) => d.messages.find((m) => m.id === id)!;

describe('message labels (FR-9)', () => {
  it('FR-9.2 truncates to the maximum length including the ellipsis', () => {
    expect(truncate('abcdefghijkl', 5)).toBe('abcd…');
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefghijkl', 5)).toHaveLength(5);
  });

  it('FR-9.2 fits the whole argument list into the budget and keeps the full call for the tooltip', () => {
    const m = byId('root/1:placeOrder/2:total');
    const l = formatMessageLabel(m, { showArguments: true, maxArgumentLength: 10 });
    expect(l.name).toBe('total');
    expect(l.args).toBe('(ite…, cus…)');
    expect(l.args.length - 2).toBeLessThanOrEqual(10);
    expect(l.full).toBe('PriceCalculator.total(items.filter(i => i.quantity > 0 && !i.isGift), customer.discountRate)');
  });

  it('FR-9.2 shares the budget fairly: short arguments stay whole, long ones are cut', () => {
    const args = fitArgumentList(['coupon', 'allowMultipleOpenCoupons: false', 'token'], 30);
    expect(args[0]).toBe('coupon');
    expect(args[2]).toBe('token');
    expect(args[1]).toMatch(/^allowMultip.*…$/);
    expect(args.join(', ').length).toBeLessThanOrEqual(30);
    // too many arguments for the budget: leading ones kept, the rest becomes "…"
    const many = fitArgumentList(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta'], 20);
    expect(many.at(-1)).toBe('…');
    expect(many.join(', ').length).toBeLessThanOrEqual(20);
  });

  it('FR-9.2 collapses whitespace in multi-line arguments', () => {
    const m: Message = { ...byId('root/2:toDto'), args: ['build(\n  a,\n  b\n)'] };
    expect(formatMessageLabel(m, { showArguments: true, maxArgumentLength: 30 }).args).toBe('(build(a, b))');
  });

  it('FR-9 abbreviates structurally noisy arguments before truncation, full text in the tooltip', () => {
    const args = ['id', '{\n  name: user.name,\n  // keep it\n  age: 3\n}', '(u) => u.active', 'function (x) { return x; }', '[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]'];
    const m: Message = { ...byId('root/2:toDto'), args };
    const l = formatMessageLabel(m, { showArguments: true, maxArgumentLength: 30 });
    expect(l.args).toBe('(id, {…}, (u) => …, fn, […])');
    expect(l.full).toContain('name: user.name');
    expect(l.full).toContain('u.active');
  });

  describe('abbreviateArgument', () => {
    const ab = (s: string, max = 30) => abbreviateArgument(s, max);
    it('object literals → {…}, empty objects stay', () => {
      expect(ab('{ a: 1 }')).toBe('{…}');
      expect(ab('{}')).toBe('{}');
      expect(ab('{ ...rest, nested: { deep: true } }')).toBe('{…}');
    });
    it('array literals → […] only when longer than the limit', () => {
      expect(ab('[a, b]')).toBe('[a, b]');
      expect(ab('[first, second, third, fourth, fifth]')).toBe('[…]');
    });
    it('arrow functions and function expressions', () => {
      expect(ab('() => doIt()')).toBe('() => …');
      expect(ab('async (req, res) => {\n  await next();\n}')).toBe('(req, res) => …');
      expect(ab('item => item.price * item.quantity')).toBe('item => …');
      expect(ab('(a: Map<string, number>, b: string): void => {}')).toBe('(…) => …');
      expect(ab('async function handler(e) { log(e); }')).toBe('fn');
    });
    it('string and template literals are truncated inside their quotes', () => {
      expect(ab('`getUser ${id}`')).toBe('`getUser ${id}`');
      expect(ab('`a very long template literal with ${value} interpolated`', 20)).toBe('`a very long templ…`');
      expect(ab("'short'")).toBe("'short'");
      expect(ab("'a rather long string literal value'", 12)).toBe("'a rather…'");
    });
    it('long expressions collapse inner blocks before truncating', () => {
      expect(ab('items.map((i) => {\n  return i.id;\n})', 30)).toBe('items.map((i) => {…})');
      expect(ab('create({ a: 1, b: 2, c: 3, d: 4, e: 5 })', 30)).toBe('create({…})');
      expect(ab('items.filter(i => i.quantity > 0 && !i.isGift)', 10)).toBe('items.fil…');
    });
    it('comments are dropped, but not inside strings', () => {
      expect(stripComments('a, // note\nb /* x */')).toBe('a, \nb  ');
      expect(ab("'http://example.com'")).toBe("'http://example.com'");
      expect(ab('readConfig() // fallback\n')).toBe('readConfig()');
      // Arguments arrive compacted to one line: a line comment then has no end.
      expect(ab("{ // it's `typeof`, not a version check canFetch: typeof fetch === 'function' }")).toBe('{…}');
    });
  });

  it('FR-6.3 stereotypes are rendered on one line and truncated inside the guillemets', () => {
    expect(stereotypeText([])).toBeUndefined();
    expect(stereotypeText(['interface', 'repository', 'port'])).toBe('«interface, repository, port»');
    const fitted = fitStereotypes(['interface', 'repository', 'port', 'seam'], 80, estimateTextWidth)!;
    expect(fitted.startsWith('«')).toBe(true);
    expect(fitted.endsWith('…»')).toBe(true);
    expect(estimateTextWidth(fitted, 'stereotype')).toBeLessThanOrEqual(80);
  });

  it('FR-7.9 no «seam» on a box that is itself an «interface» / «port» (the tooltip keeps it)', () => {
    expect(shownStereotypes(['interface', 'seam'], 'IOrders')).toEqual(['interface']);
    expect(shownStereotypes(['port', 'seam'], 'Mailer')).toEqual(['port']);
    expect(shownStereotypes(['service', 'seam'], 'Orders')).toEqual(['service', 'seam']);
    expect(shownStereotypes(['service', 'seam'], 'Orders', { portLine: true })).toEqual(['service']);
  });

  it('FR-9.3 arguments off → name() / name(…)', () => {
    const off = { showArguments: false, maxArgumentLength: 30 };
    expect(formatMessageLabel(byId('root/2:toDto'), off).args).toBe('()');
    expect(formatMessageLabel(byId('root/0:validate'), off).args).toBe('(…)');
  });

  it('FR-5.1 create messages are labelled «create» with the class name', () => {
    const l = formatMessageLabel(byId('root/1:placeOrder/3:constructor'), d.options);
    expect(l.prefix).toBe('«create»');
    expect(l.name).toBe('Order');
    expect(fullCallText(byId('root/1:placeOrder/3:constructor'))).toBe('new Order(customer, items, total)');
  });

  it('FR-1.20 a rendered component is labelled «render» with its props; the tooltip shows the element', () => {
    const m: Message = { ...byId('root/2:toDto'), methodName: 'ShopTab', className: 'shopTab', args: ['widgetIds', '...rest'], render: true, result: undefined, returnType: undefined };
    const l = formatMessageLabel(m, { showArguments: true, maxArgumentLength: 40 });
    expect([l.prefix, l.name, l.args]).toEqual(['«render»', 'ShopTab', '(widgetIds, ...rest)']);
    expect(fullCallText(m)).toBe('«render» <ShopTab widgetIds {...rest} />');
  });

  it('FR-1.9 async messages carry an async marker', () => {
    expect(formatMessageLabel(byId('root/1:placeOrder/4:charge'), d.options).prefix).toBe('async');
  });

  it('FR-11.3 describes hide filters', () => {
    expect(d.hiddenFilters.map((f) => describeHideFilter(f.filter))).toEqual(['All calls to log', 'Calls to OrderService.audit', 'Class Metrics']);
  });

  it('formats locations 1-based and fits text to a width', () => {
    expect(formatLocation(byId('root/0:validate').callSite!)).toBe('order-controller.ts:16');
    const fitted = fitText('Infrastructure · src/infrastructure', 80, 'group', estimateTextWidth);
    expect(fitted.endsWith('…')).toBe(true);
    expect(estimateTextWidth(fitted, 'group')).toBeLessThanOrEqual(80);
  });
});

describe('delegate / function parameter labels (FR-1.13)', () => {
  const opts = { showArguments: true, maxArgumentLength: 30 };
  const base = byId('root/1:placeOrder/2:total');
  it('FR-1.13 a resolved delegate shows the parameter before the method the caller passed', () => {
    const m: Message = { ...base, viaParameter: 'format', methodName: 'plain', methodKey: 'src/f.ts#UserFormat.plain', isAsync: true };
    const l = formatMessageLabel(m, opts);
    expect([l.prefix, l.name]).toEqual(['async format ⇒', 'plain']);
    expect(l.full).toContain('via parameter format');
  });
  it('FR-1.13 an unresolved function parameter is marked ƒ and explains why', () => {
    const m: Message = { ...base, viaParameter: 'f', methodName: 'f', methodKey: undefined, kind: 'self' };
    expect(formatMessageLabel(m, opts).prefix).toBe('ƒ');
    expect(fullCallText(m)).toContain('show callers');
    expect(fullCallText({ ...m, viaLambda: true })).toContain('lambda');
  });
  it("FR-18.14 a middleware's `$next`: reads `next ⇒` the next step, the tooltip says where the request goes on", () => {
    const m: Message = { ...base, viaParameter: 'next', methodName: 'handle', methodKey: 'src/Gate.php#Gate.handle', continuesPipeline: true };
    expect(formatMessageLabel(m, opts).prefix).toBe('next ⇒');
    expect(fullCallText(m)).toContain('via parameter next: passes the request on — to the next middleware, after the last one to the action');
  });
});

describe('labels: unusual input (FR-9)', () => {
  it('FR-9.2 a limit of one character leaves only …', () => {
    expect(truncate('placeOrder', 1)).toBe('…');
    expect(truncate('placeOrder', 0)).toBe('…');
  });

  it('FR-9 a quote escaped inside a string does not end it', () => {
    expect(abbreviateArgument("'it\\'s a very long text here'", 10)).toBe("'it\\'s a…'");
  });

  it('FR-9 an unterminated template placeholder or block comment runs to the end (cut source)', () => {
    expect(abbreviateArgument('`total ${order.sum(', 40)).toBe('`total ${order.sum(');
    expect(abbreviateArgument('`total ${order.sum(a, b', 12)).toBe('`total ${o…`'); // still one template literal, cut inside its quotes
    expect(stripComments('a /* never closed')).toBe('a  ');
    expect(abbreviateArgument('/* only a comment */', 10)).toBe('');
  });

  it('FR-9 long expressions: strings with braces stay, empty blocks stay {}, an unclosed { is kept', () => {
    expect(abbreviateArgument("format('{x}', {}, { a: 1 }) + more", 20)).toBe("format('{x}', {}, {…"); // the string's braces stay, {} stays, { a: 1 } became {…} before the cut
    expect(abbreviateArgument('build({ a: 1 }).then(x', 14)).toBe('build({…}).th…');
    expect(abbreviateArgument('call(a, { b: c', 10)).toBe('call(a, {…');
  });

  it('FR-9 an array whose quotes do not balance (a compacted comment) is still an array', () => {
    expect(abbreviateArgument("['it, b, c, d, e, f]", 10)).toBe('[…]');
  });

  it('FR-1.18 a getter / setter: no argument list, «get» before the name, the type in the tooltip', () => {
    const base = byId('root/2:toDto');
    const get: Message = { ...base, accessor: 'get', methodName: 'total', className: 'Order', returnType: 'Money', result: undefined };
    const l = formatMessageLabel(get, { showArguments: true, maxArgumentLength: 40 });
    expect([l.prefix, l.name, l.args]).toEqual(['«get»', 'total', ': Money']);
    expect(fullCallText(get)).toBe('«get» Order.total: Money');
    expect(fullCallText({ ...get, accessor: 'set', returnType: undefined })).toBe('«set» Order.total');
  });

  it('FR-2.1 a plain function call has no owner in its tooltip', () => {
    expect(fullCallText({ ...byId('root/2:toDto'), className: undefined, methodName: 'formatDate', args: ['d'], result: undefined, returnType: undefined })).toBe('formatDate(d)');
  });

  it('FR-5.1 a creation whose class is unknown is named by its method', () => {
    const c = byId('root/1:placeOrder/3:constructor');
    expect(formatMessageLabel({ ...c, className: undefined, methodName: 'new' }, d.options).name).toBe('new');
  });

  it('FR-9.8 nested generic / object types collapse once', () => {
    expect(shortType('Map<string, Array<{ id: number }>>')).toBe('Map<…>');
  });

  it('FR-2.1 a location in a file at the project root', () => {
    expect(formatLocation({ file: 'main.ts', start: { line: 0, character: 0 }, end: { line: 0, character: 1 } })).toBe('main.ts:1');
  });
});
