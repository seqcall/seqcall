/**
 * Rich mock diagrams for the dev harness and tests. Covers: found message, several
 * groups/layers, self call with nested activation, static participant, create message,
 * two named participants of the same class, polymorphic message with two
 * implementations, library call, async call, recursive call, expanded subtree and hidden
 * filters with counts.
 */
import type { CallerInfo, ClassDiagram, ClassRef, Message, Participant, SequenceDiagram, SourceRange } from '@seqcall/protocol';

const ROOT = '/work/shop/src';

export function range(file: string, line: number, character = 4, length = 12): SourceRange {
  return { file: `${ROOT}/${file}`, start: { line, character }, end: { line, character: character + length } };
}

const F = {
  controller: 'controllers/order-controller.ts',
  service: 'services/order-service.ts',
  price: 'services/price-calculator.ts',
  order: 'domain/order.ts',
  gateway: 'domain/payment-gateway.ts',
  stripe: 'infrastructure/stripe-gateway.ts',
  paypal: 'infrastructure/paypal-gateway.ts',
  repo: 'infrastructure/customer-repository.ts',
  notify: 'services/notification-service.ts',
};

const ref = (key: string, name: string, kind: ClassRef['kind'], file?: string): ClassRef => ({ key, name, kind, declaration: file ? range(file, 3, 13, name.length) : undefined });

const stripe = ref('src/infrastructure/stripe-gateway.ts#StripeGateway', 'StripeGateway', 'class', F.stripe);
const paypal = ref('src/infrastructure/paypal-gateway.ts#PaypalGateway', 'PaypalGateway', 'class', F.paypal);

const groups: SequenceDiagram['groups'] = [
  { id: 'g-pres', label: 'Presentation · src/controllers', layer: 'Presentation', namespace: 'src/controllers' },
  { id: 'g-app', label: 'Application · src/services', layer: 'Application', namespace: 'src/services' },
  { id: 'g-dom', label: 'Domain · src/domain', layer: 'Domain', namespace: 'src/domain' },
  { id: 'g-infra', label: 'Infrastructure · src/infrastructure', layer: 'Infrastructure', namespace: 'src/infrastructure' },
  { id: 'g-ext', label: 'winston', namespace: 'node_modules/winston' },
];

function participant(p: Omit<Participant, 'kind' | 'stereotypes' | 'namespace'> & Partial<Participant>): Participant {
  return { kind: 'class', stereotypes: [], namespace: groups.find((g) => g.id === p.groupId)!.namespace, ...p };
}

const participants: Participant[] = [
  participant({ id: 'p-ctrl', classKey: 'src/controllers/order-controller.ts#OrderController', className: 'OrderController', label: ':OrderController', stereotypes: ['controller'], layer: 'Presentation', groupId: 'g-pres', declaration: range(F.controller, 8, 13, 15) }),
  participant({ id: 'p-svc', classKey: 'src/services/order-service.ts#OrderService', className: 'OrderService', label: ':OrderService', stereotypes: ['service'], layer: 'Application', groupId: 'g-app', declaration: range(F.service, 12, 13, 12) }),
  participant({ id: 'p-price', classKey: 'src/services/price-calculator.ts#PriceCalculator', className: 'PriceCalculator', label: 'PriceCalculator', stereotypes: ['static'], layer: 'Application', groupId: 'g-app', declaration: range(F.price, 2, 13, 15) }),
  participant({ id: 'p-notify', classKey: 'src/services/notification-service.ts#NotificationService', className: 'NotificationService', label: ':NotificationService', stereotypes: ['service', 'singleton'], layer: 'Application', groupId: 'g-app', declaration: range(F.notify, 5, 13, 19) }),
  participant({ id: 'p-order', classKey: 'src/domain/order.ts#Order', className: 'Order', label: ':Order', layer: 'Domain', groupId: 'g-dom', declaration: range(F.order, 4, 13, 5), createdByMessageId: 'root/1:placeOrder/3:constructor' }),
  participant({ id: 'p-gw', classKey: 'src/domain/payment-gateway.ts#PaymentGateway', className: 'PaymentGateway', label: ':PaymentGateway', kind: 'interface', stereotypes: ['interface', 'port', 'seam'], layer: 'Domain', groupId: 'g-dom', declaration: range(F.gateway, 1, 17, 14) }),
  participant({ id: 'p-repo1', classKey: 'src/infrastructure/customer-repository.ts#CustomerRepository', className: 'CustomerRepository', instanceName: 'primary', label: 'primary:CustomerRepository', stereotypes: ['repository'], layer: 'Infrastructure', groupId: 'g-infra', declaration: range(F.repo, 6, 13, 18) }),
  participant({ id: 'p-repo2', classKey: 'src/infrastructure/customer-repository.ts#CustomerRepository', className: 'CustomerRepository', instanceName: 'replica', label: 'replica:CustomerRepository', stereotypes: ['repository'], layer: 'Infrastructure', groupId: 'g-infra', declaration: range(F.repo, 6, 13, 18) }),
  participant({ id: 'p-log', classKey: 'lib:winston', className: 'Logger', label: ':Logger', kind: 'external', stereotypes: ['external'], groupId: 'g-ext' }),
];

function msg(m: Partial<Message> & Pick<Message, 'id' | 'parentId' | 'depth' | 'from' | 'to' | 'methodName'>): Message {
  return { kind: 'call', args: [], isAsync: false, isLibrary: false, expandable: false, expanded: false, recursive: false, ...m };
}

const P = 'root/1:placeOrder';
const messages: Message[] = [
  msg({ id: 'root', parentId: null, depth: 0, kind: 'found', from: null, to: 'p-ctrl', methodName: 'placeOrder', methodKey: 'src/controllers/order-controller.ts#OrderController.placeOrder', classKey: participants[0].classKey, className: 'OrderController', args: ['req', 'res'], callSite: range(F.controller, 14, 8, 10), expandable: true, expanded: true }),
  msg({ id: 'root/0:validate', parentId: 'root', depth: 1, kind: 'self', from: 'p-ctrl', to: 'p-ctrl', methodName: 'validate', classKey: participants[0].classKey, className: 'OrderController', args: ['req.body'], callSite: range(F.controller, 15, 4), expandable: true, expanded: true }),
  msg({ id: 'root/0:validate/0:checkItems', parentId: 'root/0:validate', depth: 2, kind: 'self', from: 'p-ctrl', to: 'p-ctrl', methodName: 'checkItems', classKey: participants[0].classKey, className: 'OrderController', args: ['body.items'], callSite: range(F.controller, 31, 4), expandable: true }),
  msg({ id: P, parentId: 'root', depth: 1, from: 'p-ctrl', to: 'p-svc', methodName: 'placeOrder', methodKey: 'src/services/order-service.ts#OrderService.placeOrder', classKey: participants[1].classKey, className: 'OrderService', args: ['req.user.id', 'req.body.items'], callSite: range(F.controller, 16, 25, 40), expandable: true, expanded: true, isAsync: true }),
  msg({ id: `${P}/0:findById`, parentId: P, depth: 2, from: 'p-svc', to: 'p-repo1', methodName: 'findById', classKey: participants[6].classKey, className: 'CustomerRepository', args: ['customerId'], callSite: range(F.service, 20, 30), expandable: true }),
  msg({ id: `${P}/1:findById`, parentId: P, depth: 2, from: 'p-svc', to: 'p-repo2', methodName: 'findById', classKey: participants[7].classKey, className: 'CustomerRepository', args: ['customerId'], callSite: range(F.service, 21, 30), expandable: true }),
  msg({ id: `${P}/2:total`, parentId: P, depth: 2, from: 'p-svc', to: 'p-price', methodName: 'total', classKey: participants[2].classKey, className: 'PriceCalculator', args: ['items.filter(i => i.quantity > 0 && !i.isGift)', 'customer.discountRate'], callSite: range(F.service, 23, 18), expandable: true }),
  msg({ id: `${P}/3:constructor`, parentId: P, depth: 2, kind: 'create', from: 'p-svc', to: 'p-order', methodName: 'constructor', classKey: participants[4].classKey, className: 'Order', args: ['customer', 'items', 'total'], callSite: range(F.service, 24, 18), expandable: true, expanded: true }),
  msg({ id: `${P}/3:constructor/0:assertValid`, parentId: `${P}/3:constructor`, depth: 3, kind: 'self', from: 'p-order', to: 'p-order', methodName: 'assertValid', classKey: participants[4].classKey, className: 'Order', callSite: range(F.order, 12, 4) }),
  msg({
    id: `${P}/4:charge`, parentId: P, depth: 2, from: 'p-svc', to: 'p-gw', methodName: 'charge', classKey: participants[5].classKey, className: 'PaymentGateway', args: ['order.total', 'customer.paymentToken'], callSite: range(F.service, 26, 24), isAsync: true,
    polymorphic: { interfaceKey: participants[5].classKey, interfaceName: 'PaymentGateway', implementations: [stripe, paypal] },
  }),
  msg({ id: `${P}/5:info`, parentId: P, depth: 2, from: 'p-svc', to: 'p-log', methodName: 'info', classKey: 'lib:winston', className: 'Logger', args: ['`order ${order.id} placed for ${customer.email}`'], callSite: range(F.service, 27, 4), isLibrary: true }),
  msg({ id: `${P}/6:notifyCustomer`, parentId: P, depth: 2, from: 'p-svc', to: 'p-notify', methodName: 'notifyCustomer', classKey: participants[3].classKey, className: 'NotificationService', args: ['customer', 'order'], callSite: range(F.service, 28, 10), isAsync: true, expandable: true, expanded: true }),
  msg({ id: `${P}/6:notifyCustomer/0:notifyCustomer`, parentId: `${P}/6:notifyCustomer`, depth: 3, kind: 'self', from: 'p-notify', to: 'p-notify', methodName: 'notifyCustomer', classKey: participants[3].classKey, className: 'NotificationService', args: ['customer', 'order', 'attempt + 1'], callSite: range(F.notify, 19, 6), recursive: true }),
  msg({ id: 'root/2:toDto', parentId: 'root', depth: 1, from: 'p-ctrl', to: 'p-order', methodName: 'toDto', classKey: participants[4].classKey, className: 'Order', callSite: range(F.controller, 17, 20), expandable: true }),
];

export const mockSequenceDiagram: SequenceDiagram = {
  root: {
    key: 'src/controllers/order-controller.ts#OrderController.placeOrder',
    name: 'placeOrder',
    owner: ref(participants[0].classKey, 'OrderController', 'class', F.controller),
    isStatic: false,
    declaration: range(F.controller, 14, 8, 10),
    hasBody: true,
  },
  participants,
  groups,
  messages,
  hiddenFilters: [
    { filter: { id: 'f1', kind: 'methodName', methodName: 'log' }, hiddenCount: 3 },
    { filter: { id: 'f2', kind: 'classMethod', classKey: participants[1].classKey, className: 'OrderService', methodName: 'audit' }, hiddenCount: 1 },
    { filter: { id: 'f3', kind: 'class', classKey: 'src/infrastructure/metrics.ts#Metrics', className: 'Metrics' }, hiddenCount: 2 },
  ],
  options: { showArguments: true, maxArgumentLength: 24, showLibraryCalls: true, followCursor: false },
  canGoBack: true,
  canGoForward: false,
};

/** Fresh deep copy (tests mutate). */
export function cloneSequence(): SequenceDiagram {
  return JSON.parse(JSON.stringify(mockSequenceDiagram)) as SequenceDiagram;
}

export const mockCallers: CallerInfo[] = [
  {
    id: 'c1',
    enclosing: { key: 'src/api/routes.ts#<module>.registerRoutes', name: 'registerRoutes', owner: ref('src/api/routes.ts#<module>', 'routes', 'module'), isStatic: false, hasBody: true },
    range: range('api/routes.ts', 22, 2, 30),
    preview: "router.post('/orders', (req, res) => controller.placeOrder(req, res));",
  },
  {
    id: 'c2',
    enclosing: { key: 'src/jobs/replay-job.ts#ReplayJob.run', name: 'run', owner: ref('src/jobs/replay-job.ts#ReplayJob', 'ReplayJob', 'class'), isStatic: false, hasBody: true },
    range: range('jobs/replay-job.ts', 41, 6, 30),
    preview: 'await this.controller.placeOrder(fakeRequest(entry), sink);',
  },
];

export const mockClassDiagram: ClassDiagram = {
  classes: [
    { key: 'OrderController', name: 'OrderController', kind: 'class', stereotypes: ['controller'], layer: 'Presentation', namespace: 'src/controllers', methods: [{ name: 'placeOrder', isStatic: false, signature: 'placeOrder(req: Request, res: Response): Promise<void>' }, { name: 'validate', isStatic: false, signature: 'validate(body: unknown): OrderInput' }], declaration: range(F.controller, 8, 13, 15) },
    { key: 'OrderService', name: 'OrderService', kind: 'class', stereotypes: ['service'], layer: 'Application', namespace: 'src/services', methods: [{ name: 'placeOrder', isStatic: false, signature: 'placeOrder(customerId: string, items: Item[]): Promise<Order>' }], declaration: range(F.service, 12, 13, 12) },
    { key: 'PriceCalculator', name: 'PriceCalculator', kind: 'class', stereotypes: ['static'], namespace: 'src/services', methods: [{ name: 'total', isStatic: true, signature: 'total(items: Item[], discount: number): Money' }], declaration: range(F.price, 2, 13, 15) },
    { key: 'NotificationService', name: 'NotificationService', kind: 'class', stereotypes: ['service', 'singleton'], namespace: 'src/services', methods: [{ name: 'notifyCustomer', isStatic: false, signature: 'notifyCustomer(c: Customer, o: Order, attempt?: number): Promise<void>' }], declaration: range(F.notify, 5, 13, 19) },
    { key: 'Order', name: 'Order', kind: 'class', stereotypes: ['entity'], namespace: 'src/domain', methods: [{ name: 'constructor', isStatic: false, signature: 'constructor(customer: Customer, items: Item[], total: Money)' }, { name: 'toDto', isStatic: false, signature: 'toDto(): OrderDto' }], declaration: range(F.order, 4, 13, 5) },
    { key: 'PaymentGateway', name: 'PaymentGateway', kind: 'interface', stereotypes: ['interface', 'port'], namespace: 'src/domain', methods: [{ name: 'charge', isStatic: false, signature: 'charge(amount: Money, token: string): Promise<Receipt>' }], declaration: range(F.gateway, 1, 17, 14) },
    { key: 'BaseGateway', name: 'BaseGateway', kind: 'abstract', stereotypes: ['abstract'], namespace: 'src/infrastructure', methods: [], declaration: range('infrastructure/base-gateway.ts', 1, 22, 11) },
    { key: 'StripeGateway', name: 'StripeGateway', kind: 'class', stereotypes: ['adapter'], namespace: 'src/infrastructure', methods: [{ name: 'charge', isStatic: false, signature: 'charge(amount: Money, token: string): Promise<Receipt>' }], declaration: range(F.stripe, 3, 13, 13) },
    { key: 'CustomerRepository', name: 'CustomerRepository', kind: 'class', stereotypes: ['repository'], namespace: 'src/infrastructure', methods: [{ name: 'findById', isStatic: false, signature: 'findById(id: string): Promise<Customer>' }], declaration: range(F.repo, 6, 13, 18) },
  ],
  relations: [
    { id: 'r1', kind: 'association', from: 'OrderController', to: 'OrderService', label: 'orders' },
    { id: 'r2', kind: 'association', from: 'OrderService', to: 'CustomerRepository', label: 'customers' },
    { id: 'r3', kind: 'association', from: 'OrderService', to: 'PaymentGateway', label: 'payments' },
    { id: 'r4', kind: 'dependency', from: 'OrderService', to: 'Order', label: '«create»' },
    { id: 'r5', kind: 'dependency', from: 'OrderService', to: 'PriceCalculator' },
    { id: 'r6', kind: 'association', from: 'OrderService', to: 'NotificationService', label: 'notifier' },
    { id: 'r7', kind: 'realization', from: 'StripeGateway', to: 'PaymentGateway' },
    { id: 'r8', kind: 'generalization', from: 'StripeGateway', to: 'BaseGateway' },
    { id: 'r9', kind: 'dependency', from: 'OrderController', to: 'Order' },
  ],
};
