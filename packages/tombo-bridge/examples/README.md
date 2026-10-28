# 固定 SDK の管理 session 接続

bridge は TOMBO の実管理結果を読み、本体 pending と SDK 正本を照合する。対象 SDK は `nyattoh/tombo-view` の commit `585a1c711d55fdcc4b380343ceba2b3534165d5b`、上流 licence は MIT である。上流 source と ledger はこの repository に含めない。

`createManagedSession` には runtime、専用 TEMP task directory、許可した TEMP root、固定 task と時計、取得証拠の metadata、host が作る合成 proposal を明示する。既存利用者 session や暗黙の TOMBO_ROOT を選ばない。helper は絶対 path と配列引数で起動し、資格情報や NODE_OPTIONS を引き継がない。

`createTomboBridge` の `receive` は本体 pending を先に保存する。`PendingTomboUpdate.payload` は正規化済みの SDK receipt とする。

```js
const payload = {
  id: executionId,
  source: { kind: 'tool', locator: 'public-synthetic-test' },
  references: [],
  observations: [observation],
};
```

一つの payload は同じ execution ID の一観測を持つ。inputDigest はこの payload の core JSON digest である。receipt の payloadHash と observation の payloadHash は対象が異なるため、それぞれ照合する。証拠の contentHash は本文 UTF-8 の SHA-256 であり JSON digest ではない。

`reconcile` は session、revision、receipt 本文、適用済み execution、両 hash、評価待ち、会計不確定を確認する。receipt や revision の増加だけでは完了へ進めない。返す canReportCompletion は実 helper の値であり、optional gap が残る場合の true も保持する。操作許可や製品の完成を意味しない。

同じ ID と内容の再配送は保存結果を返す。結果不明の application claim を時間だけで奪わない。SDK の残存 lock は削除・奪取しない。本体側の死んだ owner は core の明示 token 照合で回復し、SDK の正本と別に扱う。

実 SDK 試験は repository root から `npm run test:sdk --workspace=@semevolve/tombo-bridge` を実行する。npm 10.9.4 を使用する。この script は固定 source artifact を専用 TEMP runtime へ取得し、LICENSE、helper、lock、設定、source tree の hash を確認して `npm ci --ignore-scripts` と build を実行する。runtime の環境変数は試験の子 process にだけ渡す。runtime 不足を skip 成功にしない。

host が確認済み runtime を供給する場合は `SEMEVOLVE_TOMBO_RUNTIME` で渡す。私的 path は source に記載しない。Git archive と GitHub artifact の archive hash は同一とは仮定せず、固定 source entry の hash を比較する。

試験はネットワーク推論を使わない。SDK の合成 proposal 適用回数と外部モデル呼出し回数を区別し、費用 null を実費ゼロの証拠にしない。厳格な金額 cap が必須の task は helper の見積り不能を保持し、cap を削除して接続しない。
