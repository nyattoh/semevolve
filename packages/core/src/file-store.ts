import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Result } from './contracts/identity.js';
import type { StoreSnapshot, StoreTransaction, TaskStore } from './contracts/task-store.js';
import { canonicalJson, digestJson } from './identity.js';
import { copyBatch, invalidBatch, mutableCollections, StoreEngine, unavailable, type StoreOptions, type TransactionResult } from './store-engine.js';

export type PersistenceBoundary = 'journal_before_append' | 'journal_partial' | 'journal_synced'
  | 'tail_before_switch' | 'tail_after_switch' | 'journal_committed' | 'snapshot_before_switch' | 'snapshot_after_switch';
export interface FileStoreOptions extends StoreOptions {
  readonly maxPending?: number;
  readonly onBoundary?: (boundary: PersistenceBoundary) => Promise<void>;
}
type Owner = { format: 'semevolve-writer-1'; pid: number; host: string; token: string };

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written === 0) throw new Error('Zero-length file write');
    offset += written;
  }
}

function writeNew(path: string, text: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeAll(fd, Buffer.from(text, 'utf8')); fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function readJson(path: string): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)));
}

function readOwner(directory: string): Owner {
  const value = readJson(join(directory, 'writer.lock')) as Partial<Owner> | null;
  if (!value || value.format !== 'semevolve-writer-1' || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
    || typeof value.host !== 'string' || typeof value.token !== 'string' || !/^[0-9a-f-]{36}$/u.test(value.token)) throw new Error('Unknown writer owner; preserve lock');
  return value as Owner;
}

export function inspectFileStoreOwner(directory: string): Readonly<Owner> {
  return readOwner(directory);
}

export function recoverFileStoreOwner(directory: string, expectedToken: string): void {
  const guard = join(directory, 'recovery.guard');
  writeNew(guard, expectedToken);
  try {
    const owner = readOwner(directory);
    if (owner.token !== expectedToken || owner.host !== hostname()) throw new Error('Owner changed or belongs to another host');
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Writer liveness unknown; preserve lock');
      unlinkSync(join(directory, 'writer.lock'));
      syncDirectory(directory);
      return;
    }
    throw new Error('Writer is alive; preserve lock');
  } finally { unlinkSync(guard); }
}

export class FileTaskStore implements TaskStore {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closed = false;
  private faulted = false;
  private closePromise: Promise<void> | undefined;
  private journalDigest: string;
  private readonly engine: StoreEngine;
  private readonly owner: Owner;
  private readonly maxPending: number;
  private readonly journal: string;
  private readonly header: { format: string; mutableCollections: readonly string[] };

  constructor(private readonly directory: string, private readonly options: FileStoreOptions) {
    this.maxPending = options.maxPending ?? 64;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) throw new TypeError('Invalid queue bound');
    const mutable = mutableCollections(options);
    this.engine = new StoreEngine(mutable);
    this.header = { format: 'semevolve-journal-1', mutableCollections: mutable };
    this.journalDigest = digestJson(this.header);
    this.journal = join(directory, 'journal.jsonl');
    this.owner = { format: 'semevolve-writer-1', pid: process.pid, host: hostname(), token: randomUUID() };
    if (existsSync(join(directory, 'recovery.guard'))) throw new Error('Writer recovery pending');
    writeNew(join(directory, 'writer.lock'), canonicalJson(this.owner));
    try {
      syncDirectory(directory);
      const manifest = join(directory, 'store.json');
      if (existsSync(manifest)) {
        if (canonicalJson(readJson(manifest)) !== canonicalJson(this.header)) throw new Error('Store format or collection policy mismatch');
        if (!existsSync(this.journal)) throw new Error('Journal missing; preserve store');
      } else {
        if (existsSync(this.journal) || existsSync(join(directory, 'snapshot.json')) || existsSync(join(directory, 'journal-tail.json'))) throw new Error('Store manifest missing; preserve files');
        writeNew(manifest, canonicalJson(this.header));
        writeNew(this.journal, canonicalJson(this.header) + '\n');
        writeNew(join(directory, 'journal-tail.json'), canonicalJson(this.tailValue()));
        syncDirectory(directory);
      }
      this.replay();
    } catch (error) {
      unlinkSync(join(directory, 'writer.lock'));
      throw error;
    }
  }

  private replay(): void {
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(this.journal));
    if (!wire.endsWith('\n')) throw new Error('Incomplete journal; preserve data');
    const lines = wire.slice(0, -1).split('\n');
    if (lines.shift() !== canonicalJson(this.header)) throw new Error('Journal format or collection policy mismatch');
    const snapshotPath = join(this.directory, 'snapshot.json');
    const checkpoint = existsSync(snapshotPath) ? readJson(snapshotPath) : undefined;
    let matched = checkpoint === undefined;
    const check = () => {
      if (checkpoint !== undefined && canonicalJson(checkpoint) === canonicalJson(this.checkpointValue())) matched = true;
    };
    check();
    for (const line of lines) {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid journal record');
      const batch = copyBatch(value.batch);
      const prepared = this.engine.prepare(batch);
      const record = { sequence: this.engine.records.length + 1, previous: this.journalDigest, batch, result: prepared.result };
      const expected = { ...record, digest: digestJson(record) };
      if (prepared.repeated || line !== canonicalJson(expected)) throw new Error('Corrupt journal; preserve data');
      this.engine.commit(batch, prepared);
      this.journalDigest = expected.digest;
      check();
    }
    const tail = join(this.directory, 'journal-tail.json');
    if (!existsSync(tail) || canonicalJson(readJson(tail)) !== canonicalJson(this.tailValue())) throw new Error('Journal tail mismatch; preserve data');
    if (!matched) throw new Error('Inconsistent snapshot; preserve data');
  }

  private tailValue(sequence = this.engine.records.length, journalDigest = this.journalDigest) {
    const data = { format: 'semevolve-journal-tail-1', sequence, journalDigest };
    return { ...data, digest: digestJson(data) };
  }

  private checkpointValue() {
    const data = { format: 'semevolve-snapshot-1', sequence: this.engine.records.length, journalDigest: this.journalDigest, snapshot: this.engine.snapshot() };
    return { ...data, digest: digestJson(data) };
  }

  private enqueue<T>(action: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.closed || this.faulted) return Promise.resolve(unavailable(this.faulted ? 'Persistence outcome unknown; close and reconcile' : 'Store closed'));
    if (this.pending >= this.maxPending) return Promise.resolve(unavailable('Writer queue full; request not admitted'));
    this.pending++;
    const result = this.tail.then(async () => {
      try {
        if (this.faulted) return unavailable('Persistence outcome unknown; close and reconcile');
        return await action();
      }
      catch { this.faulted = true; return unavailable('Persistence outcome unknown; preserve files and reconcile'); }
      finally { this.pending--; }
    });
    this.tail = result;
    return result;
  }

  snapshot(): Promise<Result<StoreSnapshot>> {
    return this.enqueue(async () => ({ ok: true, value: this.engine.snapshot() }));
  }

  transact(input: StoreTransaction): Promise<TransactionResult> {
    if (this.closed || this.faulted) return Promise.resolve(unavailable('Store closed or persistence outcome unknown'));
    let batch: StoreTransaction;
    try { batch = copyBatch(input); } catch { return Promise.resolve(invalidBatch()); }
    return this.enqueue(async () => {
      const prepared = this.engine.prepare(batch);
      if (prepared.repeated) return structuredClone(prepared.result);
      const record = { sequence: this.engine.records.length + 1, previous: this.journalDigest, batch, result: prepared.result };
      const digest = digestJson(record);
      const data = Buffer.from(canonicalJson({ ...record, digest }) + '\n', 'utf8');
      await this.options.onBoundary?.('journal_before_append');
      const fd = openSync(this.journal, 'a');
      try {
        const split = Math.floor(data.length / 2);
        writeAll(fd, data.subarray(0, split));
        await this.options.onBoundary?.('journal_partial');
        writeAll(fd, data.subarray(split));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      await this.options.onBoundary?.('journal_synced');
      const temporary = join(this.directory, `journal-tail-${randomUUID()}.tmp`);
      writeNew(temporary, canonicalJson(this.tailValue(record.sequence, digest)));
      await this.options.onBoundary?.('tail_before_switch');
      renameSync(temporary, join(this.directory, 'journal-tail.json'));
      syncDirectory(this.directory);
      await this.options.onBoundary?.('tail_after_switch');
      this.journalDigest = digest;
      const result = this.engine.commit(batch, prepared);
      await this.options.onBoundary?.('journal_committed');
      return result;
    });
  }

  checkpoint(): Promise<Result<StoreSnapshot>> {
    return this.enqueue(async () => {
      const temporary = join(this.directory, `snapshot-${randomUUID()}.tmp`);
      writeNew(temporary, canonicalJson(this.checkpointValue()));
      await this.options.onBoundary?.('snapshot_before_switch');
      renameSync(temporary, join(this.directory, 'snapshot.json'));
      syncDirectory(this.directory);
      await this.options.onBoundary?.('snapshot_after_switch');
      return { ok: true, value: this.engine.snapshot() };
    });
  }

  backup(destination: string): Promise<Result<StoreSnapshot>> {
    return this.enqueue(async () => {
      mkdirSync(destination, { recursive: false, mode: 0o700 });
      writeNew(join(destination, 'store.json'), canonicalJson(this.header));
      writeNew(join(destination, 'journal.jsonl'), readFileSync(this.journal, 'utf8'));
      writeNew(join(destination, 'snapshot.json'), canonicalJson(this.checkpointValue()));
      writeNew(join(destination, 'journal-tail.json'), canonicalJson(this.tailValue()));
      syncDirectory(destination);
      return { ok: true, value: this.engine.snapshot() };
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.tail.then(() => {
      const owner = readOwner(this.directory);
      if (owner.token !== this.owner.token) throw new Error('Writer owner changed; preserve lock');
      unlinkSync(join(this.directory, 'writer.lock'));
      syncDirectory(this.directory);
    });
    return this.closePromise;
  }
}

export async function openFileTaskStore(directory: string, options: FileStoreOptions = {}): Promise<FileTaskStore> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error('Store requires a directory');
  return new FileTaskStore(realpathSync(directory), options);
}
