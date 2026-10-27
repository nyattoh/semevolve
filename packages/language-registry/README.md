# P0 Language Registry

`createLanguageRegistry` implements the frozen `LanguageRegistry` port with the core `TaskStore`. Language content stays arbitrary text. The registry checks content digests, parents and configured scopes, then records status and conformance histories without overwriting them.

Construct the store with `mutableCollections: registryMutableCollections`. Only `registry.heads` and `registry.task-epochs` permit replacement. Versions, epochs, epoch closures, status events and inspection records remain insert-only. Other packages must add their own mutable collections explicitly when they share a store. The core journal, tail validation and unknown-outcome behaviour remain unchanged.

The host supplies scope definitions, the required test-set digest, evaluator version and exact participant fingerprints. Unknown model or CLI versions cannot qualify for adoption. Changing the model, CLI, settings, introduction, test set or evaluator requires matching conformance. `null` expiry means the host chose no time expiry; fingerprint and test requirements still apply.

`RegistryInspectionPort` reads an independent, fixed assessment from the inspection authority. It supplies the complete conformance record, deterministic transmission check executions and a regression verdict. The registry checks their correspondence and retains the assessment with the history. A check ID, a compatibility claim or agreement alone cannot establish conformance. This port is a trust boundary: the host must not implement it as an echo of peer input. P0 tests use public synthetic doubles. The real evaluator connection and evidence withdrawal belong to later work.

Status changes follow the state table in `registry.ts`. A registered version starts without a status event. The host appends `DRAFT` or `CANDIDATE`, then `TRIAL` before `ACTIVE`. Adoption requires current passing conformance for every configured participant. Quarantined, rejected and retired versions return through `TRIAL` for restoration. Their original content and previous events remain available.

`selectHead` uses the scope head revision, initially zero. `nextEpoch` uses the registry's task-epoch pointer revision, also initially zero. Each successful switch increases the corresponding revision by one. Core store revision separately protects the full transaction. A conflict returns to the caller without an implicit retry.

`EpochReadinessPort` reads transition evidence tied to the same store revision. It identifies the task, old epoch, new epoch and scope, confirms that old sends stopped, accounts for every pending delivery as explicitly held, and confirms each participant acquired the exact version and digest. The transport integration must preserve these facts until commit and coordinate changes through that store revision. P0 uses a local double; actual transport integration is deferred to J1. The registry atomically inserts the next epoch, records the old epoch's closure and updates its task-epoch pointer. It does not update a policy-owned `TaskRecord`.

`getEpoch` retains the fixed language and projects a recorded closure. `resolveLanguage` refuses closed epochs, unknown versions, wrong digests, stale context or missing current conformance. Old deliveries remain held for explicit handling. Selecting a different head does not reinterpret an open epoch. Bootstrap is explicit and available only for the first epoch.

Run from the repository root after `npm ci`:

```sh
npm run build
npm run test --workspace @semevolve/language-registry
npm run test:persistence --workspace @semevolve/language-registry
```

The dedicated workflow runs both commands with the existing contract and core regressions on Windows and Linux with Node 22 and 24. Public tests cover local mechanisms related to AT-03, AT-04, AT-16, AT-17, AT-18 and AT-23. They do not complete the integrated acceptance ledger or demonstrate model understanding, language invention or generalisation. The durable adapter retains the core P0 limits for power loss, simultaneous loss of journal and tail, filesystem behaviour and malicious access by the same OS user.
