import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Message, Position, SequenceDiagram } from '@seqcall/protocol';
import type { LanguageAdapter } from '../src/adapter';
import { createClassifier } from '../src/classifier-impl';
import { DiagramSession, type DiagramSessionDeps } from '../src/session';
import { createTsAdapter } from '../src/ts/ts-adapter';

export const FIXTURE_ROOT = path.resolve(__dirname, '../../../fixtures/sample-app').replace(/\\/g, '/');

export const file = (rel: string): string => `${FIXTURE_ROOT}/${rel}`;

/** 0-based position of the first occurrence of `needle` (plus `offset` chars) in a fixture file. */
export function positionOf(rel: string, needle: string, offset = 0): Position {
  const text = fs.readFileSync(file(rel), 'utf8');
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`"${needle}" not found in ${rel}`);
  const before = text.slice(0, idx + offset).split('\n');
  return { line: before.length - 1, character: before[before.length - 1].length };
}

let shared: LanguageAdapter | undefined;
/** One adapter per test worker: program creation is the slow part. */
export function sharedAdapter(): LanguageAdapter {
  shared ??= createTsAdapter(FIXTURE_ROOT);
  return shared;
}

export function newSession(deps: Partial<DiagramSessionDeps> = {}): DiagramSession {
  return new DiagramSession({
    adapter: deps.adapter ?? sharedAdapter(),
    classifier: deps.classifier ?? createClassifier(FIXTURE_ROOT),
    ...deps,
  });
}

export async function method(key: string) {
  const m = await sharedAdapter().getMethod(key);
  if (!m) throw new Error(`method not found: ${key}`);
  return m;
}

export const K = {
  getUser: 'src/controllers/user-controller.ts#UserController.getUser',
  renameUser: 'src/controllers/user-controller.ts#UserController.renameUser',
  audit: 'src/controllers/admin-controller.ts#AdminController.audit',
  findUser: 'src/services/user-service.ts#UserService.findUser',
  rename: 'src/services/user-service.ts#UserService.rename',
  managementChain: 'src/services/user-service.ts#UserService.managementChain',
  findById: 'src/ports/user-repository.ts#UserRepository.findById',
  sqlFindById: 'src/adapters/sql-user-repository.ts#SqlUserRepository.findById',
  memFindById: 'src/adapters/in-memory-user-repository.ts#InMemoryUserRepository.findById',
  notify: 'src/notifications/notifier.ts#Notifier.notify',
  bill: 'src/services/billing-service.ts#BillingService.bill',
  formatName: 'src/util/format.ts#<module>.formatName',
  slugify: 'src/util/format.ts#<module>.slugify',
  generate: 'src/legacy/report.js#ReportGenerator.generate',
  bootstrap: 'src/main.ts#<module>.bootstrap',
};

export const C = {
  UserController: 'src/controllers/user-controller.ts#UserController',
  AdminController: 'src/controllers/admin-controller.ts#AdminController',
  UserService: 'src/services/user-service.ts#UserService',
  BillingService: 'src/services/billing-service.ts#BillingService',
  PaymentGateway: 'src/services/billing-service.ts#PaymentGateway',
  StripeGateway: 'src/services/billing-service.ts#StripeGateway',
  UserRepository: 'src/ports/user-repository.ts#UserRepository',
  SqlUserRepository: 'src/adapters/sql-user-repository.ts#SqlUserRepository',
  InMemoryUserRepository: 'src/adapters/in-memory-user-repository.ts#InMemoryUserRepository',
  Notifier: 'src/notifications/notifier.ts#Notifier',
  EmailNotifier: 'src/notifications/notifier.ts#EmailNotifier',
  SmsNotifier: 'src/notifications/notifier.ts#SmsNotifier',
  Database: 'src/infrastructure/database.ts#Database',
  Logger: 'src/util/logger.ts#Logger',
  User: 'src/domain/user.ts#User',
  UserDto: 'src/domain/user-dto.ts#UserDto',
  format: 'src/util/format.ts#<module>',
  ReportGenerator: 'src/legacy/report.js#ReportGenerator',
};

/** The single message with that id. */
export function byId(d: SequenceDiagram, id: string): Message {
  const m = d.messages.find((x) => x.id === id);
  if (!m) throw new Error(`message ${id} not in [${d.messages.map((x) => x.id).join(', ')}]`);
  return m;
}

/** Message ids, compact form for order assertions. */
export const ids = (d: SequenceDiagram): string[] => d.messages.map((m) => m.id);

export const participantOf = (d: SequenceDiagram, m: Message) => d.participants.find((p) => p.id === m.to)!;
