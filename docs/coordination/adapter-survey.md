# decision62 P4r2 アダプタおよびハブ既存実装調査書（adapter-survey.md）

## 1. 文書メタデータおよびガバナンス前提

- **文書名**: `adapter-survey.md`
- **文書配置先**: `%TEMP%\semevolve-decision62-20261101\adapter-survey.md`
- **調査担当**: Agy / `gemini-3.8-flash-medium`（調査サブエージェント、非M2実験エージェント、子孫エージェント生成なし）
- **タスク識別子**: decision62 / P4r2（Kota明示承認、排他2タスク構成、P5文書修正と並列）
- **対象リポジトリ**: `D:\develop\works\t3code-cutover-prep-20261005\nightly-history-test-home\worktrees\semevolve\pm-p0-plan`（読取専用）
- **リポジトリ状態（事前/事後確認）**:
  - 対象HEAD: `39412a1e5cee42fb5dc6d2deab792a86fd3f32fd`（事前・事後ともに完全一致）
  - ブランチ: `devin/20261031-1235-m1-roundtrip`（clean、未コミット変更なし）
  - 注意事項: hostブランチ `pm/p0-plan` のメタデータ乖離は認識済みであり、修復・同期は行わない。
- **記録タイムスタンプ（JST）**:
  - 観測開始（First-observed）: `2026-11-01T07:50:17.9012397+09:00`
  - 調査完了（Finishing）: `2026-11-01T07:53:54.1033214+09:00`
- **参照許可入力（Private Inputs）**:
  - `%TEMP%\semevolve-decision60-20261101\TASKS.md`
  - `%TEMP%\semevolve-decision60-20261101\SPEC.proposed.md`
  - `%TEMP%\semevolve-decision60-20261101\SPEC.patch`
  - `%TEMP%\semevolve-decision61-20261101\acceptance-cases.md`
  - `%TEMP%\semevolve-decision61-20261101\parallel-evidence.json`
  - `%TEMP%\semevolve-decision61-20261101\adapter-survey.md`
- **所有権境界**:
  - P4r2は `%TEMP%\semevolve-decision62-20261101\adapter-survey.md` のみを排他所有し作成・更新する。
  - 同一ディレクトリの `parallel-evidence.json` は親エージェントが専有し、P4r2は一切編集・接触しない。
- **作業制約**:
  - リポジトリコードの編集、ブランチ作成、コミット、push、PR操作、CI/Bugbot実行、実ハブ/DB操作、プロセス停止、ルーター/既定変更は一切行わない。
  - M2非公開データへのアクセスは行わない。
  - 本書はソースコード静的読取に基づく調査書（read-only research/docs）であり、テスト実行や製品RED/GREENの主張は行わない。実機動作は「未確認」と明記する。

---

## 2. 既存ハブ操作 要約対応表（Concise Mapping Table）

現行HEAD（`39412a1e5cee42fb5dc6d2deab792a86fd3f32fd`）における `apps/cli/src/hub-cli.ts`, `hub.ts`, `hub-store.ts`, `hub-data.ts` の静的読取に基づく対応一覧。

| 操作 (Operation) | 実際のCLI構文または関数呼び出し | 引数・戻り値の型 | 永続化ストレージ | ソース位置 (Path:Line) | 検証状態 |
|---|---|---|---|---|---|
| `prepare` | CLI: `npm run start:hub -- prepare --input <prepare.json>`<br>関数: `prepareHub(input)` → `prepareStore(input)` | 入力: `{ directory: string, participants: Participant[] }`<br>戻り値: `Result<PreparedHub>` (`{ authorityPath, databasePath, contexts }`) | ディレクトリ（0700）作成。<br>`hub.sqlite`、`authority.json`、`context-N.json` 生成。<br>テーブル: `metadata`, `principals`, `records`, `deliveries` | `apps/cli/src/hub-cli.ts:20,35-39`<br>`apps/cli/src/hub.ts:12-14`<br>`apps/cli/src/hub-store.ts:79-84,118-202` | 静的読取検証済<br>（実機動作は未確認） |
| `join` | CLI: `npm run start:hub -- join --authority <authority.json> --context <context.json> [--input <join.json>]`<br>関数: `hub.join(input)` | 入力: 任意 `{ id?: string, connectionRef?: string, sessionRef?: string }`<br>戻り値: `Result<{ actorId: string, state: 'joined' }>` | `principals` テーブル更新:<br>`UPDATE principals SET state='joined' WHERE id=?` | `apps/cli/src/hub-cli.ts:19-20,44-55`<br>`apps/cli/src/hub.ts:265-276`<br>`apps/cli/src/hub-store.ts:81` | 静的読取検証済<br>（実機動作は未確認） |
| `leave` | CLI: `npm run start:hub -- leave --authority <authority.json> --context <context.json>`<br>関数: `hub.leave()` | 入力: なし（`noInput`、`--input` 不可）<br>戻り値: `Result<{ actorId: string, state: 'left' }>` | `principals` テーブル更新:<br>`UPDATE principals SET state='left' WHERE id=?` | `apps/cli/src/hub-cli.ts:19-20,44-48,56`<br>`apps/cli/src/hub.ts:277-282`<br>`apps/cli/src/hub-store.ts:81` | 静的読取検証済<br>（実機動作は未確認） |
| `send` | CLI: `npm run start:hub -- send --authority <authority.json> --context <context.json> --input <send.json>`<br>関数: `hub.send(input)` | 入力: `{ id, runId, languageVersion, sender?, recipients, body, kind }`<br>戻り値: `Result<Message>` (`{ id, runId, languageVersion, sender, recipients, body, kind }`) | `records` テーブル（メッセージ本体）:<br>`INSERT INTO records VALUES ('message', id, data)`<br>`deliveries` テーブル（宛先別配送行）:<br>`INSERT INTO deliveries VALUES (id, recipient, NULL, NULL)` | `apps/cli/src/hub-cli.ts:19-20,23,44-50,57`<br>`apps/cli/src/hub.ts:162-176`<br>`apps/cli/src/hub-data.ts:4-7,16-23`<br>`apps/cli/src/hub-store.ts:82-83,227-234` | 静的読取検証済<br>（実機動作は未確認） |
| `inbox` | CLI: `npm run start:hub -- inbox --authority <authority.json> --context <context.json> [--input <inbox.json>]`<br>関数: `hub.inbox(input)` | 入力: 任意 `{ recipientId?: string }`（自身のアクターIDのみ許容）<br>戻り値: `Result<Message[]>`（未ackメッセージ配列） | `deliveries` から未受領抽出:<br>`SELECT message_id FROM deliveries WHERE recipient_id=? AND acked_at IS NULL`<br>`records` から本体取得 (`kind='message'`) | `apps/cli/src/hub-cli.ts:19-20,44-50,58`<br>`apps/cli/src/hub.ts:154-156,177-189`<br>`apps/cli/src/hub-store.ts:82-83,218-220` | 静的読取検証済<br>（実機動作は未確認） |
| `ack` | CLI: `npm run start:hub -- ack --authority <authority.json> --context <context.json> --input <ack.json>`<br>関数: `hub.ack(input)` | 入力: `{ messageId: string, recipientId?: string }`<br>戻り値: `Result<Delivery>` (`{ messageId, recipientId, ackedAt, appliedAt, understanding: null, taskCompletion: null, evaluation: null }`) | `deliveries` テーブル更新:<br>`UPDATE deliveries SET acked_at=COALESCE(acked_at,?) WHERE message_id=? AND recipient_id=?`<br>（※`applied_at` は更新されない） | `apps/cli/src/hub-cli.ts:19-20,23,44-50,59`<br>`apps/cli/src/hub.ts:157-161,190-202`<br>`apps/cli/src/hub-data.ts:8-11`<br>`apps/cli/src/hub-store.ts:83` | 静的読取検証済<br>（実機動作は未確認） |
| `translate` | CLI: `npm run start:hub -- translate --authority <authority.json> --context <context.json> --input <trans.json>`<br>関数: `hub.translate(input)` | 入力（保存）: `{ id, sourceMessageId, runId, languageVersion, targetLanguage, text, sourceRef }`<br>入力（照会）: `{ sourceMessageId }`<br>戻り値: `Result<Translation[]>` | `records` テーブル保存・照会:<br>`kind='translation'` として `records` に保存・リスト取得 | `apps/cli/src/hub-cli.ts:19-20,23,44-50,60`<br>`apps/cli/src/hub.ts:130-147`<br>`apps/cli/src/hub-data.ts:12-15`<br>`apps/cli/src/hub-store.ts:82,223-235` | 静的読取検証済<br>（実機動作は未確認） |

---

## 3. 操作別ソースコードマッピング詳細

### 3.1 `prepare`
- **CLI構文**: `npm run start:hub -- prepare --input <absolute_prepare.json>`（`apps/cli/src/hub-cli.ts:20,35-39`）
- **フラグ仕様**: `--input` のみが必須かつ単一オプションとして要求される。`--authority` や `--context` の指定は拒否される（`apps/cli/src/hub-cli.ts:36-39`）。
- **呼出関数**: `prepareHub(input: unknown): Result<PreparedHub>`（`apps/cli/src/hub.ts:12-14`）→ `prepareStore(input: unknown): PreparedHub`（`apps/cli/src/hub-store.ts:123-202`）
- **入力型**:
  ```typescript
  interface PrepareRequest {
    directory: string; // Gitリポジトリ外の新規絶対パス（ディレクトリ親が存在し本ディレクトリは未存在であること）
    participants: Participant[]; // 1名以上のPMを含む参加者配列（ID、connectionRef、sessionRefは重複不可）
  }
  ```
- **出力型**:
  ```typescript
  interface PreparedHub {
    authorityPath: string; // 生成された authority.json の絶対パス
    databasePath: string;  // 生成された hub.sqlite の絶対パス
    contexts: { actorId: string; path: string }[]; // 各参加者の context-N.json のパス
  }
  ```
- **永続化とスキーマ**:
  - ディレクトリモード `0o700`、ファイルモード `0o600` で作成（`apps/cli/src/hub-store.ts:145-152`）。
  - `hub.sqlite` に以下の STRICT テーブル群を作成（`apps/cli/src/hub-store.ts:79-84`）:
    - `metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`
    - `principals (id TEXT PRIMARY KEY, profile TEXT NOT NULL, secret_hash TEXT NOT NULL, os_binding TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('provisioned','joined','left'))) STRICT`
    - `records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)) STRICT`
    - `deliveries (message_id TEXT NOT NULL, recipient_id TEXT NOT NULL REFERENCES principals(id), acked_at TEXT, applied_at TEXT, PRIMARY KEY(message_id,recipient_id)) STRICT`
  - メタデータ初期化: `schema = 'semevolve-m0-1'`, `database = <databaseId>`（`apps/cli/src/hub-store.ts:160-161`）。
  - 各参加者を `principals` に `state = 'provisioned'` で登録（`apps/cli/src/hub-store.ts:165`）。
  - 各参加者向けの `context-N.json` を書き出し（`databaseId`, `actorId`, `connectionRef`, `sessionRef`, `osBinding`, `secret`）（`apps/cli/src/hub-store.ts:166-168`）。
  - `authority.json` を書き出し（`schema: 'semevolve-m0-1'`, `databaseId`, `databasePath`）（`apps/cli/src/hub-store.ts:175`）。

### 3.2 `join`
- **CLI構文**: `npm run start:hub -- join --authority <authority.json> --context <context.json> [--input <join.json>]`（`apps/cli/src/hub-cli.ts:19-20,44-55`）
- **呼出関数**: `hub.join(input: unknown = {}): Result<{ actorId: string; state: 'joined' }>`（`apps/cli/src/hub.ts:265-276`）
- **入力検証**:
  - 入力は任意オブジェクト（省略時は空オブジェクト `{}`）（`apps/cli/src/hub-cli.ts:49`）。
  - 許容プロパティ: `id`, `connectionRef`, `sessionRef`（`apps/cli/src/hub.ts:268`）。
  - `id` が指定された場合、認証済み `actor.id` と一致必須（不一致時は `unauthorised`）（`apps/cli/src/hub.ts:270`）。
  - `connectionRef`, `sessionRef` が指定された場合、`actor` の値と一致必須（不一致時は `conflict`）（`apps/cli/src/hub.ts:271-272`）。
- **ストレージ更新**: `UPDATE principals SET state='joined' WHERE id=?`（`apps/cli/src/hub.ts:273`）。

### 3.3 `leave`
- **CLI構文**: `npm run start:hub -- leave --authority <authority.json> --context <context.json>`（`apps/cli/src/hub-cli.ts:19-20,44-48,56`）
- **入力検証**: `--input` の指定は禁止（`noInput` コマンド）（`apps/cli/src/hub-cli.ts:45,47`）。
- **呼出関数**: `hub.leave(): Result<{ actorId: string; state: 'left' }>`（`apps/cli/src/hub.ts:277-282`）
- **ストレージ更新**: `UPDATE principals SET state='left' WHERE id=?`（`apps/cli/src/hub.ts:279`）。

### 3.4 `send`
- **CLI構文**: `npm run start:hub -- send --authority <authority.json> --context <context.json> --input <send.json>`（`apps/cli/src/hub-cli.ts:19-20,23,44-50,57`）
- **呼出関数**: `hub.send(input: unknown): Result<Message>`（`apps/cli/src/hub.ts:162-176`）
- **入力型および制約**:
  ```typescript
  interface SendInput {
    id: string; // identifier (<= 256文字)
    runId: string; // 認証済みアクターが所属する run の ID
    languageVersion: string; // run.languageVersion と完全一致必須
    sender?: string; // 任意。指定時は認証済みアクターIDと一致必須（不一致は unauthorised）
    recipients: string[]; // 宛先アクターID配列（1名以上、重複不可、principals登録済み、かつ run.actors に含まれていること）
    body: string; // 空文字可、NUL文字不可
    kind: 'canary' | 'language_introduction' | 'request' | 'understanding' | 'correction' | 'result'; // 厳格な6値のみ
  }
  ```
- **実行時バリデーション**:
  - `this.joined()`: アクターの `principals.state` が `'joined'` であること（`apps/cli/src/hub.ts:164,203-205`）。
  - `message(input, this.store.actor.id)`: `sender` の検証とキー制限（`apps/cli/src/hub-data.ts:16-23`）。
  - `this.accessibleRun(value.runId)`: `run` が存在し、`run.actors` に送信者が含まれていること（`apps/cli/src/hub.ts:148-153,166`）。
  - 言語版一致: `value.languageVersion === run.languageVersion`（不一致時は `language_mismatch`）（`apps/cli/src/hub.ts:167`）。
  - 宛先検証: 全宛先が `principals` に存在すること（`unknown_actor`）、かつ全宛先が `run.actors` に含まれていること（不一致時は `unauthorised`）（`apps/cli/src/hub.ts:168-169,206-208`）。
- **ストレージ永続化**:
  - メッセージ本体: `this.store.put('message', value.id, value)`（`apps/cli/src/hub.ts:170`）
    - 実装: `INSERT INTO records VALUES ('message', id, canonical(value))`（`apps/cli/src/hub-store.ts:227-234`）。
    - 既存IDが存在する場合、内容が完全一致すれば既存値を返し、異なれば `conflict` エラー（不変性保護）。
  - 宛先配送レコード: 各宛先について以下を実行（`apps/cli/src/hub.ts:171-173`）:
    - `INSERT INTO deliveries VALUES (?, ?, NULL, NULL) ON CONFLICT(message_id, recipient_id) DO NOTHING`
    - 初期状態として `acked_at` は `NULL`、`applied_at` は `NULL`。

### 3.5 `inbox`
- **CLI構文**: `npm run start:hub -- inbox --authority <authority.json> --context <context.json> [--input <inbox.json>]`（`apps/cli/src/hub-cli.ts:19-20,44-50,58`）
- **呼出関数**: `hub.inbox(input: unknown = {}): Result<Message[]>`（`apps/cli/src/hub.ts:177-189`）
- **入力検証**:
  - 任意入力 `{ recipientId?: string }`。
  - `recipientId` が指定された場合、`this.store.actor.id` と完全一致必須（他者のID指定は `unauthorised`）（`apps/cli/src/hub.ts:154-156,182`）。
- **ストレージ読取**:
  - 配送キュー検索: `SELECT message_id FROM deliveries WHERE recipient_id=? AND acked_at IS NULL ORDER BY rowid`（`apps/cli/src/hub.ts:183`）。
  - メッセージ実体取得: 各 `message_id` について `this.store.get<Message>('message', id)`（`SELECT data FROM records WHERE kind='message' AND id=?`）（`apps/cli/src/hub.ts:184-186`, `apps/cli/src/hub-store.ts:218-220`）。
- **戻り値**: 未受領（未ack）メッセージオブジェクトの配列 `Message[]`。

### 3.6 `ack`
- **CLI構文**: `npm run start:hub -- ack --authority <authority.json> --context <context.json> --input <ack.json>`（`apps/cli/src/hub-cli.ts:19-20,23,44-50,59`）
- **呼出関数**: `hub.ack(input: unknown): Result<Delivery>`（`apps/cli/src/hub.ts:190-202`）
- **入力型および制約**:
  - `{ messageId: string, recipientId?: string }`（`apps/cli/src/hub.ts:194`）。
  - `recipientId` が指定された場合、自身のアクターIDと一致必須（`apps/cli/src/hub.ts:154-156,195`）。
  - 指定された `messageId` が `records`（`kind='message'`）に存在すること（未存在時は `unknown_message`）（`apps/cli/src/hub.ts:197`）。
  - 対象アクターに対する配送レコードが `deliveries` に存在すること（存在しない場合は `unauthorised`）（`apps/cli/src/hub.ts:157-161,198`）。
- **ストレージ更新**:
  - `UPDATE deliveries SET acked_at=COALESCE(acked_at,?) WHERE message_id=? AND recipient_id=?`（`apps/cli/src/hub.ts:199`）。
  - パラメータ: `new Date().toISOString()`, `id`, `this.store.actor.id`。
  - すでに `acked_at` が記録されている場合は上書きせず既存値を維持（`COALESCE` による冪等性）。
  - ※注意: `applied_at` は `ack` 操作では一切変更されない。`recordMeasurement` が既に設定していない限り `NULL` であり、設定済みの場合はその値を維持する。`applied_at` の記録は `recordMeasurement`（`direction === 'input'`）の呼出時のみに行われる（`apps/cli/src/hub.ts:96-97,157-160,190-200`）。
- **戻り値**:
  ```typescript
  interface Delivery {
    messageId: string;
    recipientId: string;
    ackedAt: string | null; // ISO文字列
    appliedAt: string | null; // null
    understanding: null;
    taskCompletion: null;
    evaluation: null;
  }
  ```

### 3.7 `translate`
- **CLI構文**: `npm run start:hub -- translate --authority <authority.json> --context <context.json> --input <translate.json>`（`apps/cli/src/hub-cli.ts:19-20,23,44-50,60`）
- **呼出関数**: `hub.translate(input: unknown): Result<Translation[]>`（`apps/cli/src/hub.ts:130-147`）
- **動作モード**:
  1. **保存モード（`v.id` 指定時）**:
     - 入力: `{ id, sourceMessageId, runId, languageVersion, targetLanguage, text, sourceRef }`。
     - 元メッセージ検証: `accessibleMessage(sourceMessageId)` により、元メッセージが存在し自身が送信者または受信者であること（`apps/cli/src/hub.ts:124-129,134`）。
     - 整合性検証: `v.runId === source.runId && v.languageVersion === source.languageVersion`（不一致時は `source_mismatch`）（`apps/cli/src/hub.ts:138`）。
     - 保存処理: `authorId = this.store.actor.id`, `meaningVerified = false` として `records` テーブルに `kind='translation'` で保存（`apps/cli/src/hub.ts:139-143`）。
  2. **照会モード（`v.id` 未指定時）**:
     - 入力: `{ sourceMessageId }`（`apps/cli/src/hub.ts:135`）。
     - 取得処理: 当該 `sourceMessageId` に紐付く全翻訳レコードを `records` から取得して返す（`apps/cli/src/hub.ts:145`）。

---

## 4. アクター拘束・セッション状態検証（Actor Binding & Identity Enforcement）

### 4.1 プロビジョニング時のアクター定義（Participant）
- `prepareStore` において、各参加者は以下の型として定義される（`apps/cli/src/hub-store.ts:64-76`）:
  ```typescript
  interface Participant {
    id: string; // actorId (形式: /^[a-zA-Z0-9][a-zA-Z0-9._-]*@[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
    role: 'pm' | 'worker';
    connectionRef: string;
    sessionRef: string;
    capabilities: string[];
    languageVersions: string[];
  }
  ```
- 各参加者の公開プロファイルおよび秘密情報は `principals` テーブルに永続化される（`apps/cli/src/hub-store.ts:81,163-168`）:
  - `id`: アクターID
  - `profile`: Participantの正規化JSON
  - `secret_hash`: 32バイト乱数シークレットのSHA256ハッシュ
  - `os_binding`: ホスト環境識別子
  - `state`: `'provisioned'`（初期状態）

### 4.2 OSバインディング（Host & User Binding）
- OSバインディング値は以下のように生成される（`apps/cli/src/hub-store.ts:62`）:
  `osBinding = sha256(canonical({ host: os.hostname(), user: os.userInfo().username, uid: os.userInfo().uid }))`
- 生成時のマシン名、OSユーザー名、UIDと実行環境が一致しない場合、ストアのオープン時に `unauthorised` エラーとなる（`apps/cli/src/hub-store.ts:256,262`）。

### 4.3 認証およびオープン処理（`openStore`）
- 各CLI呼出時、`--authority <authority.json>` と `--context <context.json>` が必須（`apps/cli/src/hub-cli.ts:44`）。
- 以下の条件がすべて検証される（`apps/cli/src/hub-store.ts:240-271`）:
  1. `authority.json` と `context.json` が同一の正準プライベートディレクトリに存在すること。
  2. `authority.schema === 'semevolve-m0-1'` であること。
  3. `authority.databasePath` が同一ディレクトリの `hub.sqlite` を正しく指していること。
  4. `context.databaseId === authority.databaseId` であること。
  5. `context.osBinding === osBinding()` であること。
  6. SQLite内の `principals` テーブルから `context.actorId` の行を取得し:
     - `row.secret_hash === sha256(context.secret)`
     - `row.os_binding === context.osBinding`
     - `profile.connectionRef === context.connectionRef`
     - `profile.sessionRef === context.sessionRef`
  7. 全条件が満たされた場合のみ、`HubStore(db, actor)` インスタンスが返される。

### 4.4 セッション状態制約（`joined` State Check）
- `Hub` の次の操作（`captureM1`, `reportM1`, `send`, `inbox`, `ack`, `translate`, `inspect`, `recordMeasurement`, `measurements`, `importRecords`, `recordReadiness`, `checkM0`）は冒頭でプライベートメソッド `this.joined()` を実行する（`apps/cli/src/hub.ts:22-26,38,47,68,104,132,164,179,192,203-205,211,252`）。
  ```typescript
  private joined(): void {
    demand(this.store.db.prepare('SELECT state FROM principals WHERE id=?').get(this.store.actor.id)?.state === 'joined', 'not_joined');
  }
  ```
- 未joinで `principals.state` が `'joined'` ではない場合、上記の `joined` checkを通る操作は `not_joined` エラーにより拒絶される。
- `leave` 操作を実行すると `state` は `'left'` となり、上記の操作は再び遮断される（`apps/cli/src/hub.ts:203-205,277-282`）。`identity`、`close`、`join`、`leave` 自体は `joined` checkを通らない（`apps/cli/src/hub.ts:31-35,265-282`）。

### 4.5 送信元偽装防止と宛先境界
- `send` 操作時、入力JSONに `sender` が含まれている場合、認証アクターIDと一致することが検証され、不一致は `unauthorised` となる（`apps/cli/src/hub-data.ts:19`）。入力に `sender` が含まれない場合は自動的に認証アクターIDが設定される。
- 送信先 `recipients` は `principals` に登録された既知アクターであるだけでなく、メッセージが属する `run` の定義に含まれる参加者一覧（`run.actors`）の完全な部分集合でなければならない（`apps/cli/src/hub.ts:168-169`）。参加していないアクターへのメッセージ送信は `unauthorised` となる。
- `inbox` および `ack` は、自身のアクターID宛ての配送のみに厳格に制限され、他者の配送へのアクセスや確認は拒絶される（`apps/cli/src/hub.ts:154-159,182,195`）。

---

## 5. 新規ワーカー起動依頼の検証（Actual Hub vs Proposed Convention / Host API）

### 5.1 現行ハブ実装の事実（Actual Hub Code: 未サポート）
1. **プロセス起動機能・プロバイダ起動の完全な不在**:
   - `apps/cli/src/hub-cli.ts` のヘルプ出力（24行目）に明記:
     `limits: 'Local OS/session context only. No provider launch. Ack is receipt only. Translation stores provided text with meaning unverified. M0 readiness uses operator evidence.'`
   - 利用可能なCLIコマンド（`apps/cli/src/hub-cli.ts:9`）は以下の14個に限定されており、ワーカー起動に関連するコマンド（`launch`, `spawn`, `fork` 等）は存在しない:
     `prepare`, `join`, `leave`, `send`, `inbox`, `ack`, `translate`, `import`, `inspect`, `record`, `measurements`, `record-readiness`, `check-m0`, `tokenise`。
   - 未定義のコマンド（例: `launch-agent`）を実行すると、引数解析で弾かれ `HubError('invalid_input', 'Invalid hub input.')`（exit code 2）となる（`tests/integration/m0/cli.test.mjs:99-100` で検証済み）。
2. **メッセージ種別（`Message.kind`）による制限**:
   - `apps/cli/src/hub-data.ts:6,20` において、`Message.kind` は以下の6種に限定されている:
     `'canary' | 'language_introduction' | 'request' | 'understanding' | 'correction' | 'result'`
   - `worker_launch` や `spawn_request` といったメッセージ種別はスキーマ上許容されておらず、送信しようとすると `invalid_input` エラーとなる。
3. **参加者登録の不変性**:
   - `prepare` 完了後のハブに対して、参加者（`principals`）を動的に追加・登録するAPIやCLIは存在しない。
   - `SPEC.md:88` に明記: `「prepareは既存directoryを変更せず、登録後のcontext追加・接続の乗り換えは提供しません。」`

### 5.2 decision60 提案仕様（Proposed Convention / Host API）との差異
- `decision60 SPEC.patch` および `SPEC.proposed.md:34,36` で提案された仕様:
  - 承認済みタスクの範囲内において、エージェント同士が直接 `inbox` / `send` を用いて通信すること。
  - 新規ワーカーが必要な場合、目的・作業範囲・依存・担当予定ファイル・想定モデルを添えて起動依頼を行えること。
  - 起動可否は「承認済みの分担表（TASKS.md）」「担当範囲」「hostの空き枠」と照合して判定されること。
- **実行主体の明確な分離**:
  - 提案仕様におけるワーカー起動は、**ホスト側の起動API（T3 Code `delegate_task` / オーケストレータ等）** が担うものであり、ハブ自身がOSプロセスやプロバイダAPIを叩いてエージェントを生成する構造ではない。
  - 現行HEADのリポジトリコードには、起動依頼メッセージの解釈やホスト起動API呼び出しの連携ロジックは一切実装されていない（**Proposed / 未実装**）。

---

## 6. D61-P5-F1 記録ミスの検証と現行事実の確定

decision61 P5ドラフト（`acceptance-cases.md`）において指摘され、新指摘ゲート停止となった不整合（D61-P5-F1）について、現行リポジトリHEADコードとの対比を確定する。
本件は製品のバグではなく、仕様受入ケース側のドキュメント記録ミスであり、P5での修正が承認されている。

| 指摘項目 | P5ドラフトの誤った前提 (D61-P5-F1) | 現行コードの実装事実 (HEAD Ground Truth) | 該当ソースコード位置 |
|---|---|---|---|
| (1) `--authority` 引数 | `--authority <hub.sqlite>`（SQLite DBファイルを指定） | `--authority <authority.json>`（絶対パスの `authority.json` を指定）。`hub.sqlite` を渡すと `invalid_path` エラーとなる。 | `apps/cli/src/hub-cli.ts:20`<br>`apps/cli/src/hub-store.ts:243-246` |
| (2) メッセージ保存先テーブル | `messages` テーブルが存在すると仮定 | 専用の `messages` テーブルは存在せず、汎用レコードテーブル `records (kind, id, data)` の `kind = 'message'` として保存される。 | `apps/cli/src/hub-store.ts:82,227-234` |
| (3) 配送ステータス管理 | `deliveries.status` 列が存在し `'delivered'` 等が入ると仮定 | `deliveries` テーブルに `status` 列は存在しない。配送・受領状態は `acked_at` および `applied_at` の日時文字列（または `NULL`）で表現される。 | `apps/cli/src/hub-store.ts:83`<br>`apps/cli/src/hub.ts:157-160,172,183,199` |
| (4) 送信者プロパティ名 | 送信ペイロードで `senderId` を指定 | プロパティ名は `sender`。入力で `senderId` を渡すとキー検証（`keys`）で弾かれ `invalid_input` エラーとなる。 | `apps/cli/src/hub-data.ts:5,16-23` |
| (5) エラーコードの命名則 | 大文字スネークケース（`SENDER_MISMATCH`, `CONTENT_COLLISION` 等）を仮定 | すべて小文字スネークケース（`unauthorised`, `conflict`, `invalid_input`, `unknown_actor`, `not_joined` 等）で定義されている。 | `apps/cli/src/hub.ts:150-151,167-169,204,207`<br>`apps/cli/src/hub-store.ts:12-13,227-234` |

---

## 7. 境界制約遵守および結論

- **新規具体的所見（NEW concrete finding）の有無**:
  - 本静的調査において、現行コードとリポジトリドキュメント（`SPEC.md`, `README.md`）の間に新たな矛盾・未解決の製品欠陥は検出されなかった（**新規指摘なし・未解決事項なし**）。
  - D61-P5-F1 として報告された受入ケース側の不整合は、上記第6節の通り現行コードの仕様と完全に照合・整理された。
- **実機検証の留保**:
  - 本調査は読取専用環境におけるソースコードの静的追跡に基づき完了した。
  - 実DBの作成、実CLIの実行、並列ワーカーからのSQLite WAL同時書き込み競合等の動的挙動については、制約に従い一切のテスト・実行を行っておらず、「未確認」として保持する。
- **後続タスクへの引継ぎ**:
  - P5の受入ケース修正（P5 correction）は、本調査書に示した現行スキーマ（`records`, `deliveries`）、CLIオプション（`--authority authority.json`）、アクター拘束規則に準拠して記述される必要がある。
  - ワーカー間直接通信および起動依頼の実装は将来の変更（Proposed）であり、既存実装と厳格に分離して扱われる。