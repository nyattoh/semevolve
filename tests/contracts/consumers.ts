import type { Envelope, Usage, CheckResult, TaskStore, StoreTransaction, Epoch, HostIdentity } from '@semevolve/core';
import type { ProviderAdapter, PeerRequest } from '@semevolve/provider-adapters';
import type { TransportAdapter } from '@semevolve/transport-adapters';
import type { LanguageRegistry, LanguageVersion, LanguageStatus } from '@semevolve/language-registry';
import type { Budget, BudgetReservation, PolicyGate } from '@semevolve/policy';
import type { TomboPort, PendingTomboUpdate, TomboInspectionInput } from '@semevolve/tombo-bridge';
import type { EvaluationPort, EvaluationRequest, StorageCheckRequest } from '@semevolve/evaluator';
import type { StoragePlanner, StorageProposal, Mapping, Migration, MigrationPort } from '@semevolve/storage-planner';
import type { CliResponse } from '@semevolve/cli';
import { createLocalUi } from '@semevolve/local-ui';
import { syntheticId, syntheticTimestamp } from '../support/synthetic.js';

const envelope = {
  protocol_version: '0.1', message_id: syntheticId('message'), task_id: syntheticId('task'),
  epoch_id: syntheticId('epoch'), sender_id: syntheticId('peer'), recipient_ids: [syntheticId('peer')],
  kind: 'utterance', language_version_id: syntheticId('language-version'), context_revision: 0,
  causation_ids: [], content_type: 'text/plain', payload: '公開合成例。否定も任意の構文も文字列として保持する。',
  created_at: syntheticTimestamp,
} satisfies Envelope;

const usage = {
  inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null,
  elapsedMs: 0, source: 'unavailable',
} satisfies Usage;

const check = {
  checkId: syntheticId('check'), targetMessageId: envelope.message_id,
  languageVersionId: syntheticId('language-version'), dimension: 'transmission', verdict: 'inconclusive',
  scope: 'public synthetic contract only', method: 'deterministic_test', evidenceIds: [],
  evaluatorVersion: 'synthetic-0.1', limitation: 'No mechanism was executed.',
} satisfies CheckResult;

export async function consumerExamples(
  store: TaskStore, batch: StoreTransaction, identities: HostIdentity,
  provider: ProviderAdapter, request: PeerRequest, transport: TransportAdapter,
  registry: LanguageRegistry, language: LanguageVersion, budget: Budget, policy: PolicyGate,
  tombo: TomboPort, input: TomboInspectionInput, update: PendingTomboUpdate,
  evaluator: EvaluationPort, evaluation: EvaluationRequest, storageCheck: StorageCheckRequest,
  planner: StoragePlanner, proposal: StorageProposal, mapping: Mapping,
  migrations: MigrationPort, migration: Migration,
) {
  const stored = await store.transact(batch);
  if (!stored.ok && stored.error.code === 'revision_conflict') {
    const revision: number = stored.error.actual;
    void revision;
  }
  const generated: typeof envelope.message_id = identities.newId('message');
  const capabilities = await provider.inspectCapabilities();
  const result = await provider.invoke(request, new AbortController().signal);
  const receipt = await transport.send(envelope);
  await transport.acknowledge(receipt.messageId);
  await transport.receive(null);
  await registry.register(language);
  await registry.get(envelope.language_version_id);
  await budget.snapshot(envelope.task_id);
  await budget.reserveAndStart({ taskId: envelope.task_id, invocationId: request.invocationId,
    reservationId: syntheticId('reservation'), expectedRevision: 0,
    amount: { invocations: 1, inputTokens: null, outputTokens: null, reasoningTokens: null, costYen: null } });
  await policy.authorise({ taskId: envelope.task_id, name: 'synthetic-read', target: 'public-fixture' });
  await tombo.inspect(input);
  await tombo.receive(update);
  const reconciled = await tombo.reconcile(update);
  if (reconciled.ok && reconciled.value.kind === 'reconciled') {
    const complete: boolean = reconciled.value.summary.canReportCompletion;
    void complete;
  }
  await evaluator.evaluate(evaluation);
  await evaluator.evaluateStorage(storageCheck);
  await planner.registerProposal(proposal);
  await planner.store(envelope.message_id, mapping);
  await planner.retrieve({ arbitrary_language_query: ['relation', false] }, mapping);
  await migrations.prepare(migration);
  return { generated, capabilities, result, usage, check };
}

export function compileRejections() {
  // @ts-expect-error Task IDs cannot identify messages.
  const wrongId: Envelope['message_id'] = syntheticId('task');
  // @ts-expect-error The transport protocol version is fixed.
  const wrongProtocol: Envelope['protocol_version'] = '2.0';
  // @ts-expect-error A message needs at least one recipient.
  const noRecipient: Envelope['recipient_ids'] = [];
  // @ts-expect-error Missing measurements are null, not optional.
  const missingUsage: Usage = { elapsedMs: 0, source: 'unavailable' };
  // @ts-expect-error SDK or application-specific states cannot replace the three verdicts.
  const verdict: CheckResult['verdict'] = 'needs_reflection';
  // @ts-expect-error Authorisation and transmission remain distinct dimensions.
  const dimension: CheckResult['dimension'] = 'understanding';
  // @ts-expect-error Language statuses match the seven states in the design.
  const languageStatus: LanguageStatus = 'VERIFIED';
  // @ts-expect-error Ordinary epochs must bind a language version.
  const unbound: Epoch['language'] = { mode: 'bound', languageVersionId: null };
  // @ts-expect-error Completed calls need observed usage, including null measurements.
  const missingSettlement: BudgetReservation['outcome'] = { kind: 'completed' };
  // @ts-expect-error The three version identities cannot be interchanged.
  const wrongRule: Mapping['versions']['ruleVersionId'] = syntheticId('language-version');
  // @ts-expect-error Storage proposals do not provide executable functions.
  const executable: StorageProposal['structureSpecification'] = () => 'DDL';
  // @ts-expect-error Verified restoration needs a through-revision and check references.
  const restoration: Migration['restoration'] = { verified: true };
  // @ts-expect-error Receipts do not expose a completion verdict.
  const receiptCompletion: Awaited<ReturnType<TomboPort['receive']>> = { ok: true, value: { canReportCompletion: true } };
  // @ts-expect-error Unimplemented CLI commands cannot claim an arbitrary success code.
  const cli: CliResponse = { exitCode: 1, stdout: '', stderr: '' };
  void [wrongId, wrongProtocol, noRecipient, missingUsage, verdict, dimension, languageStatus,
    unbound, missingSettlement, wrongRule, executable, restoration, receiptCompletion, cli, createLocalUi];
}
