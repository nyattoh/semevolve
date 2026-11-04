# 公開合成条件の Evaluator

`createEvaluator` は固定された構造化条件の検査器である。任意の自然言語を理解する採点器ではない。run の条件、採点器版、criteria digest、公開課題集合 digest を先に固定する。

host は `captureInput`、`recordAnswer`、`recordDisclosure` の順で入力と独立回答を commit する。入力 snapshot は task、言語版、message、receiver、payload、共有 context を含む。時計の自己申告で保存順を置き換えない。

`EvaluationRequest.inputDigest` は次の object の core `hostIdentity.digest` である。execution ID、期待条件、採点器版、criteria digest は完全 request の別の digest に含まれる。

```js
const input = {
  taskId, targetMessageId, languageVersionId, dimension,
  interpretation, evidence, scope,
};
```

四 dimension は別 execution で記録する。`transmission` は保存済み回答、`factuality` は許可された取得済み JSON 本文、`authorisation` と `task_outcome` は独立した host 観測を使う。条件は `{ kind: 'conditions-v1', checks: [{ path: ['nested', 'field'], equals: expectedValue }] }` とする。未知の形式は拒否する。主張への同意や伝達成功から別 dimension を推定しない。

保存検査の条件は `{ kind: 'storage-v1', meaning: [...checks], retrieval: { path: ['ids'], expected: ['record-a'] } }` とする。文字列・構造の復元、指定した意味条件、取得 ID 集合を別々に判定する。StorageCheckRequest の input digest は `{ taskId, original, retrieved, expectedConditions, scope }` に対応する。

予算 callback は既存 Policy の `snapshot`、`reserveAndStart`、`settle` へ接続する。callback 内で task を再登録しない。起動 claim と予約 ID は検査開始前に保存される。結果不明の実行は再起動せず pending に残す。費用と token の欠測は null のまま保持する。中断された host 観測が実際に停止したとは保証しない。

証拠撤回は元結果を削除しない。`readCheckEligibility` は完全 request と結果の対応、固定条件、撤回を再確認する。Registry adapter は新規適合の読取り境界として使う。既に ACTIVE の版への隔離通知と全操作経路の接続は後続の統合対象である。

既存 CheckExecution に criteriaDigest がない Low2 は未解決である。保存 request との対応による追跡は、共有型の修正完了を意味しない。

`createRoleBoundary` の許可リストは host 入力と tool の境界である。OS 隔離の証明にはならない。公開 synthetic canary の同一 OS principal による直読は別結果に記録し、隔離未達なら formal blind を拒否する。

repository root から `npm run test --workspace=@semevolve/evaluator` と `npm run test:consumers --workspace=@semevolve/evaluator` を実行する。公開 AT 台帳は全結合受入まで not_run を維持する。
