import { actorId, canonical, demand, digest, identifier, keys, object, string, strings } from './hub-store.js';

export interface Language { id: string; definition: string; sourceRef: string }
export interface Message {
  id: string; runId: string; languageVersion: string; sender: string; recipients: string[]; body: string;
  kind: 'canary' | 'language_introduction' | 'request' | 'understanding' | 'correction' | 'result';
}
export interface Delivery {
  messageId: string; recipientId: string; ackedAt: string | null; appliedAt: string | null;
  understanding: null; taskCompletion: null; evaluation: null;
}
export interface Translation {
  id: string; sourceMessageId: string; runId: string; languageVersion: string;
  targetLanguage: string; text: string; sourceRef: string; authorId: string; meaningVerified: false;
}
export function message(input: unknown, sender: string): Message {
  const v = object(input);
  keys(v, ['id', 'runId', 'languageVersion', 'sender', 'recipients', 'body', 'kind']);
  demand(v.sender === undefined || v.sender === sender, 'unauthorised');
  demand(v.kind === 'canary' || v.kind === 'language_introduction' || v.kind === 'request' || v.kind === 'understanding' || v.kind === 'correction' || v.kind === 'result');
  const recipients = strings(v.recipients).map(actorId).sort();
  demand(recipients.length > 0);
  return { id: identifier(v.id), runId: identifier(v.runId), languageVersion: identifier(v.languageVersion), sender, recipients, body: string(v.body, true), kind: v.kind };
}
export interface Run {
  id: string; taskId: string; condition: 'canary' | 'japanese' | 'internal' | 'formation';
  languageVersion: string; actors: string[]; modelSettings: Record<string, unknown> | null;
  rerunOf: string | null; formationRunId: string | null; status: 'prepared';
}
export interface Fixture {
  id: string; input: string; successCriteria: string[]; intentChecks: string[];
  roles: { sender: string; recipients: string[] }; modelSettings: Record<string, unknown> | null;
  limits: { processingSeconds: number; correctionRounds: number };
  inputHash: string; successCriteriaHash: string; fixtureHash: string;
}
export const nullableId = (value: unknown): string | null => value === null ? null : identifier(value);
export function settings(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  const record = object(value);
  canonical(record);
  return record;
}
export function number(value: unknown): number {
  demand(typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return value;
}
export function language(input: unknown): Language {
  const v = object(input);
  keys(v, ['id', 'definition', 'sourceRef']);
  return { id: identifier(v.id), definition: string(v.definition), sourceRef: identifier(v.sourceRef) };
}
export function run(input: unknown): Run {
  const v = object(input);
  keys(v, ['id', 'taskId', 'condition', 'languageVersion', 'actors', 'modelSettings', 'rerunOf', 'formationRunId']);
  demand(v.condition === 'canary' || v.condition === 'japanese' || v.condition === 'internal' || v.condition === 'formation');
  const actors = strings(v.actors).map(actorId);
  demand(actors.length > 0);
  return { id: identifier(v.id), taskId: identifier(v.taskId), condition: v.condition, languageVersion: identifier(v.languageVersion), actors, modelSettings: settings(v.modelSettings), rerunOf: nullableId(v.rerunOf), formationRunId: nullableId(v.formationRunId), status: 'prepared' };
}
export function fixtureDefinition(input: unknown): Fixture {
  const v = object(input);
  keys(v, ['id', 'input', 'successCriteria', 'intentChecks', 'roles', 'modelSettings', 'limits', 'inputHash', 'successCriteriaHash', 'fixtureHash']);
  const roles = object(v.roles);
  keys(roles, ['sender', 'recipients']);
  const limits = object(v.limits);
  keys(limits, ['processingSeconds', 'correctionRounds']);
  const definition = {
    id: identifier(v.id), input: string(v.input), successCriteria: strings(v.successCriteria), intentChecks: strings(v.intentChecks),
    roles: { sender: actorId(roles.sender), recipients: strings(roles.recipients).map(actorId) },
    modelSettings: settings(v.modelSettings),
    limits: { processingSeconds: number(limits.processingSeconds), correctionRounds: number(limits.correctionRounds) },
  };
  demand(definition.successCriteria.length && definition.intentChecks.length && definition.roles.recipients.length);
  demand(definition.limits.processingSeconds > 0 && Number.isSafeInteger(definition.limits.correctionRounds));
  const hashes = { inputHash: digest(definition.input), successCriteriaHash: digest(canonical(definition.successCriteria)), fixtureHash: digest(canonical(definition)) };
  for (const key of ['inputHash', 'successCriteriaHash', 'fixtureHash'] as const) {
    demand(v[key] === undefined || v[key] === hashes[key], 'hash_mismatch');
  }
  return { ...definition, ...hashes };
}

export const m0Conditions = [
  { id: 'connection', requirement: 'Grok Bot PMとAgy workerの実際の接続方法、ID、権限と利用枠。agmsg経路の可否、自動起動か貼り付けか。', fields: ['grokModel', 'grokSettings', 'grokPermissions', 'grokQuota', 'grokHubProbe', 'agyModel', 'agySettings', 'agyPermissions', 'agyQuota', 'agyHubProbe', 'route', 'agmsgRoute', 'hostPlacement', 'workerToWorkerPlan'] },
  { id: 'sessions', requirement: '各条件で毎回新しいセッションを開始し、前の条件の会話や結果を渡さない方法。実際に隔離できない範囲は明記する。', fields: ['grokFreshProcedure', 'agyFreshProcedure', 'worker2FreshProcedure', 'inputSeparation', 'isolationLimits'] },
  { id: 'tokenizer', requirement: 'tokenizerの名前・版・設定と、どの送受信テキストを数えるか。提供者ごとの課金token数とは区別する。', fields: ['name', 'version', 'encoding', 'specialTokens', 'countedTextScope', 'providerBillingSeparation', 'literalEncodeEvidence'] },
  { id: 'fixtures', requirement: '小タスク6つの入力・成功条件・意図確認項目、PM↔worker／worker↔workerの割当て、使用モデルと設定、打切り条件。', fields: ['assignmentEvidence', 'settingsEvidence', 'limitsEvidence', 'fixtureHashEvidence'] },
  { id: 'phases', requirement: 'v0の取り決め、タスク実行、改訂、人向け翻訳、貼り付け待ちを分けて記録できること。', fields: ['formationEvidence', 'taskEvidence', 'revisionEvidence', 'humanTranslationEvidence', 'pasteWaitingEvidence', 'deduplicationEvidence', 'nullEvidence', 'intervalUnionEvidence'] },
  { id: 'storage', requirement: 'SQLite保存先と、実行ログ・資格情報・非公開の正解を公開リポへ入れないこと。', fields: ['authorityPathEvidence', 'reopenEvidence', 'privateLogsEvidence', 'credentialSeparationEvidence', 'privateAnswersEvidence'] },
] as const;
export interface ReadinessEvidence {
  id: string; condition: typeof m0Conditions[number]['id']; facts: Record<string, string | null>;
  evidenceRefs: string[]; fixtureIds: string[]; sourceRef: string; observedAt: string;
}
export function readinessEvidence(input: unknown): ReadinessEvidence {
  const v = object(input);
  keys(v, ['id', 'condition', 'facts', 'evidenceRefs', 'fixtureIds', 'sourceRef', 'observedAt']);
  const condition = m0Conditions.find(c => c.id === v.condition);
  demand(condition);
  const facts = object(v.facts);
  keys(facts, condition.fields);
  const parsed = Object.fromEntries(condition.fields.map(field => [field, facts[field] === null || facts[field] === undefined ? null : string(facts[field])]));
  const observedAt = string(v.observedAt);
  demand(Number.isFinite(Date.parse(observedAt)) && new Date(observedAt).toISOString() === observedAt);
  const fixtureIds = strings(v.fixtureIds);
  demand(condition.id === 'fixtures' || fixtureIds.length === 0);
  return { id: identifier(v.id), condition: condition.id, facts: parsed, evidenceRefs: strings(v.evidenceRefs), fixtureIds, sourceRef: identifier(v.sourceRef), observedAt };
}
export function completeFixtureSettings(fixture: Fixture): boolean {
  if (!fixture.modelSettings) return false;
  return [fixture.roles.sender, ...fixture.roles.recipients].every(actor => {
    const value = fixture.modelSettings?.[actor];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const fields = value as Record<string, unknown>;
    return ['model', 'permissions', 'quota', 'sourceRef'].every(field => typeof fields[field] === 'string' && fields[field].trim().length > 0)
      && (typeof fields.settings === 'string' && fields.settings.trim().length > 0 || fields.settings !== null && typeof fields.settings === 'object' && !Array.isArray(fields.settings));
  });
}
