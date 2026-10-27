# P0 transport

`createTransportEndpoint` uses a core `TaskStore` for outbound messages, recipient outboxes, inboxes, application state, and observed execution records. `createLocalTransportHub` provides an in-process synthetic transport. It does not connect to a service or an existing database.

Construct the store with `mutableCollections: transportMutableCollections`. Only `transport.outbox`, `transport.inbox`, and `transport.state` need replacement. Messages, authenticated delivery metadata, application measurements, and observations remain insert-only. Reopen a file store with the same collection configuration.

The endpoint receives a trusted local peer ID and host callbacks. `context` resolves the task, participants, epoch, deadline, and size limit. The endpoint supplies its bound recipient and the adapter's authenticated sender to the core parser. `checkLanguage` checks the exact language version and participant conformance through Registry. `policy.authorise` accepts the frozen PolicyGate shape. These callbacks must use host configuration and validated registry data. Payload text does not define them. The local tests compose frozen Registry and Policy port doubles. Integration with their implementations belongs to J1.

`adapterFor(recipientId)` must return an adapter bound to that recipient. The local hub's `connect(authenticatedSenderId, recipientId)` enforces that binding. Each send retains the entire original Envelope, including its recipient list. Each adapter receipt identifies only its bound recipient. The hub keeps unacknowledged messages in memory and can deliver duplicates.

The endpoint exposes these operations.

- `stage(envelope)` atomically inserts the original message and every recipient outbox. It performs no adapter call.
- `dispatch(messageId, recipientId)` commits an attempt before it calls the adapter. Every explicit retry sends the stored Envelope with its original ID, even when a previous adapter receipt exists. A receipt records adapter acceptance, not a durable receiver inbox, application, understanding or a passed check. Retry failure returns an error and retains the original receipt. Receiver idempotency prevents repeated application and accounting.
- `receive()` reads unacknowledged deliveries from the bound adapter. `accept(delivery)` validates and stores one delivery and an unapplied inbox row. Both keep state application separate from receipt.
- `apply(messageId, { state, observation })` atomically updates the recipient's task state, inbox application time, and application measurement. An optional existing `CheckExecution` retains its execution ID and null usage. Identical observations are stored once across deliveries. Transport does not execute a check or decide whether it passed.
- `acknowledge(messageId)` acknowledges the endpoint's recipient through its bound adapter and records an audit event. It changes neither application state nor interpretation or check status.

An application state is a host-supplied JSON value stored under the task and recipient pair. It is not evaluated as code. Independent interpretation, actual checks, and authorisation of external execution remain separate responsibilities. Transport operations use the policy names `transport.send`, `transport.receive`, and `transport.apply` with the recipient as the target.

Snapshot revision conflicts are retried at most four times. Other store errors are returned. An unavailable result is not evidence of failure or success. Reconcile the authoritative store before retrying. The file adapter's faulted-store, owner-recovery, and journal-tail rules still apply. No repair or unknown-result clearance is added here.

Run `npm run build` from the repository root before the package tests.

```sh
npm run test:local --workspace=@semevolve/transport-adapters
npm run test:durable --workspace=@semevolve/transport-adapters
```

These tests cover synthetic delivery and process recovery on the core reference stores. They do not establish real model understanding, a production transport, power-loss durability, or protection from a malicious process with the same OS permissions. The shared AT-01 to AT-34 integration ledger stays unchanged.
