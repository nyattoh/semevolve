import { createStoragePlanner, storageMutableCollections, syntheticStorageAdapters } from '@semevolve/storage-planner';
import type { StoragePlanner, MigrationPort, StoragePlannerOptions, StorageRuntime, StorageInspection } from '@semevolve/storage-planner';
import type { StorageCheckResult } from '@semevolve/evaluator';
declare const options: StoragePlannerOptions;
const runtime: StorageRuntime = createStoragePlanner({ ...options, adapters: syntheticStorageAdapters() });
const planner: StoragePlanner = runtime;
const migration: MigrationPort = runtime.migration;
const collections: readonly string[] = storageMutableCollections;
declare const inspection: StorageInspection;
const result: StorageCheckResult = inspection.result;
void [planner, migration, collections, result];
// @ts-expect-error StorageCheckResult is wrapped by a host inspection rather than extended.
result.checkId;
// @ts-expect-error Existing MigrationPort requires an expected store revision.
void migration.switch({ migrationId: 'synthetic', authorisationRef: 'grant' });
// @ts-expect-error Proposed module paths are data and cannot be passed as an adapter.
createStoragePlanner({ ...options, adapters: ['proposal-module-path'] });
// @ts-expect-error Three independent version identifiers remain mandatory.
void planner.store('message', { versions: { languageVersionId: 'language' } });
