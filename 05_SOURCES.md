# AI共通言語育成基盤 — 根拠・出典・確認範囲

**確認日：2026-10-27（日本時間）**

本資料は、会話で確定した利用者要求、実際に取得した一次資料、今回の設計提案を分けて記述している。過去のアシスタント発言だけを実装済み機能や性能の根拠にしない。

## 1. 利用者要求

仕様書のU1〜U7は、同じ会話での本人の明示発言を出典とする。公開URLは存在しないため、外部情報に見せかけたURLを付けない。

最も重要な確定事項は、AI同士が共通言語を作ること、短さより正しい相互理解を優先すること、TOMBOを点検へ使うこと、言語を固定完成品ではなく育つものとして扱うことである。

追加のユーザー確定要件U7は、AIが育てる言語の構造と検索要求に応じ、分解・保存・取出しのテーブル・関係・索引までAIが自律的に設計・見直すこと。SVOは固定せず、構造維持の判断も含む。実装提案は[追加仕様](07_LANGUAGE_STORAGE_ADDENDUM.md)を参照する。DB製品は未選択で、SQLiteの出典確認は製品採用を意味しない。以下の外部資料の確認範囲は配布時の記録を保持しており、今回再取得したものではない。

## 2. 一次資料

### S1 — agmsg

- リポジトリ：https://github.com/fujibee/agmsg
- 確認したHEAD：`e58bb3157d1e1be14924658a1ad9e1d2c665ff9b`
- 参照用固定URL：https://github.com/fujibee/agmsg/blob/e58bb3157d1e1be14924658a1ad9e1d2c665ff9b/README.md
- 確認方法：GitHub接続でREADMEと最新commit情報を取得。
- 確認できたこと：ローカルSQLiteを介したCLIエージェント間の通信、受信内容をテキストとして見せる構成、Bash・sqlite3の依存、WindowsでのGit Bash経路の説明。
- この資料が示さないこと：共通言語の生成、意味理解の保証、本提案との接続済み状態、利用者PCでの実動作、すべてのサービスの契約上の利用可能性。

agmsgは通信層の例示であり採用必須ではない。採用する場合も上流DBに独自の意味管理テーブルを追加しない。

### S2 — TOMBO README

- リポジトリ：https://github.com/nyattoh/tombo-view
- 確認したHEAD：`585a1c711d55fdcc4b380343ceba2b3534165d5b`
- 参照用固定URL：https://github.com/nyattoh/tombo-view/blob/585a1c711d55fdcc4b380343ceba2b3534165d5b/README.md
- 確認方法：GitHub接続でREADMEと最新commit情報を取得。
- 確認できたこと：主張・証拠・未確認事項を分離する設計、TypeScript SDK・CLI・会話内スキル、ホストが実検査を行う境界、進行判定と操作許可の区別。
- 重要な限界：READMEは探索的な試作品として説明し、ライブモデルの品質改善は未実証としている。機構試験の成功を実モデルの相互理解改善へ読み替えない。

本提案の伝達適合検査、言語改訂へのフィードバック、版管理は新規機能として扱う。

### S3 — TOMBO管理session手順

- 固定URL：https://github.com/nyattoh/tombo-view/blob/585a1c711d55fdcc4b380343ceba2b3534165d5b/skills/tombo-view/references/host-session.md
- 確認方法：GitHub接続で上記commitのファイルを取得。
- 確認できたこと：固定cwd、status、初回activate、prepare／inspect、receive／update、再考、正本・cacheの役割、同じ目的での継続、時計・予算の保持。
- 設計への反映：古い会話内スキルの手順と混在させない。管理モードのフラグや保存先を、固定版の手順に合わせて実装する。
- 限界：本件についてSDKを起動して監査・接続試験したわけではない。

### S4 — Cache-to-Cache

- 論文：https://arxiv.org/abs/2510.03215
- 固定版：https://arxiv.org/abs/2510.03215v2
- 題名：Cache-to-Cache: Direct Semantic Communication Between Large Language Models
- 確認方法：arXivの書誌・要旨・版情報を取得。
- 確認できたこと：モデル間のKVキャッシュを投影・融合する通信方式の研究である。
- 本提案との関係：発想の参考。ただし本提案は公開された入出力の上に置くもので、C2Cの再現ではない。
- 採用しない推論：論文の速度・精度の数値を、本提案や商用サブスク間の通信の予測値にすること。

### S5 — CLSR

- arXiv：https://arxiv.org/abs/2606.29354
- 学会書誌：https://proceedings.mlr.press/v306/pei26a.html
- 題名：When LLMs Develop Languages: Symbolic Communication for Efficient Multi-Agent Reasoning
- 確認方法：arXivとPMLRの一次資料の検索結果から書誌・要旨を確認。PMLRページの直接取得は一度失敗したため、全文を精読したとは扱わない。
- 確認できたこと：複数のLLMが記号体系を作成・改良・共有し、正確性とトークン費用の関係を扱う研究が存在する。
- 本提案との関係：先行研究として比較対象。本提案では短さを目的にせず、意味伝達・根拠・不確実性・長期の版管理を重視する。
- 未確認：公開コードの最新構造、依存条件、追加APIなしの実験環境、商用サービス横断での性能。本書はコードの存在や移行先だけで実行可能性を保証しない。

### S6 — Codex非対話実行の公式資料

- 起点：https://developers.openai.com/codex/noninteractive/
- 取得時の遷移先：https://learn.chatgpt.com/docs/non-interactive-mode
- 確認方法：OpenAI公式ページからの遷移と本文を取得。
- 確認できたこと：`codex exec`、構造化出力、保存済み認証の利用、セッション再開に関する説明。
- 限界：個々のアカウントの権限・枠・料金経路・組織ポリシーはこのページだけでは確定しない。本アプリからの利用も実環境の確認が必要。

### S7 — Claude Codeプログラム実行の公式資料

- URL：https://code.claude.com/docs/en/headless
- 確認できたこと：`claude -p`、構造化出力、sessionを指定した再開、権限設定の説明。
- **実装時の注意**：取得した資料では`--bare`はサブスクのログイン情報を使わず、別の認証が必要と説明されている。起動が速いという理由で、既存サブスク前提のアダプターへ無条件に付けない。
- 限界：出力の費用値が実請求をそのまま示すとは限らない。利用枠・提供仕様の変更も再確認する。

### S8 — Claude Agent SDKと契約枠の公式案内

- URL：https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- 確認できたこと：取得したページ冒頭には、2026年6月15日付で予定変更を停止し、Agent SDK・`claude -p`等は従来の契約枠を使う旨の注記がある。下部の古い説明は、実施されていない旧予定として保存されている。
- 実装上の扱い：ページの旧予定だけを読んで現行の課金方法と断定しない。導入時点の表示と利用者の契約を確認する。
- 過去会話への訂正範囲：以前の回答にあった「2026年10月7日の案内」という日付は今回の取得資料では確認できないため、根拠として引き継がない。

### S9 — Claude Codeの認証環境変数

- URL：https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code
- 関連公式資料：https://code.claude.com/docs/en/authentication
- 確認できたこと：APIキー設定により、サブスクではなくAPI側の認証・請求経路が選ばれる場合への注意が示されている。
- 設計への反映：接続前に方式を確認し、秘密値を表示せず、意図しない追加従量課金へ切り替えない。

### S10 — SQLite WAL

- URL：https://sqlite.org/wal.html
- 確認できたこと：同一ホスト上で使う前提、同時writerは一つ、読取りと書込みの併存、ネットワークファイルシステムの制約、複数DB全体の原子性の限界。
- 設計への反映：ローカルDB、短いトランザクション、競合処理、agmsg・本体DB・TOMBO保存先間の再照合。

## 3. 過去会話から自動的に引き継がない情報

LatentMAS、Interlat、HyLaT等の各論文の詳細、採録状況、性能数値、過去に案内したコード移行先は、この仕様の実装要件に必要ないため今回再検証していない。依存や実証済みの根拠には含めない。

「共通語なら必ず速い」「TOMBOが意味一致を証明する」「普通のサブスクならどれでも自動接続できる」「AIが勝手に学習して重みが変わる」という主張は、本仕様の前提ではない。

先行研究の有無だけでは、本提案の独自性も否定も確定しない。研究として公開する前に、全文・実験条件・コード・類似方式を追加確認する。

## 4. 本資料で実施したこと・していないこと

実施したのは、会話の要求整理、一次資料の読取り、設計案・検証案の作成、配布文書の整合確認である。

本システムの実装、利用者PCの環境変更、GitHubへのpushやPR作成、商用AI二者の呼出し、TOMBO SDKによる本件検査、追加のEmbedding API、Jev APIの呼出しは行っていない。

Jev API call: not made
