# semevolve 仕様v2

2026-10-29のKotaのdecision29を基準にした仕様です。2026-10-30、decision30〜32の範囲でM0のローカルhub CLIを追加しました。旧01・02・07の目的・通信・版管理・保存設計を、本書のM0〜M3へ整理し直しました。旧P0/J2/Iの計画は今後の実行指示にしません。

## 1. 目的と境界

semevolveは、どのエージェントもadapter経由で参加できるhubです。Grok Bot、Hermes、Antigravity / Agy、T3などの特定の一つをhubの実行基盤として前提にしません。最初の実接続はGrok BotをPM、Agyをworkerとします。PM↔workerとworker↔workerの依頼・理解確認・訂正・結果を扱います。

エージェント間の通常のやり取りには、エージェント自身が提案・改訂する内部言語を使います。人間が完成した略号辞書や固定SVOを押し付けません。内部言語は文字列等の公開入出力で運び、モデルのKVキャッシュや重みは共有・更新しません。初回のv0取り決めには共有済みの人間語を使えます。その後の人間語表示は、人が読むための翻訳として分けます。M2の日本語条件は比較用の明示的な例外です。

hubはraytrek上で小さく動かし、永続保存はローカルSQLiteだけを使います。Neonの採用やDB製品比較は行いません。大きなUI、汎用オーケストレーター、全エージェントの自動起動、モデル再学習を初期の必須条件にしません。

M0のローカル機構と実エージェント接続の受入を分けます。2026-10-31のdecision43の実行報告をhubの保存結果と照合し、実Grok Bot/Agyのcanary往復・両受領ack、六課題のhash、再open後のM0準備条件を確認しました。decision40／42の例外を含むoperator判定は`M0ready:true`です。比較実験の独立性は未達で、M1/M2の前に再判断します。これはコードPRのmerge受入や実験開始の許可ではありません。M1以降の実験・移行は実行していません。

## 2. hubとadapter

hubは参加者・メッセージ・言語版・run・計測を保持します。参加者が使うCLIやサービスとの接続はadapterに寄せ、T3固有のthread IDやdelegate機能を共通契約にしません。

| 契約 | 最小の意味 |
|---|---|
| `join` | `grok-bot@raytrek`形式のID、役割、接続能力、使える言語版を登録する。同一IDの別接続との衝突を黙って上書きしない。 |
| `leave` | 参加終了を記録する。未処理メッセージを削除したり、終了を成功応答と見なしたりしない。 |
| `send` | 宛先、message ID、run ID、言語版、本文を渡す。再配送では同じIDと本文を保つ。 |
| `inbox` | 自分宛の未ackメッセージを取得する。読取りだけで消費済みにせず、重複受信を許容する。 |
| `ack` | 当該受信者の受領を記録する。理解・タスク完了・評価合格とは別である。 |
| `translate` | 人が読む要求に応じて内部言語を人間語へ翻訳する。元の本文・言語版・runと翻訳を対応付け、元本文を置き換えない。 |

これらはv2で実装する契約であり、既存パッケージや上流ツールの同名APIを主張するものではありません。IDはエージェント名とホスト名を区別します。ID文字列の自己申告だけを認証にせず、接続時に確かめた送受信者へ結び付けます。具体的な起動方法と到達性はM0で確認します。

agmsgは候補経路の一つです。利用する場合も、既存agmsg DBへ独自テーブルやSQLを追加しません。導入版のサポートされた入口をadapterから使います。Agyを自動起動できなければ、hubが出したpromptをKotaが新しいAgyセッションへ貼り、返答を取り込む方式を用います。自動接続済みと偽らず、この経路でも同じrun IDを維持します。

worker↔workerでは別のworkerセッションを別IDで登録します。PMの依頼範囲を引き継ぎ、worker間のメッセージだけで権限や送信先を増やしません。M0では最初のPM↔worker経路に加え、この経路をどう試すかを記録します。

## 3. 一往復と理解確認

1. 送信側が、目的・制約・期待する結果を、そのrunの固定言語版で送る。
2. 受け手は**送信側の答え合わせや訂正より前に**、受け取った意図の言い直し、最初に行う一手の予測、不明点を返す。通常条件ではこれも内部言語で返し、人向けの翻訳は別にする。
3. 送信側が意図との食い違いを確認し、別々の食い違いをそれぞれ1件として記録する。単なる「分かった」という返答だけでは理解確認済みにしない。
4. 必要な訂正と再確認を行い、許可された範囲の作業と結果を記録する。未確認・失敗も残す。

理解が合っても、主張が真実であることや操作が許可されたことの証明にはなりません。受領ackと理解回答と作業結果は分けます。言語本文や翻訳を任意コード・シェル命令として実行しません。

言語定義は内容を上書きしない版として保持します。各runは使用版を記録し、進行中は変更しません。改訂はタスクとタスクの間だけで行い、旧メッセージは送信時の版で読みます。「今回は変更しない」も有効な判断です。

## 4. runと二重計上防止

一つのタスク・条件の実行に一つのrun IDを割り当てます。配送の再試行、ack、貼り直し、同じ結果の再取込みでは新しいrunを作りません。同一message IDの本文が違う場合は衝突として拒否し、元の記録を保ちます。

受信者単位の適用済みmessage IDと、run内の計測・食い違いevent IDをSQLiteに保持し、再配送を重複加算しません。異なる食い違いは別eventとして数えます。実際に新しいセッションでやり直す場合は新runにし、再実行であることを明示します。元の失敗を成功runへ置き換えず、計画した比較と追加実行を分けます。

言語の定義、原メッセージ、理解回答、訂正、結果、翻訳、使用モデル・セッション・版・計測の出所を追える最小の記録を残します。欠測は不明とし、トークンや時間をゼロで埋めません。

## 5. M0 — 準備

次を確認・固定してから比較を始めます。

- Grok Bot PMとAgy workerの実際の接続方法、ID、権限と利用枠。agmsg経路の可否、自動起動か貼り付けか。
- 各条件で毎回新しいセッションを開始し、前の条件の会話や結果を渡さない方法。実際に隔離できない範囲は明記する。
- tokenizerの名前・版・設定と、どの送受信テキストを数えるか。提供者ごとの課金token数とは区別する。
- 小タスク6つの入力・成功条件・意図確認項目、PM↔worker／worker↔workerの割当て、使用モデルと設定、打切り条件。
- v0の取り決め、タスク実行、改訂、人向け翻訳、貼り付け待ちを分けて記録できること。
- SQLite保存先と、実行ログ・資格情報・非公開の正解を公開リポへ入れないこと。

6小タスクの候補は、制約付きの依頼、否定・例外、対象と版の識別、不確実性の保持、worker間の依存の受渡し、訂正を受けた作業の再計画です。M0で具体的な6入力と期待結果を確定し、試験開始後に有利な課題へ差し替えません。これは普遍的な能力試験ではなく、小さな協働の比較です。

### 5.1 M0のCLIと入力形式

Node 22.13.0以上とnpm 10.9.4を使います。22.13.0の公式binaryでフラグなしSQLite APIを確認しています。Node 22.0にはSQLiteがありません。CIの22 latestと24は実versionを出力し、latestの結果を最小版の結果と読み替えません。

`npm run start:hub -- <command>`を使います。通常の操作には`--authority <絶対path>`と`--context <絶対path>`を渡します。JSON入力は`--input <絶対path>`で読み、本文をシェルとして実行しません。成功は`{ok:true,value:...}`とexit 0、失敗は`{ok:false,error:{code,message}}`とexit 2です。

| command | 入力JSON |
|---|---|
| `prepare` | `{directory,participants}`。authority/contextの指定は不要。新directoryはrepo外、親は作成済みとする。 |
| `join` | 任意の`{id,connectionRef,sessionRef}`。省略時はcontextの値。同じcontextと異なる値は拒否。 |
| `leave` / `inbox` | 入力不要。inboxは任意の`{recipientId}`を受けるが自分以外は拒否。 |
| `send` | `{id,runId,languageVersion,recipients,body,kind}`。senderはcontextから固定。 |
| `ack` | `{messageId}`。当該recipientだけが受領を記録。 |
| `translate` | 保存は`{id,sourceMessageId,runId,languageVersion,targetLanguage,text,sourceRef}`。取得は`{sourceMessageId}`。 |
| `import` | PMのみ。`[{kind,value}]`。kindは`language`、`run`、`fixture`。batch全体をtransactionにする。 |
| `inspect` | 入力不要。自分のidentity、関係するrunと原文、自分のdeliveryを返す。private fixtureはPMだけに返す。 |
| `record` | 下記Measurementを一件保存。 |
| `measurements` | `{runIds:[...]}`。同runと参照するformation runを重複なく集計。他actorの本文・出所は伏せる。 |
| `record-readiness` | PMのみ。下記の証拠記録を保存。 |
| `check-m0` | PMのみ、入力不要。六条件の証拠・unknownと`M0ready`を返す。取得成功とreadyを分ける。 |
| `tokenise` | `{text}`。authority/context不要。固定tokenizerの配列と件数を返す。 |

`Participant`は`{id,role,connectionRef,sessionRef,capabilities,languageVersions}`。roleは`pm`または`worker`、後二者は文字列配列です。初期の論理IDは`grok-bot@raytrek`と`agy@raytrek`です。別workerを加える場合はrootが別ID・connection・sessionを確認して新規準備します。`prepare`は既存directoryを変更せず、登録後のcontext追加・接続の乗換えは提供しません。

`prepare`の成功値にはDB、authority、actor別contextのpathが入ります。authorityは同directoryの新規`hub.sqlite`へ固定し、contextはdatabase ID、actor、connection、session、OS bindingとランダムsecretを持ちます。DBにはsecretのhashを保存します。未知schema、別authorityのcontext、別actor/sessionは拒否します。ファイルのOS access controlを信頼するローカル境界であり、同一OSユーザーからの秘匿やremote authenticationは提供しません。

`Language`は`{id,definition,sourceRef}`。`Run`は`{id,taskId,condition,languageVersion,actors,modelSettings,rerunOf,formationRunId}`です。conditionは`canary`、`japanese`、`internal`、`formation`。未知の設定・参照はnullable欄に`null`を使います。保存したrunは`status:'prepared'`となり、実行は開始しません。定義・run・原文は不変で、同じIDの異なる内容を拒否します。sendのkindは`canary`、`language_introduction`、`request`、`understanding`、`correction`、`result`です。

`Fixture`は`{id,input,successCriteria,intentChecks,roles,modelSettings,limits}`。successCriteriaとintentChecksは文字列配列、rolesは`{sender,recipients}`、limitsは`{processingSeconds,correctionRounds}`です。inputHash、successCriteriaHash、fixtureHashをSHA256で計算して保存します。fixtureHashはhash欄を除く正規化JSONに対して計算します。任意の申告hashを渡した場合は一致を検査します。非公開の六課題・正解はrootが私的JSONで入力し、公開testは別の合成canaryを使います。

### 5.2 M0の計測と証拠

固定tokenizerはMITの`gpt-tokenizer@4.1.0`、`cl100k_base`です。Nodeの正式CommonJS exportを`createRequire`で読み、encodeの存在と整数配列の戻り値を実行時に検査します。依存型宣言のTextDecoder互換性のためにこの境界を設け、strict、`skipLibCheck:false`、既存tsconfigを維持します。DOM追加・global型上書き・依存コードのpatchは行いません。

原文を正規化せず、特殊token表記も通常テキストとしてencodeします。chat overheadやprovider課金tokenを混ぜません。`Hello, world!`は`[9906,11,1917,0]`、`日本語`は`[9080,22656,45918,252]`です。言語導入・再導入、依頼、先行回答、訂正、結果の送信outputと各受信inputを別occurrenceで記録します。配送再試行だけでは加算せず、実際の再入力には新occurrenceを使います。

Measurementの入力は`{runId,eventId,occurrenceId,messageId,recipientId,phase,direction,category,text,textRef,providerUsage,startedAt,endedAt,actualCost,sourceRef}`です。messageId、recipientId、text、textRef、providerUsage、両時刻、actualCostは欠測時に`null`。時刻はUTC ISO文字列、directionは`input/output/none`、phaseは`v0_formation/task/revision/human_translation/paste_waiting`です。categoryはsendのkindに加え`mismatch/translation/waiting`を使えます。再導入はtask phaseの`language_introduction`として数えます。

providerUsageは`{inputTokens,outputTokens,totalTokens}`の各値を整数またはnullで保持します。actualCostは`{amount,currency}`またはnullです。固定token数、provider usage、費用は別項目です。inputのmessageIdを指定した記録では、recipientの適用記録と計測を同じtransactionで保存します。これは計測取込みの適用であり、外部副作用のexactly-once、理解、成功を意味しません。

`measurements`はphaseごとの件数・token数・区間union・食い違い数を返します。欠測を含む合計はnullで、空phaseもtoken/時間をゼロに埋めません。経過時間は区間のunion、貼り付け待ちを除く処理時間はその区間差です。比較用のtaskとrevisionにformation runを一度だけ加算した値と、除外した値を返します。翻訳と貼り付け待ちは別phaseに残します。

証拠記録は`{id,condition,facts,evidenceRefs,fixtureIds,sourceRef,observedAt}`です。conditionは`connection/sessions/tokenizer/fixtures/phases/storage`、factsは各確認項目の文字列またはnull、evidenceRefsは私的証拠の参照配列です。`check-m0`が返すfactsのnull欄を、実観測が得られた項目だけ埋めます。同IDは不変で、追加確認は新IDで保存します。各conditionの最後に追加された証拠を使い、過去の記録は保持します。

fixtures条件のfixtureIdsは固定する六件です。各fixtureのmodelSettingsはactor IDごとに`{model,settings,permissions,quota,sourceRef}`を持たせます。設定・利用枠がunknownならnullを残し、readyにしません。tokenizer条件は名前・版・encoding・特殊token設定の固定値とも照合します。

2026-10-31のdecision40により、Grok Botのモデル非開示をM0の明示的な例外とします。実モデル名を推定せず、model欄には「非開示・decision40承認例外」と記録し、アプリ名、確認済みのエージェントID、取得できる設定を私的な証拠と課題設定へ固定します。モデル間の同等性や基盤モデルの固定を確認したとは扱いません。Grok Botの新規セッションはKotaが手動で開く新規チャットを使い、自動作成を必須にしません。前条件の会話・結果を入力しない手順と、実際に確認できた独立性・隔離の限界は引き続き記録します。利用枠は確認できたプラン・時点・使用状況と数値不明を分け、プラン変更後は実験前に再確認します。

同日のdecision42により、新規チャットを開けないGrok Botについては、既存チャットを接続・保存・計測の準備確認に使うことをM0限定の例外として認めます。履歴が見える状態を独立したセッションとして記録しません。比較実験の独立性は未達のまま保持し、M1/M2の開始前にKotaが改めて判断します。この例外はM1の開始許可や比較条件の免除を意味しません。

`check-m0`の`assessment:'operator_evidence_only'`は、rootの観測記録に基づく判定であることを示します。証拠が欠ければunknownを維持します。実接続やモデルをCLIの自己申告から推定せず、実Grok Bot/Agyの到達性、fresh session、権限・利用枠の確認はrootが担当します。合成testのready結果を本番のM0受入に転用しません。

## 6. M1 — 往復1回

両エージェントが最小のv0を取り決め、Grok Bot PMからAgy workerへの依頼と、受け手の先行回答・結果を一往復通します。人が求めた翻訳を元本文と照合できるようにします。自動起動と手動貼り付けのどちらを使ったかを残します。

v0の形成に使った時間・テキストと、その一往復の使用量を分けます。M1の練習をM2の12実行の一つとして数えず、M2の条件には新しいセッションを使います。M1が動いても、日本語より良いという結論にはしません。

## 7. M2 — 比較と改訂

同じ6小タスクを、日本語と内部言語で**各1回、計12実行**します。タスク1は日本語→内部言語、タスク2は内部言語→日本語とし、以降も先行条件を交互にします。各実行でPM・workerのセッションを新しくします。必要な言語定義の再導入は行えますが、そのトークン・時間も記録します。

各タスクの二条件は同じ入力・権限・成功条件・理解確認手順・モデル設定で実行します。日本語条件で受け手の先行回答を省くなど、基準条件を弱くしません。両条件が終わった区切りでのみ言語を改訂し、次タスクの前に版を固定します。M2中の改訂コストも隠しません。

| 指標 | 数え方 |
|---|---|
| トークン数 | M0で固定したtokenizerで、依頼・言語導入・受け手の先行回答・訂正・結果など、実際に対象となった入出力を数える。本文だけの短さに絞らない。 |
| 時間 | 開始から終了までを記録し、エージェント／hub処理の経過と、人の貼り付け待ち時間を分けて出す。重なった時間を単純加算しない。 |
| 手戻り回数 | 意図の食い違い1件を1回とする。該当message、確認項目、訂正eventを残し、同じeventの再取込みは増やさない。 |
| 結果と欠測 | 成功・失敗・未完、打切り理由、取得できなかった値を全12実行について残す。失敗条件を除外して比較しない。 |

各指標はタスク別・条件別と合計を報告します。v0の形成を一度分の別項目にし、同じrunの形成費用を6回加算しません。内部言語の実行合計について、`v0形成費用を除いた値`と`その合計に一度分のv0形成費用を加えた値`を両方出します。日本語側にも準備費用があれば別に記録します。改訂・再導入費用はv0除外に紛れ込ませず、該当区間へ含めます。貼り付け待ちと、人向け翻訳の使用量・時間も別項目で示します。

トークン・時間・手戻りを一つの総合点にせず、改善と悪化をそのまま出します。各1回の小規模比較なので、統計的優位や一般的な有効性を断定しません。改訂に使った失敗例は、未見の検証に数え直しません。

## 8. M3 — エージェント自身のテーブル設計

実際の内部言語と問い合わせから、エージェント自身がSQLite上の表・関係・索引・分解方法を設計し直します。人間が固定SVOへ落とし込む実装にはしません。現在の構造を維持する案を必ず含め、構造を変えない判断も記録します。旧PR #5から使うのは、原本を保ったコピー上で移行を検証する考え方だけです。

1. 言語版、対象データ、現行構造、問い合わせと検証条件を固定し、整合したSQLiteコピーを作る。稼働中のDB本体ファイルだけを雑にコピーしない。
2. エージェントがコピー上で候補を作り、元のmessage・run・言語版への対応を保ってデータを移行する。元DBや既存agmsg DBを直接DDLの試行先にしない。
3. 原文と必要な意味、参照、一意性、取得結果を確認する。行数やテーブル数の増減だけを成功条件にしない。候補と維持案の時間・使用量も分ける。
4. 切替直前に書込みを止めて差分を取り込み、検証したコピーが最新データを含むことを確認する。対応できなければ元の構造を継続する。
5. 検証できた場合に切替し、不合格・不明なら採用しない。途中停止は成功と推測せず、旧新どちらが正本かを記録して照合する。
6. 復帰する場合も、切替後の書込みを失わず移せることを確認してから戻す。確認できなければ自動で戻さず、両方を保持して止める。候補・判断・検証・切替／復帰・維持の理由を記録する。

言語と表構造を同時に変えて効果を混同しないよう、保存候補の比較中は言語版を固定します。候補のSQLを受け取っただけで本体へ実行することはありません。

TOMBOは**M3で、手戻りが減らないときだけ**試します。M0〜M2の依存にせず、TOMBOを入れた後も手戻り・時間・使用量を別に記録します。SDKの機構や二者の合意を、理解改善の証明とは扱いません。既存TOMBOのDBや内部コードを改変しません。

## 9. 実装・運用を軽く保つ

既存mainのcore、transport-adapters、language-registryを残し、必要な部分だけ再利用します。transportのmutable collections、宛先に結び付いたadapter、受領と適用の区別、registryの不変版・task区間固定など、既存APIの条件はそのままです。既存コードの詳細は型と実装を参照し、v2への対応済みとはしません。

旧PR #6からは受け手が先に答える手順とrunの二重計上防止だけを小さく書き直します。旧PR #5/#6をmerge・cherry-pickせず、Draftの参照資料として凍結します。旧34ATの対応表は既存契約テストの固定データへ移し、テストのassertを保持します。v2の比較結果を旧台帳へ埋めません。

言語・メッセージの理解と、外部操作の許可は分離します。秘密・DB・実行ログ・非公開の正解をコミットせず、接続先・利用枠が不明な場合に有料APIへ自動切替しません。上流コードはライセンス未確認でコピーしません。配布ライセンスはApache-2.0です。

変更は小さなDraft PRで扱い、各PRでBugbotを実際に実行します。別ベンダーレビューは軽くし、コードPRのmerge前に1回、最大2往復までとします。blockするのは正しさ・安全・データ消失です。docs PRは最小限で確認します。ただしCodexまたはBugbotの新しいfindingが出たら、その場で止めてGrok Bot経由でKotaへ判断を返します。Ready化、merge、mainへのpush、force pushはKotaの明示指示なしに行いません。

## 10. 出典と確認範囲

v2の目的・初期ペア・指標・6小タスク各1回・SQLite限定・M0〜M3は、2026-10-29のKotaのdecision29を根拠にします。外部論文から推測した要件ではありません。

旧05_SOURCESとREADING.htmlを確認し、次の関連参照を引き継ぎました。**2026-10-27の旧資料で確認した範囲の参考で、今回リンク先を再取得したり、接続・性能を検証したものではありません。**

- [agmsgの固定版README](https://github.com/fujibee/agmsg/blob/e58bb3157d1e1be14924658a1ad9e1d2c665ff9b/README.md)：SQLiteを用いたエージェント通信の参考。v2の接続可否はM0で確認し、上流の表を改変しません。
- [SQLite WAL](https://sqlite.org/wal.html)：同一ホストでの保存・競合・整合性を検討するための一次資料。M3の安全なコピーや切替が実装済みであるという根拠ではありません。
- [Cache-to-Cacheの固定版](https://arxiv.org/abs/2510.03215v2)：KVキャッシュを使う通信研究という発想上の参考。semevolveはその再現でも、その速度・精度の達成でもありません。
- [CLSRのarXiv書誌](https://arxiv.org/abs/2606.29354)と[PMLR書誌](https://proceedings.mlr.press/v306/pei26a.html)：LLMの記号通信・効率を扱う先行研究の参照。旧確認は書誌・要旨の範囲で、全文や公開コードの精読・実行は主張しません。
- [TOMBOの固定版README](https://github.com/nyattoh/tombo-view/blob/585a1c711d55fdcc4b380343ceba2b3534165d5b/README.md)と[同版の管理session手順](https://github.com/nyattoh/tombo-view/blob/585a1c711d55fdcc4b380343ceba2b3534165d5b/skills/tombo-view/references/host-session.md)：M3で条件付きに試す場合の参照。意味理解や品質向上を保証する資料として使いません。

旧資料のCodex・Claude専用起動方法や契約説明は、初期ペアの接続条件として引き継ぎません。必要になったadapterの実環境・契約はM0以降に確認します。旧HTMLの「agmsgを通信層に採用する」という記述や、TOMBO必須・DB未選定・P0先行という旧方針も、現在の要件にはしません。
