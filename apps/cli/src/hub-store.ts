import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };
export class HubError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function demand(condition: unknown, code = 'invalid_input', message = 'Invalid hub input.'): asserts condition {
  if (!condition) throw new HubError(code, message);
}
export function result<T>(action: () => T): Result<T> {
  try { return { ok: true, value: action() }; }
  catch (error) {
    return { ok: false, error: error instanceof HubError
      ? { code: error.code, message: error.message }
      : { code: 'storage_error', message: 'Hub operation failed; no automatic repair was attempted.' } };
  }
}
export function object(value: unknown): Record<string, unknown> {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value));
  demand(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  demand(Object.keys(value).every(key => allowed.includes(key)));
}
export function string(value: unknown, empty = false): string {
  demand(typeof value === 'string' && (empty || value.length > 0) && !value.includes('\u0000'));
  return value;
}
export function identifier(value: unknown): string {
  const id = string(value);
  demand(id.length <= 256);
  return id;
}
export function actorId(value: unknown): string {
  const id = identifier(value);
  demand(/^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(id));
  return id;
}
export function strings(value: unknown): string[] {
  demand(Array.isArray(value));
  const items = value.map(item => identifier(item));
  demand(new Set(items).size === items.length);
  return items;
}
export function canonical(value: unknown): string {
  function normal(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { demand(Number.isFinite(item)); return item; }
    if (Array.isArray(item)) return item.map(normal);
    const record = object(item);
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, normal(record[key])]));
  }
  return JSON.stringify(normal(value));
}
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const osBinding = (): string => digest(canonical({ host: hostname(), user: userInfo().username, uid: userInfo().uid }));

export interface Participant {
  id: string;
  role: 'pm' | 'worker';
  connectionRef: string;
  sessionRef: string;
  capabilities: string[];
  languageVersions: string[];
}
export function participant(input: unknown): Participant {
  const p = object(input);
  keys(p, ['id', 'role', 'connectionRef', 'sessionRef', 'capabilities', 'languageVersions']);
  demand(p.role === 'pm' || p.role === 'worker');
  return { id: actorId(p.id), role: p.role, connectionRef: identifier(p.connectionRef), sessionRef: identifier(p.sessionRef), capabilities: strings(p.capabilities), languageVersions: strings(p.languageVersions) };
}

const schema = [
  'CREATE TABLE metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE principals (id TEXT PRIMARY KEY, profile TEXT NOT NULL, secret_hash TEXT NOT NULL, os_binding TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (\'provisioned\',\'joined\',\'left\'))) STRICT',
  'CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)) STRICT',
  'CREATE TABLE deliveries (message_id TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES principals(id), acked_at TEXT, applied_at TEXT, PRIMARY KEY(message_id,recipient_id)) STRICT',
];
const expectedSchema = schema.slice().sort();
function verifySchema(db: DatabaseSync, databaseId: string): void {
  const actual = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY sql").all().map(row => row.sql);
  demand(canonical(actual) === canonical(expectedSchema), 'unknown_schema', 'Existing database schema is not the M0 hub schema.');
  demand(db.prepare("SELECT value FROM metadata WHERE id='schema'").get()?.value === 'semevolve-m0-1', 'unknown_schema');
  demand(db.prepare("SELECT value FROM metadata WHERE id='database'").get()?.value === databaseId, 'unauthorised');
}
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function privateDirectory(path: unknown): string {
  demand(typeof path === 'string' && isAbsolute(path) && !path.includes('\u0000'), 'invalid_path');
  const absolute = resolve(path);
  demand(existsSync(absolute) && lstatSync(absolute).isDirectory() && !lstatSync(absolute).isSymbolicLink(), 'invalid_path');
  demand(samePath(realpathSync(absolute), absolute), 'invalid_path', 'Use a canonical private directory without linked ancestors.');
  let cursor = absolute;
  while (true) {
    demand(!existsSync(join(cursor, '.git')), 'invalid_path', 'Hub state must be outside a Git checkout.');
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}
function regularFile(path: string): void {
  demand(existsSync(path), 'invalid_path');
  const stat = lstatSync(path);
  demand(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'invalid_path');
}
function readJson(path: string): Record<string, unknown> {
  regularFile(path);
  try { return object(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { throw new HubError('invalid_input', 'Invalid private JSON file.'); }
}

export interface PreparedHub {
  authorityPath: string;
  databasePath: string;
  contexts: { actorId: string; path: string }[];
}
export function prepareStore(input: unknown): PreparedHub {
  const request = object(input);
  keys(request, ['directory', 'participants']);
  demand(Array.isArray(request.participants) && request.participants.length > 0);
  const people = request.participants.map(participant);
  demand(new Set(people.map(p => p.id)).size === people.length);
  demand(new Set(people.map(p => p.connectionRef)).size === people.length);
  demand(new Set(people.map(p => p.sessionRef)).size === people.length);
  demand(people.some(p => p.role === 'pm'));
  demand(typeof request.directory === 'string' && isAbsolute(request.directory), 'invalid_path');
  const directory = resolve(request.directory);
  privateDirectory(dirname(directory));
  demand(!existsSync(directory), 'path_exists', 'Provisioning only creates a new private directory.');
  mkdirSync(directory, { mode: 0o700 });
  const databasePath = join(directory, 'hub.sqlite');
  closeSync(openSync(databasePath, 'wx', 0o600));
  const db = new DatabaseSync(databasePath);
  const databaseId = randomUUID();
  const binding = osBinding();
  const contexts: PreparedHub['contexts'] = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const ddl of schema) db.exec(ddl);
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('schema', 'semevolve-m0-1');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('database', databaseId);
    for (const p of people) {
      const secret = randomBytes(32).toString('hex');
      db.prepare('INSERT INTO principals VALUES (?,?,?,?,?)').run(p.id, canonical(p), digest(secret), binding, 'provisioned');
      const path = join(directory, `context-${contexts.length + 1}.json`);
      writeFileSync(path, canonical({ databaseId, actorId: p.id, connectionRef: p.connectionRef, sessionRef: p.sessionRef, osBinding: binding, secret }), { flag: 'wx', mode: 0o600 });
      contexts.push({ actorId: p.id, path });
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  const authorityPath = join(directory, 'authority.json');
  writeFileSync(authorityPath, canonical({ schema: 'semevolve-m0-1', databaseId, databasePath }), { flag: 'wx', mode: 0o600 });
  return { authorityPath, databasePath, contexts };
}

export class HubStore {
  private closed = false;
  constructor(readonly db: DatabaseSync, readonly actor: Participant) {}

  transaction<T>(action: () => T): T {
    demand(!this.closed, 'closed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get<T>(kind: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(String(row.data)) as T : undefined;
  }

  list<T>(kind: string): T[] {
    return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(String(row.data)) as T);
  }

  put<T>(kind: string, id: string, value: T): T {
    const previous = this.get<T>(kind, id);
    if (previous !== undefined) {
      demand(canonical(previous) === canonical(value), 'conflict', 'The identifier already holds different content.');
      return previous;
    }
    this.db.prepare('INSERT INTO records VALUES (?,?,?)').run(kind, id, canonical(value));
    return value;
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}

export function openStore(input: unknown): HubStore {
  const options = object(input);
  keys(options, ['authorityPath', 'contextPath']);
  demand(typeof options.authorityPath === 'string' && isAbsolute(options.authorityPath), 'invalid_path');
  demand(typeof options.contextPath === 'string' && isAbsolute(options.contextPath), 'invalid_path');
  const authorityPath = resolve(options.authorityPath);
  demand(basename(authorityPath) === 'authority.json', 'invalid_path');
  const directory = privateDirectory(dirname(authorityPath));
  const authority = readJson(authorityPath);
  keys(authority, ['schema', 'databaseId', 'databasePath']);
  demand(authority.schema === 'semevolve-m0-1', 'unknown_schema');
  const databasePath = join(directory, 'hub.sqlite');
  demand(authority.databasePath === databasePath, 'invalid_path');
  regularFile(databasePath);
  demand(samePath(dirname(resolve(options.contextPath)), directory), 'unauthorised');
  const context = readJson(options.contextPath);
  demand(context.databaseId === authority.databaseId && context.osBinding === osBinding(), 'unauthorised');
  demand(typeof context.actorId === 'string' && typeof context.secret === 'string', 'unauthorised');
  const databaseId = string(authority.databaseId);
  const authenticate = (db: DatabaseSync): Participant => {
    verifySchema(db, databaseId);
    const row = db.prepare('SELECT profile,secret_hash,os_binding FROM principals WHERE id=?').get(context.actorId as string);
    demand(row && row.secret_hash === digest(context.secret as string) && row.os_binding === context.osBinding, 'unauthorised');
    const p = participant(JSON.parse(String(row.profile)));
    demand(p.connectionRef === context.connectionRef && p.sessionRef === context.sessionRef, 'unauthorised');
    return p;
  };
  const readOnly = new DatabaseSync(databasePath, { readOnly: true });
  try { authenticate(readOnly); } finally { readOnly.close(); }
  const db = new DatabaseSync(databasePath);
  try { return new HubStore(db, authenticate(db)); }
  catch (error) { db.close(); throw error; }
}
