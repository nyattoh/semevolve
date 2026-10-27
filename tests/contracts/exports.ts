import type { Envelope, Usage, CheckResult, TaskStore } from '@semevolve/core';
import type { ProviderAdapter } from '@semevolve/provider-adapters';
import type { TransportAdapter } from '@semevolve/transport-adapters';
import type { LanguageRegistry } from '@semevolve/language-registry';
import type { Budget, PolicyGate } from '@semevolve/policy';
import type { TomboPort } from '@semevolve/tombo-bridge';
import type { EvaluationPort } from '@semevolve/evaluator';
import type { StorageProposal, Mapping, Migration } from '@semevolve/storage-planner';
export type ConsumerContracts = [Envelope, Usage, CheckResult, TaskStore, ProviderAdapter,
  TransportAdapter, LanguageRegistry, Budget, PolicyGate, TomboPort, EvaluationPort,
  StorageProposal, Mapping, Migration];
