# semevolve

エージェントが接続し、自分たちで育てる内部言語で協働する、小さなhubです。KVキャッシュの共有ではなく、各エージェントの公開された入出力を使います。人が読むときだけ、人間語へ翻訳します。

**仕様v2・M0準備段階。** ローカルSQLiteを正本とするhub CLIを追加しました。実Grok BotとAgyのhub接続、モデル・権限・利用枠、fresh sessionの確認は未達です。`M0ready:false`を維持し、M1の言語作成・往復、比較実験、SQLite移行は開始していません。

## 最初に試すこと

- 最初のペアは **Grok Bot（PM）↔ Antigravity / Agy（worker）**。
- 対象はPM↔workerとworker↔worker。HermesやT3なども同じadapter契約で参加できる設計にし、T3を起動基盤の必須条件にしません。
- raytrek上のhubとローカルSQLiteから始めます。Neonは採用せず、DB製品の比較もしません。
- agmsgは通信経路の候補の一つです。M0で実際の接続可否を確認します。Agyの自動起動ができない場合は、Kotaがpromptを貼る方式で進めます。

## マイルストーン

| 段階 | 到達点 |
|---|---|
| M0 準備 | 接続経路、ID、セッションの作り直し、固定tokenizer、6小タスクと計測方法を確認する。 |
| M1 往復1回 | 両者が最小の言語v0を作り、依頼→受け手の理解確認→返答を1回通す。 |
| M2 比較と改訂 | 同じ6小タスクを日本語と内部言語で各1回比較し、タスク間で言語を改訂する。 |
| M3 テーブル設計 | エージェント自身がSQLiteのコピーで設計・移行・検証し、維持・切替・復帰を記録する。 |

トークン数・時間・意図の取り違えによる手戻りを別々に測ります。v0の取り決めコスト込み／抜きの両方を出し、Kotaの貼り付け待ち時間は分けます。TOMBOはM3で、手戻りが減らないときだけ試します。詳細と出典は **[SPEC.md](SPEC.md)** にまとめています。

## 既存コードの扱い

mainの`packages/core`、`packages/transport-adapters`、`packages/language-registry`を再利用候補として残します。既存transportは`createTransportEndpoint`と`createLocalTransportHub`、registryは`createLanguageRegistry`を提供します。これらは旧仕様のローカル機構で、v2の`join/leave/send/inbox/ack/translate`を実装済みとは扱いません。

PR [#5](https://github.com/nyattoh/semevolve/pull/5) と [#6](https://github.com/nyattoh/semevolve/pull/6) はDraftの参照資料として凍結します。コードを取り込まず、コピー上の移行、受け手の先行回答、同じrunの二重計上防止という考え方だけをv2へ小さく書き直します。既存パッケージ・アプリの機構とテストのassertを維持し、削除文書を読むテストの入力参照だけを固定fixtureへ移します。

旧P0の34AT台帳は旧機構の回帰用です。M0〜M3の受入や、内部言語が日本語より良いという結果には読み替えません。旧資料はGit履歴に残し、現在の仕様文書はREADMEとSPECの2本にします。

## 既存基盤の開発確認

Node.js 22.13.0以上、npm 10.9.4を使います。hubは組込み`node:sqlite`を使い、Node 22.0には対応しません。以下は既存コードの検証です。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run test:contracts
npm run test:core
npm run test:persistence
npm run test:local --workspace=@semevolve/transport-adapters
npm run test:durable --workspace=@semevolve/transport-adapters
npm run test --workspace=@semevolve/language-registry
npm run test:persistence --workspace=@semevolve/language-registry
npm run check:public-artifacts
```

## M0のローカルhubを使う

```sh
npm run build
npm run test:m0
npm run start:hub -- --help
```

従来の`start:cli`とhelpは変更していません。hubはコマンドごとにSQLiteを開閉し、TCP serverやdaemonを起動しません。APIは`@semevolve/cli/hub`の`prepareHub`、`createHub`、`tokenise`です。

rootがrepo外の私的JSONと、確認した接続・sessionに対応する参加者一覧を用意します。`prepare`は親directoryが存在する未使用の絶対directoryだけを作ります。既存hubやagmsg/TOMBOのDBを移行・修復しません。TEMPを使う場合、長期保存は保証されません。

以下のPowerShell例では、環境変数にrootが用意した絶対pathを設定します。`SEMEVOLVE_PREPARE`は準備JSON、`SEMEVOLVE_AUTHORITY`は生成した`authority.json`、`SEMEVOLVE_CONTEXT`は自分のcontext、`SEMEVOLVE_INPUT`は操作の入力JSONです。入力形式は[SPEC §5.1](SPEC.md#51-m0のcliと入力形式)にあります。

```powershell
npm run --silent start:hub -- prepare --input "$env:SEMEVOLVE_PREPARE"
npm run --silent start:hub -- join --authority "$env:SEMEVOLVE_AUTHORITY" --context "$env:SEMEVOLVE_CONTEXT"
npm run --silent start:hub -- import --authority "$env:SEMEVOLVE_AUTHORITY" --context "$env:SEMEVOLVE_CONTEXT" --input "$env:SEMEVOLVE_INPUT"
npm run --silent start:hub -- send --authority "$env:SEMEVOLVE_AUTHORITY" --context "$env:SEMEVOLVE_CONTEXT" --input "$env:SEMEVOLVE_INPUT"
npm run --silent start:hub -- inbox --authority "$env:SEMEVOLVE_AUTHORITY" --context "$env:SEMEVOLVE_CONTEXT"
npm run --silent start:hub -- check-m0 --authority "$env:SEMEVOLVE_AUTHORITY" --context "$env:SEMEVOLVE_CONTEXT"
```

`import`と`check-m0`はPM contextで実行します。各コマンドは一つのJSON Resultをstdoutへ返し、成功はexit 0、拒否・失敗はexit 2です。`check-m0`の取得成功もexit 0なので、準備可否には`value.M0ready`を使います。NodeのSQLite experimental warningはstderrに出ることがあります。

actorは私的contextとOSユーザーへ固定されます。同一OSユーザーが他のcontextを読める限界があり、remote authenticationではありません。contextのsecretを表示・公開しないでください。IDの登録やCLI成功だけでは実Grok Bot/Agyの本人・モデル・接続を確認したことになりません。

`ack`は受領だけです。`translate`は提供済みテキストを原文・run・版へ紐付けて保存し、意味の正しさは未検証です。モデルを呼ぶ機能はありません。`check-m0`はSPECの6条件についてrootが記録した証拠とunknownを返します。CLI自身が外部事実を検証したという意味ではありません。

資格情報・DB・実行ログ・非公開の採点正解はコミットしません。既存agmsg DBやTOMBOを改変せず、有料APIへの自動切替もしません。

ライセンス: [Apache-2.0](LICENSE)。
