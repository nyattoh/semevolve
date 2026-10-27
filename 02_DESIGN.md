# AI共通言語育成基盤 — 設計書

**文書版：0.1 / 作成日：2026-10-27（日本時間） / 状態：新規実装の提案**  
対応要求：[仕様書](01_SPECIFICATION.md)。研究の判定方法：[評価計画](04_EVALUATION.md)。外部仕様の根拠：[出典一覧](05_SOURCES.md)。

> この文書の型、コンポーネント名、DB表、状態機械は本プロジェクトへの提案であり、agmsgやTOMBOに同名のAPIが存在するという意味ではない。

## 1. 設計上の決定

| ID | 決定案 | 理由と留意点 |
|---|---|---|
| D1 | ローカル優先のTypeScriptアプリとする | TOMBOがTypeScript SDKとNode.js系の実行経路を持つため。[S2] [S3] |
| D2 | GPUとモデル再学習を不要にする | 公開された文字列・ツール入出力で試す。内部状態通信の代替実証とは呼ばない。 |
| D3 | 通信、意味表現、検査、実行権限を分離する | 理解できることと実行してよいことを混同しない。 |
| D4 | 通信路は交換可能とし、agmsgは例示で採用必須ではない | 既存DBや導入環境へ侵襲的な変更を加えずに利用する。[S1] |
| D5 | 本体保存先と通信路の内部保存を分離し、DB製品は未選択とする | 言語に応じた分解・テーブル・関係・索引をAIが自律設計する。現行構造維持も候補とし、製品や固定文法を先決しない。 |
| D6 | 言語版は不変、作業区間で固定する | 同じメッセージが時間によって別の意味へ変わることを防ぐ。 |
| D7 | AIが作った解釈を独立検査へ渡す | 自己申告・二者の合意だけで意味伝達を成功にしない。 |
| D8 | 辞書の読込み・検査・復旧も費用に含める | 短い本文だけを測って高速化と主張しない。 |

Node.jsの実際のバージョンと、選択する保存先の接続実装は、採用したTOMBO版とWindows実機で適合確認して固定する。SQLiteを採用する場合のバインディングも未選択である。TOMBO確認版の文書はNode.js 22以上を要求している。[S2] [S3] この文書では未確認のnpmパッケージ版を指定しない。

## 2. 全体構造

```text
利用者の目的・資料・許可・予算
                 |
          Local Host / UI
                 |
     Policy + Budget + Task Registry
                 |
       Peer A <-------> Peer B
        |     共通語の交渉・利用     |
        +---- TransportAdapter ----+
             任意のローカル通信路
                 |
     Language Registry + Event Store
                 |
     Interpretation / Plan Records
                 |
             TomboBridge
                 |
       Evidence / Probe Executor
                 |
        Independent Evaluator
                 |
    結果・未知・誤解の記録・改訂候補
```

意味内容の提案・問い返し・修正はAI同士に委ねる。ホストは配送、許可、予算、版の切替、検査の実行条件を管理する。ホストが毎回「どちらの意見が正しいか」を文章で裁定する中央司令塔にはしない。一方、オーケストレーションが完全に不要になるとは主張しない。

### 2.1 構成要素

| 要素 | 責務 | 責務に含めないこと |
|---|---|---|
| Local Host | 作業の起動・停止、局所的な調整、画面・記録 | 無制限の自律実行、意味の真偽の独断 |
| ProviderAdapter | 正規CLI等との接続、能力・利用量の取得 | 資格情報の抜取り、非公開APIへの迂回 |
| Peer Runtime | 共通語の提案、符号化、解釈、改訂 | 勝手な権限変更、採点正解の閲覧 |
| TransportAdapter | メッセージの送受信・再配送 | 語彙の解釈、真偽の判定 |
| Language Registry | 不変版、用途、適合結果、親子関係の保持 | 一つの固定辞書への強制 |
| TomboBridge | 点検対象の構築、SDK状態との対応付け | TOMBOの意味理解保証の捏造 |
| Probe Executor | 許可された資料読取り・検査の実行 | AIが書いたテスト結果の無検査採用 |
| Evaluator | 伝達適合・事実・作業結果の別判定 | 言語候補を有利にする採点基準の後付け |
| Policy Gate | 許可範囲、実行対象、上限の強制 | 共通語による許可の上書き |

MVPではPeer A/Bと既存の会話内AIが、役割を交代して提案・点検を行える。常時第三の有料AIを置く構成を必須にしない。ただし役割の分離だけで判断の独立性が成立したとは扱わない。

## 3. 接続・通信の設計

### 3.1 接続前の能力確認

接続ごとに、提供者、CLI版、モデル識別子、認証区分、利用枠の確認日時、入出力形式、再開機能、取消の可否、サンドボックス能力、取得できる利用量を記録する。秘密値は記録しない。

認証区分は `subscription / api_key / other / unknown`、追加課金の可能性は `disabled / possible / unknown` とする。既存サブスク前提モードでは、課金経路が不明または追加課金の可能性が排除できない接続を自動起動しない。

Codexの非対話実行とClaude Codeのプログラム実行には公式資料があるが、機能の存在と、各利用者が今その方法を契約上・運用上利用できることは別である。[S6] [S7] [S8] 特にAPIキーの環境変数による認証の切替に注意する。[S9]

### 3.2 アプリ内部の接続契約（提案）

```typescript
type EvidenceStatus = 'verified' | 'unverified' | 'unavailable';

type Usage = {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costYen: number | null;
  elapsedMs: number;
  source: 'provider' | 'local_estimate' | 'unavailable';
};

interface ProviderAdapter {
  inspectCapabilities(): Promise<{
    provider: string;
    cliVersion: string | null;
    modelId: string | null;
    authMode: 'subscription' | 'api_key' | 'other' | 'unknown';
    billingStatus: 'disabled' | 'possible' | 'unknown';
    evidenceStatus: EvidenceStatus;
  }>;
  invoke(request: PeerRequest, signal: AbortSignal): Promise<PeerResult>;
}

interface TransportAdapter {
  send(envelope: Envelope): Promise<DeliveryReceipt>;
  receive(cursor: string | null): Promise<DeliveryBatch>;
  acknowledge(messageId: string): Promise<void>;
}
```

`PeerRequest`、`PeerResult`、`Envelope`等は本アプリの型であり、上流SDKの型ではない。プロバイダごとに可能な能力へ変換する。取消を要求しても、遠隔の生成が停止・無課金になったとは断定しない。

### 3.3 交換可能な通信路との境界

通信路は未選択であり、agmsgは例示に過ぎない。以下は採用した場合のみ適用する。

既存の送受信スクリプト・サポートされた入口をアダプターから使う。agmsgのメッセージ表へ独自SQLを書き込まない。実際のコマンド引数は導入版のヘルプと機構テストで確認し、本書で架空のフラグを作らない。[S1]

WindowsではGit Bashの実行経路と各エージェントのHOME・DBパスを確認する。Git BashとWSLの別環境を混ぜて、同じDBを使っていると誤認しない。上流文書にWindowsの経路説明はあるが、本資料作成時に利用者のPCで動作確認したわけではない。[S1]

agmsgの有無によらず、同じTransportAdapter契約を満たすローカル実装を選択できる。無断で別サービスへ送信するフォールバックは行わない。

### 3.4 配送と適用

ホスト側でoutbox方式を採用する。送信要求を本体DBに保存してから通信路へ渡す。受信側はメッセージIDによって重複適用を防ぐ。

配送・既読・受信解釈・検査合格は別の状態である。受信通知を「理解した」に変換しない。通信路をまたぐ厳密なexactly-onceは仮定しない。再配送はあり得るものとし、状態変更側を冪等にする。

## 4. 固定する封筒と、可変の言語本文

### 4.1 Envelopeの例

```json
{
  "protocol_version": "0.1",
  "message_id": "msg-demo-001",
  "task_id": "task-demo-001",
  "epoch_id": "epoch-demo-001",
  "sender_id": "peer-a",
  "recipient_ids": ["peer-b"],
  "kind": "utterance",
  "language_version_id": "lang-demo-v1",
  "context_revision": 3,
  "causation_ids": [],
  "content_type": "text/plain; charset=utf-8",
  "payload": "ILLUSTRATIVE_PAYLOAD_NOT_A_LANGUAGE_SPEC",
  "created_at": "2026-10-27T14:16:45+09:00"
}
```

この値は説明用の合成例であり、実際の交換・発明・計測の記録ではない。実装ではホストがID・時刻・ハッシュを生成する。日時をAIに推測させない。

`kind`は配送と管理のための分類で、例えば `utterance / clarification / proposal / acceptance / rejection / language_notice / cancellation` を使う。`acceptance`も適合検査の合格ではない。

### 4.2 受信時の必須検証

1. サイズ、形式、プロトコル版、taskと宛先、参加権限を確認する。
2. メッセージIDが既存なら、同じ内容の再配送か、内容の違うID衝突かを区別する。
3. epochに固定された言語版とcontext_revisionを照合する。
4. 対応する言語パッケージを持つか、適合確認の範囲内かを確認する。
5. 成功時だけ解釈処理へ渡す。不明な版・古い前提を勝手に読み替えない。

本文の `sender_id` だけで送信者を認証しない。登録済みの接続と配送情報で照合する。同じOS利用者が全ファイルを操作できるローカル環境を、悪意ある参加者に対して隔離済みと宣伝しない。

### 4.3 初期交渉

`language_version_id: null` を許すのは、明示したbootstrap区間や許可された自然言語による確認だけとする。通常作業へ無印で混入させない。自然言語へ戻ること自体は禁止せず、理由・回数・時間を記録する。

## 5. 言語パッケージ

言語パッケージは、任意の表現体系を包む版管理用の容器とする。

| フィールド | 内容 | 作成者 |
|---|---|---|
| version_id / digest | 不変の識別子と内容ハッシュ | ホスト |
| parent_ids | 改訂元。分岐・合流に対応 | 提案AI＋ホスト検証 |
| scope | 用途、課題範囲、対象参加者 | AI提案＋登録 |
| specification_text | 語彙・構文・合成規則・例外の説明 | AI同士 |
| public_examples | 用例・反例・解釈の説明 | AI同士 |
| change_reason | どの誤解・不足を直すか | AI同士 |
| compatibility_claims | 対応可能という提案 | AI同士。未検証と区別 |
| conformance_refs | 独立試験の記録への参照 | 検査ホスト |
| status_events | 候補、試用、採用等の履歴 | ホスト |

JSONはこの容器の形式に過ぎない。`specification_text`を人間の固定した意味スロットだけに限定しない。グラフも選択肢の一つであり、必須の共通意味空間とはしない。

パッケージに隠し評価の正解、秘密情報、任意実行コードを含めない。AIが実行可能なパーサーを提案した場合、MVPではコードとして起動せず設計案として保持する。将来導入するなら別のコード審査・サンドボックス・権限審査を経る。

パッケージのハッシュ一致は同じデータであることの確認であり、同じ意味に理解したことの証明ではない。

## 6. 相互理解を検査するデータ

### 6.1 送信側の明示的な伝達契約

隠れた思考過程を抜き出すのではなく、課題のために送信者が明示できる「何を相手に伝えるか」を保存する。対象、条件、主張の強さ、根拠、期待する次の行動、禁止事項など、今回の作業に必要な項目に限定する。

これは汎用言語全体の人手設計ではなく、検査のための局所的な契約である。項目が増える場合はその課題の必要性を記録する。

### 6.2 受信側の独立解釈

受信者には共通語の本文と、その時点で共有を許した文脈だけを見せる。受信者は、対象の選択、条件への回答、次の行動案、必要な追加質問を返す。元の期待条件を見せた後の説明を、独立した理解の証拠にしない。

### 6.3 検査結果のモデル

```typescript
type CheckResult = {
  checkId: string;
  targetMessageId: string;
  languageVersionId: string;
  dimension: 'transmission' | 'factuality' | 'authorisation' | 'task_outcome';
  verdict: 'pass' | 'fail' | 'inconclusive';
  scope: string;
  method: 'deterministic_test' | 'source_check' | 'human_review' | 'model_judgment';
  evidenceIds: string[];
  evaluatorVersion: string;
  limitation: string | null;
};
```

モデル採点は `model_judgment` として明示し、機械検査と同じ強さの証拠にしない。受信者が誤った送信内容を正しく受け取り、その後に反証した場合は「伝達pass／送信内容fail」として両方を保存できる。

### 6.4 最小課題の例

送信者だけが「対象Xは原因候補、未確定。変更は禁止。まず検査Tを行う」という課題記録を読む。受信者は共通語のメッセージから、対象、確実性、許される行動を答える。機械検査で三つを照合する。別に、検査Tの結果から実際にXが原因かを判定する。

続いて、否定、例外、時点、対象の同名衝突、資料の更新を変えた未見ケースで試す。この例の記号を製品の固定言語として採用しない。

## 7. TOMBO接続

### 7.1 参照する実装

確認基準は `nyattoh/tombo-view` の `585a1c711d55fdcc4b380343ceba2b3534165d5b`。特にREADMEと管理session手順を参照する。[S2] [S3] インストール済みスキルの古い手順と混ぜず、実装時は固定した版の型・ヘルパー・テストを一組で使う。

### 7.2 接続の責務

本アプリ独自のTomboBridgeを作り、次を変換する。

- 点検対象：送信契約、受信解釈、行動案、版、文脈の改訂番号。
- 目的：対象の伝達適合または内容確認。別命題は別claimにする。
- 資料：取得済みの本文、出典、取得日時、適用範囲、本文ハッシュ。
- 観測：実際の検査実行と結果。AIの感想を観測へ昇格させない。
- 出力：主張、未解決事項、次の検査、判断、人への質問、終了理由。

TOMBOの型へ新しいフィールドやstatusを無断で追加しない。共通語固有の情報はアプリ側の監査メタデータとして保持し、既存型に正しく写像する。

### 7.3 管理sessionの流れ

```text
固定されたtask作業領域
  -> statusで既存session確認
  -> 初回のみactivate
  -> prepare -> AIによる提案 -> inspect
  -> 許可された検査
  -> 追補をreceive
  -> prepare -> AIによる評価 -> update
  -> 必要なprepare / reflect
  -> report
```

同じ目的の追補・反例・人の回答を、新taskへ作り替えて予算や期限をリセットしない。`reflectionRequired: true`を使い、`needs_reflection`を完了と扱わない。管理モードの入出力フラグ、固定state出力先、予約ファイルの扱いは確認版の手順に従う。[S3]

実行IDは、同じ観測の再配送なら維持し、実際の再実行なら新しくする。不明な観測、取得不能な資料、予算不足でgapを閉じない。再考も網羅的な盲点発見の証明とはしない。

### 7.4 正本の分離

TOMBOの主張・証拠評価・利用量・停止状態の正本はTOMBOのledgerとする。本体保存先にはsession参照、revision、必要な要約を保存するが、SDKの状態を書き換えて整合させない。

本体保存先は配送・言語版・採用・作業管理の正本とする。両者の更新途中で停止した場合はpending連携イベントを残し、同じ実行IDを用いて再照合する。二つの保存先をまたぐ原子的更新は仮定しない。

### 7.5 改訂への戻し方

TOMBOが指摘したgapを、そのまま「言語の欠陥」としない。実検査で、表現不明、受信者の読み違い、資料不足、送信者の誤り、版不一致、権限不足、実行器障害を切り分ける。表現の問題と確認できた場合に、該当例と反例を改訂提案へ渡す。

## 8. 言語の状態機械と改訂

```text
DRAFT -> CANDIDATE -> TRIAL -> ACTIVE -> RETIRED
                   |         |
                   v         v
                REJECTED  QUARANTINED
```

- DRAFT：AIが作成中。通常の仕事には使わない。
- CANDIDATE：不変版として保存済み。試験対象。
- TRIAL：限定した参加者・範囲で試用中。
- ACTIVE：指定した範囲の採用条件を満たし、利用可能。
- REJECTED：試験で採用できない。根拠付きで残す。
- QUARANTINED：採用後に重大な不整合を確認。新規利用を止める。
- RETIRED：後継版等への移行で新規利用しない。過去の解読用には保持。

採用状態は言語全体の普遍的な保証ではなく、scopeと参加者の適合記録に結び付ける。新しいモデル、設定変更、コンテキストの導入方式の変更では、以前の適合結果を無条件に流用しない。

### 8.1 採用手順

AIが親版と変更理由を提出する。ホストが不変版として登録する。送信・受信の役を交替した試験、回帰、未見の組合せを行う。判定条件を満たした場合のみ、参加者ごとの適合結果を登録して採用する。

AIの賛成票だけでは採用しない。意味確認の結果が不明なら、候補のまま維持する。

### 8.2 版の切替

進行中のtaskはepochに固定した版を使う。切替時には旧区間への新規送信を止め、未処理メッセージを解決または明示的に持ち越す。各参加者の新しい版の取得と適合を確認し、expected revision付きで新epochを開始する。

MVPではtaskの区切りでのみ切替する。会話中の自由な熱更新は後続課題とする。旧版メッセージを新版で自動解釈しない。

### 8.3 分岐と復帰

用途別に別のheadを持てる。合流も新しい候補版として検査する。復帰は古いDB状態への巻戻しではなく、検査済みの過去版を次のepochで選ぶ操作とする。履歴・失敗・費用は削除しない。

## 9. 永続化

### 9.1 保存先

DB製品は未選択であり、SQLite、グラフ・ベクトルDB、クラウドPostgres等を言語構造と検索要求、運用条件に照らして選ぶ。通信路の内部保存先と本体の原発話・言語履歴・派生構造を分離する。ローカルDB採用時は実行中のDBを同期フォルダーやネットワーク共有へ直接配置しない。クラウド採用時の接続・外部送信範囲・費用は別途確認する。

SQLiteを採用する場合、WALは同一ホスト上で使い、同時書込みが一つであることと、SQLITE_BUSY等の競合を前提に設計する。複数DB全体を一括で原子的に更新できるとは仮定しない。[S10]

### 9.2 主要表

| 表 | 主要データ | 不変条件 |
|---|---|---|
| tasks | task_id、目的、成功条件、許可ポリシー、予算、開始・期限、状態、revision | 目的と許可の変更は履歴付き。再開で使用量をゼロにしない。 |
| participants | peer_id、接続参照、モデル・CLI・設定のfingerprint | 秘密情報を保存しない。 |
| task_participants | task_id、peer_id、役割、許可した資料範囲 | taskとpeerの複合一意制約。 |
| epochs | epoch_id、task_id、言語版、文脈revision、状態 | 一つのepochは一つの版へ固定。 |
| language_versions | version_id、digest、親版、scope、本文参照 | version_idとdigestを不変にする。 |
| language_heads | scope_id、active_version_id、revision | expected revisionによる比較更新。 |
| conformance | version_id、peer fingerprint、試験集合hash、結果、期限方針 | 自己申告と実試験を区別する。 |
| messages | message_id、送受信者、epoch、本文、digest | 同じIDで別本文を登録しない。 |
| outbox | message_id、配送先、試行数、配送状態 | messageと宛先の複合一意制約。 |
| inbox | message_id、recipient_id、受領・適用状態 | 同一受信先への重複適用を防ぐ。 |
| interpretations | message_id、receiver、独立回答、入力snapshot | 正解開示前後を識別する。 |
| checks | CheckResult、入力hash、実行ID、TOMBO参照 | 同じ実行結果の再配送を二重計上しない。 |
| evidence_refs | 出典、本文hash、取得日時、scope、閲覧権限 | 参照だけの登録を本文取得と扱わない。 |
| events | seq、event_id、task、kind、actor、時刻、内容 | 訂正・撤回を含め追記する。 |
| model_calls | invocation_id、予約、開始終了、結果、利用量 | 不明な利用量はnull。 |
| budget_reservations | task、呼出し予定、予約量、確定量、状態 | 並列起動前に予算を確保する。 |

これはホスト管理用の論理モデル案であり、発話本文の分解・検索構造を固定するものではない。配布用のDDLは採用製品と権限を確認し実装時にマイグレーションと共に作る。認証トークンを接続参照のJSONへ埋め込まない。

### 9.3 トランザクション

言語headの更新は、短いトランザクション内で `WHERE revision = expected_revision` によって競合を検出する。LLM生成や外部検査をDBトランザクションの中で待たない。

送信とoutbox登録、受信とinbox適用記録、予算予約と呼出し開始は、それぞれ同じDB内で原子的に更新する。競合の再試行は上限を設ける。上限に達した場合は失敗・保留とし、黙って破棄しない。

バックアップは稼働中DBファイル単体のコピーではなく、整合したsnapshotを取得する方式を採る。復元試験を機構試験に含める。

### 9.4 言語に応じた保存設計の自律見直し

ユーザー確定要件は、AIが育てる言語の構造と検索要求に合わせ、分解・テーブル・関係・索引をAI自身が設計・見直すことである。固定SVOや一般的な記憶・オントロジー進化へ置き換えない。現行構造へのデータ追加、索引だけの変更、構造変更を比較し、物理テーブルを毎回変更しない判断も認める。

以下は実装提案である。言語版、分解・取出し規則版、保存構造版を区別し、その組合せと独立検査の範囲を記録する。原発話・ハッシュ・作業・epoch・送受信者を保持し、派生単位から原文箇所と出来事・解釈・検査・行動記録へ辿れるようにする。発話が述べた内容と実際の出来事は区別する。言語版と保存版の対応は一対一と仮定しない。

候補には維持案、変更理由、問い合わせ例、写像、未知を添える。同じ言語版・原文・問い合わせ条件で比較し、保存→取出しによる意味条件の保持、検索の見落とし・誤取得、時間・容量・分解と再構成のモデル利用を評価する。原文復元、伝達の一致、主張の外部的な正しさ、操作許可を別判定にする。

移行案は原本を残した影の領域へコピーし、参照・制約・意味保持・未見問い合わせを独立検査する。基準revision後の差分を追随・照合し、必要な許可の下でexpected revision付きの参照切替を行う。途中停止はpendingとして扱う。切替後の書込みを失わずに旧構造へ再投影・逆変換できるか確認し、不明なら自動復帰可能としない。監査は候補構造から独立した追記履歴で保持する。任意の本番DDL・削除権限をAIへ与えない。

データ構造・検証・段階別実験の詳細は[追加仕様](07_LANGUAGE_STORAGE_ADDENDUM.md)を参照する。個人情報の削除方針と最小メタデータ保持は既存要件を維持する。

## 10. 一回の協働の処理

```text
Aが伝達契約を作る
  -> 採用版でメッセージを作る
  -> 封筒・許可・予算を検証
  -> outbox登録 / 配送
  -> Bが受信した版と文脈を確認
  -> Bが独立した解釈と行動案を返す
  -> TOMBOで不足・矛盾・検査候補を整理
  -> 許可した機械検査や資料確認
  -> 伝達 / 内容 / 許可を別判定
  -> 必要なら相互確認・表現改訂候補
  -> 許可された範囲だけを実行
  -> 実行結果を照合
  -> 利用者へ結果と未知を提示
```

理解に失敗しても、直ちに人間へ戻さず、予算内で相手に具体的な区別を確認する。目的・優先順位・許可が人にしか決められない場合は人へ尋ねる。反復で新しい情報が増えない場合は止める。

## 11. 障害・停止・再開

| 事象 | 処理 |
|---|---|
| 未知の表現 | 例または定義を求める。推測で実行しない。 |
| 言語版の欠落・digest不一致 | 解釈を止め、正しい不変版の取得へ戻す。 |
| 二者が矛盾する | 両説と根拠を保持し、検査可能性を確認する。 |
| 資料が古い・撤回された | 関連評価を無効化し、再検査を必要にする。 |
| CLI認証・枠・契約が不明 | 接続を保留する。自動的に有料APIへ切り替えない。 |
| プロバイダタイムアウト | 実行済みか不明なら `unknown_outcome`。安易に再実行しない。 |
| 配送後のホスト停止 | outbox/inboxを照合し、IDを維持して再配送・再適用防止。 |
| TOMBO保存先との不整合 | 正本を照合する。旧状態を直接書換えて修復しない。 |
| 予算・期限・連続無進展の上限 | 中間結果と未確認を保存して停止する。 |
| 利用者の取消 | 新規呼出しを止め、実行中処理の取消可否と未知の利用量を記録する。 |

外部システムへの変更は、理解検査の合格とは別の実行記録を持つ。MVPの実行先は合成課題・読取り・隔離したテストに限定する。

## 12. 評価データを漏らさない構成

公開の言語用例と、採点用の正解・隠しケースを別の保存域にする。エージェントが共有agmsg DBや全作業領域を自由に読める構成では、単に「正解を読まないで」とプロンプトに書くだけで隔離済みとはしない。

正式比較では、エージェント別の閲覧可能な入力をホストが書き出し、許可リストでツール読取りを制限する。採点データはエージェントに公開しない。必要なOS・sandbox隔離が検証できない場合は、漏洩耐性を未確認と記載し、厳密な盲検試験と呼ばない。

結果を見て改訂したケースは開発用へ移し、最終評価の未見ケースとして再利用しない。改善過程を観測するonline試験と、版を固定した最終比較を分ける。

## 13. 安全境界

言語パッケージ、相手からの本文、参照資料は命令権限を持たないデータとして扱う。`eval`、動的import、任意シェルの生成実行を共通語の意味処理に使わない。

実行器には事前許可した操作だけを登録する。宛先・資料範囲・プロバイダは利用者の設定から決まり、AIが共通語で新たな外部送信先を作れないようにする。人間向け説明へ戻せることと、第三者による監査可能性を残す。

本アプリのポリシーは、基盤サービスの利用規則を緩和しない。OAuth資格情報の別アプリへの流用や、使用制限回避を実装しない。

## 14. 一般利用者向けの画面案

最小画面は「目的・資料・接続・予算の選択」「現在の作業」「結果と要確認」の三つとする。作業画面では、言語の文字列そのものを大量表示せず、何を確かめているか、止まっている理由、残りの確認を自然言語で示す。

詳細表示には、送受信の原文、使用した言語版、伝達と内容の別判定、証拠、改訂の理由、新しいAIの適合結果、利用量の欠測を置く。「理解率100%」のような根拠のない総合ゲージは出さない。

最初のCLI実験と、一般利用者が導入できる完成品を区別する。ブラウザ画面を作るだけで導入容易性を達成したとしない。

## 15. 実装するディレクトリー案

```text
ai-common-language-lab/
  apps/cli/
  apps/local-ui/
  packages/core/
  packages/provider-adapters/
  packages/transport-adapters/
  packages/storage-planner/
  packages/language-registry/
  packages/tombo-bridge/
  packages/evaluator/
  packages/policy/
  tests/mechanism/
  tests/integration/
  evaluation/public-examples/
  evaluation/manifests/
  docs/
```

隠し評価の正解、実行ログ、DB、認証情報は公開リポジトリへ含めない。依存プロジェクトのライセンス確認前に、上流コードをコピーして再配布しない。

## 16. 実装順序と最小の判断実験

P0では、固定の合成メッセージを使い、版違い・再配送・未知・予算超過・TOMBOの未完了を正しく扱えるかを試す。保存・取出しの意味条件、版対応、影での移行・復帰も固定データで確認する。これは言語が育つことやAIの自律設計能力の実証ではない。

次に、既存枠が確認できたAI二者で、否定・不確実性・対象・時点の取り違えを含む小さな課題群を試す。自然言語＋TOMBOと比較し、共通語に変更することで何が改善・悪化したかを記録する。改善がなければ大型化せず、表現の問題、検査の問題、相手の推論能力の問題を切り分ける。

**最初に証明するのは「特殊な言語が生まれた」ことではなく、AIが提案した区別を相手が未見の場面でも使えたか、そして誤解の観測からその区別を改訂できたかである。**

---

外部の判断APIによる評価は行っていない（Jev API call: not made）。この文書の設計選択は、利用者要求と確認した一次資料をもとにした提案であり、実測結果ではない。

<!-- SOURCE_LINKS -->
[S1]: https://github.com/fujibee/agmsg/blob/e58bb3157d1e1be14924658a1ad9e1d2c665ff9b/README.md
[S2]: https://github.com/nyattoh/tombo-view/blob/585a1c711d55fdcc4b380343ceba2b3534165d5b/README.md
[S3]: https://github.com/nyattoh/tombo-view/blob/585a1c711d55fdcc4b380343ceba2b3534165d5b/skills/tombo-view/references/host-session.md
[S6]: https://developers.openai.com/codex/noninteractive/
[S7]: https://code.claude.com/docs/en/headless
[S8]: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
[S9]: https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code
[S10]: https://sqlite.org/wal.html
