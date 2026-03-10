# カツアゲくん v2.5.0 バグハントメモ

対象:
- `src/chatgpt-helper-v2.user.js`
- `src/receiver_v2.py`
- `scripts/receiver-watchdog.sh`

前提:
- ここに書くものは「現時点でかなり起きそうな不具合・エッジケース」の洗い出し。
- 特に `docs/KATSUAGE-V2-SPEC.md` の「静かに壊れない」「10回連続成功」の観点で見ている。

## 1. 1秒ポーリングの隙間で短文回答を取り逃がす

該当:
- `src/chatgpt-helper-v2.user.js:18`
- `src/chatgpt-helper-v2.user.js:113`

再現手順:
1. かなり短い質問を投げる。
2. 高速回線や軽いモデルで、`Stop` ボタンが 1 秒未満だけ出て消える状況を作る。
3. `busy=true` を一度も観測できず、`prevBusy && !busy` が成立しない。
4. POST が飛ばない。

影響:
- 短文だけ静かに保存漏れする。
- 成功率を測るまで気づきにくい。

修正案:
- `busy -> idle` だけでなく、「最後の assistant メッセージが前回送信分から変化した」ことも補助条件にする。
- もしくは `POLL_MS` を縮める。
- 最低でも「一定時間 assistant メッセージが増えているのに一度も送信していない」警告を出す。

## 2. `aria-label` 依存の busy 判定が DOM 変更で全損する

該当:
- `src/chatgpt-helper-v2.user.js:27`

再現手順:
1. ChatGPT 側が停止ボタンの `aria-label` を `Cancel response` や別文言に変える。
2. あるいはアイコンのみ表示にして `aria-label` を外す。
3. `isBusy()` が常に `false` になる。
4. 以後の回答が一切保存されない。

影響:
- UI 更新 1 回でキャプチャ機能が全面停止する。
- 受信サーバーや watchdog は正常に見えるので、故障が見えにくい。

修正案:
- `aria-label` 文字列のみに依存しない。
- composer 周辺のより安定した属性、`data-testid`、ストリーミング中だけ出るコントロールなど複数シグナルを併用する。
- 「最後の N 回で一度も busy を観測できていない」異常ログを出す。

## 3. 別機能の「Stop」ボタンを誤検知して誤送信する

該当:
- `src/chatgpt-helper-v2.user.js:29`

再現手順:
1. 回答後に読み上げ、音声、別ウィジェットなど `aria-label` に `stop` を含むボタンを表示させる。
2. `isBusy()` が回答生成中ではないのに `true` になる。
3. そのボタンが消えた瞬間に `prevBusy && !busy` が成立する。
4. 古い assistant メッセージを再送する。

影響:
- 二重送信、遅延送信、別会話の誤送信が起こる。
- 保存自体は成功するので、後から見るまで壊れたことに気づきにくい。

修正案:
- 停止ボタン探索をページ全体ではなく、チャット composer / 生成コントロール領域に限定する。
- 「今回の busy セッション中に assistant 本文が変化したか」を送信条件に加える。

## 4. busy が一瞬 false になるだけで途中結果を送ってしまう

該当:
- `src/chatgpt-helper-v2.user.js:120`

再現手順:
1. Thinking やツール呼び出しを含む長めの回答を生成する。
2. UI 上で停止ボタンが一瞬消えて、すぐ再表示されるパターンを作る。
3. 最初の `busy -> idle` で `maybeSendCompletedMessage()` が走る。
4. 後半の本文が続いたあと、さらにもう一度送られる。

影響:
- 途中版と完成版の二重保存になる。
- Telegram 通知も二重化しやすい。

修正案:
- `idle` が 2〜3 ポーリング連続で続いたら送る。
- 送信直前に本文長が 2 回連続で安定していることを確認する。

## 5. busy 終了と DOM 更新の競合で末尾が欠ける

該当:
- `src/chatgpt-helper-v2.user.js:93`
- `src/chatgpt-helper-v2.user.js:120`

再現手順:
1. 重い端末や長文回答で、DOM 反映が遅い状況を作る。
2. 停止ボタンが先に消える。
3. 次の `tick()` で本文を読むと、最後の数行やコードブロック末尾がまだ DOM に出ていない。
4. 欠けた本文を保存する。

影響:
- 保存ファイルは一見正常に見えるが、内容が不完全になる。
- 後工程のレビューや再利用で事故る。

修正案:
- `busy -> idle` 後に 1 フレームまたは短い待機を入れて再読込する。
- 直近 2 回の抽出本文が一致したときだけ確定送信する。

## 6. 添付ファイル検知が DOM と文言に強く依存している

該当:
- `src/chatgpt-helper-v2.user.js:50`

再現手順:
1. ChatGPT 側が `button.behavior-btn` を別 class に変える。
2. または親要素が `span[data-state="closed"]` ではない構造に変わる。
3. あるいは `Download filename` ではなくリンクやチップ表現になる。
4. `has_file` / `file_names` が付かなくなる。

影響:
- 本文保存は成功しても、「添付あり」フラグだけ静かに落ちる。
- 後で「ファイル付き回答を拾う」運用が壊れる。

修正案:
- class 名よりも `download` 属性、添付リンク、ファイル chip の共通構造を見に行く。
- DOM パターンを複数許容する。
- 検知不能だった場合は `has_file_unknown` などの監視用フラグを残す。

## 7. ファイル名に空白や複雑な拡張子があると見落とす

該当:
- `src/chatgpt-helper-v2.user.js:66`

再現手順:
1. `my report.csv` や `archive.tar.gz` のようなファイル名を返させる。
2. Pattern 3 の正規表現 `\.\w{1,10}$` と `!t.includes(' ')` に引っかからない。
3. 他パターンにも合わなければ検知漏れする。

影響:
- 複数ファイル回答で一部だけ見落とす。
- 日本語名や空白入りファイル名で再現しやすい。

修正案:
- ファイル名判定を文言ベースから卒業し、ダウンロード要素の属性値や URL から抽出する。
- 空白や複数ドットを許容する。

## 8. `innerText` ベース抽出で UI のゴミを本文に混ぜやすい

該当:
- `src/chatgpt-helper-v2.user.js:44`

再現手順:
1. 引用、コピー、折りたたみ、脚注、ボタン付きの回答を開く。
2. `content.innerText` に本文以外のラベルが混ざる。
3. `response.md` に UI 文言まで保存される。

影響:
- 保存物がノイジーになり、差分比較や再投入に向かなくなる。
- 「見た目は正常だが中身が汚い」タイプの静かな故障。

修正案:
- 本文ノードを block 単位で歩いて、`button` や補助 UI を除外して組み立てる。
- 少なくとも `button`, `nav`, `aria-hidden="true"` などは除外対象にする。

## 9. 中途半端な HTTP ボディで受信サーバーが永久に詰まる

該当:
- `src/receiver_v2.py:30`
- `src/receiver_v2.py:239`

再現手順:
1. `nc 127.0.0.1 8854` などで接続する。
2. `Content-Length: 1000000` を付けて一部だけ送信し、接続をぶら下げる。
3. `handler.rfile.read(length)` が待ち続ける。
4. `HTTPServer` が単一スレッドなので、後続リクエストも止まる。

影響:
- ポートは開いているのに実質停止する。
- watchdog は `lsof` だけ見るので復旧しない。

修正案:
- ソケット read timeout を設定する。
- `ThreadingHTTPServer` に切り替える。
- 途中で切れた body を 408/400 扱いにする。

## 10. 単一スレッドサーバーなので 1 本の遅いリクエストで全体が止まる

該当:
- `src/receiver_v2.py:8`
- `src/receiver_v2.py:239`

再現手順:
1. 大きめのリクエストを極端に遅い速度で送る。
2. その間に Tampermonkey から通常の POST を飛ばす。
3. 後者が待たされ、Tampermonkey 側でタイムアウトする。

影響:
- 同時利用や異常クライアントに弱い。
- 受信失敗はブラウザ console にしか出ないので、運用で見逃しやすい。

修正案:
- `ThreadingHTTPServer` か WSGI/ASGI サーバーに変える。
- リクエスト処理の timeout を入れる。

## 11. `file_names` の型未検証で「保存したのに 500」を起こせる

該当:
- `src/receiver_v2.py:191`
- `src/receiver_v2.py:233`

再現手順:
1. `has_file: true` と一緒に `file_names: 123` のような不正 JSON を送る。
2. `response.md` と `meta.json` の保存までは通る。
3. `notify_rob()` 内の `', '.join(file_names)` で例外が出る。
4. クライアントには 500 が返る。

影響:
- 保存済みなのに失敗扱いになる。
- 将来クライアント側に retry を入れると重複保存の原因になる。

修正案:
- `file_names` は `list[str]` であることを受信直後に検証する。
- 通知失敗は保存成功と分離し、レスポンスを 200 のまま返せるようにする。

## 12. 2 段階保存が非 atomic で、クラッシュ時に中途半端な bundle が残る

該当:
- `src/receiver_v2.py:199`
- `src/receiver_v2.py:211`

再現手順:
1. ディスクフル、I/O エラー、`SIGKILL` を `response.md` 保存後〜`meta.json` 保存前に起こす。
2. `docs/gpt54-responses/...` に片肺 bundle が残る。
3. 後工程が `meta.json` 前提だと取りこぼす。

影響:
- データ欠損や不整合が残る。
- ディレクトリだけ存在するので、人間には「保存されていそう」に見える。

修正案:
- 一時ファイルに書いて `os.replace()` で atomic rename する。
- `fsync` と完了マーカーを入れる。
- 不完全 bundle を起動時に検出・警告する。

## 13. トークンが固定値で、Origin なしならローカル偽装が簡単

該当:
- `src/chatgpt-helper-v2.user.js:17`
- `src/receiver_v2.py:15`
- `src/receiver_v2.py:142`

再現手順:
1. ローカル端末上で `curl` を実行する。
2. `X-Rob-Token: scholar-v4-rob` を付けて `POST http://127.0.0.1:8854/response` を送る。
3. `Origin` を付けなければ `_check_origin()` を素通りする。
4. 任意の本文が保存・通知される。

影響:
- 同一マシン上の別プロセスから簡単に偽データ注入できる。
- ディスク埋め、通知スパム、ログ汚染が可能。

修正案:
- トークンをソース固定値にしないで、ランダム生成した secret を環境変数やローカル設定から読む。
- `Origin` 必須化、または Unix socket / localhost のランダムポート化を検討する。

## 14. 通知失敗が完全に握り潰される

該当:
- `src/receiver_v2.py:103`
- `src/receiver_v2.py:112`

再現手順:
1. `OPENCLAW_PATH` を壊す、binary を消す、Telegram 側を失敗させる。
2. `subprocess.Popen(...)` で失敗しても `except Exception: pass` で握り潰される。
3. 保存だけ成功し、通知不達に誰も気づかない。

影響:
- 運用上いちばん痛い「静かな故障」になりやすい。
- watchdog も通知経路までは監視していない。

修正案:
- 失敗をログに残す。
- `meta.json` に `notify_status` を残す。
- 連続失敗時は watchdog か別 cron で検知する。

## 15. watchdog は「ポートが開いているか」しか見ていない

該当:
- `scripts/receiver-watchdog.sh:9`
- `scripts/receiver-watchdog.sh:20`

再現手順:
1. 8854 番ポートを別プロセスで奪う。
2. または `receiver_v2.py` をハング状態にする。
3. `lsof -i :8854` は成功するので watchdog が `exit 0` する。
4. 本物の receiver は死んだままでも復旧しない。

影響:
- 監視が「生きているふり」を見抜けない。
- 本番ではこれが最も見つけにくい。

修正案:
- `curl` で `OPTIONS /response` やヘルス用エンドポイントを叩き、期待レスポンスを確認する。
- PID のコマンドラインが `receiver_v2.py` かどうかも確認する。

## 16. watchdog 自体に排他がなく、二重起動レースがある

該当:
- `scripts/receiver-watchdog.sh:9`
- `scripts/receiver-watchdog.sh:16`

再現手順:
1. 手動実行と cron 実行を同時刻に重ねる。
2. 両方が `lsof` 前後の隙間で「落ちている」と判断する。
3. 両方が `nohup python3 ... &` を実行する。
4. 片方は bind 失敗、PID ファイルは後勝ちで上書きされる。

影響:
- ログが汚れ、PID 管理が壊れる。
- 復旧判定も不安定になる。

修正案:
- `flock` で watchdog 全体を排他する。
- 起動後は PID だけでなく HTTP ヘルスチェックで確認する。

## 17. 5分監視 + クライアント無再送で、落ちている間の回答は全部失われる

該当:
- `src/chatgpt-helper-v2.user.js:81`
- `scripts/receiver-watchdog.sh:3`

再現手順:
1. receiver を落とす。
2. 次の cron 復旧までの 5 分以内に ChatGPT 回答を完了させる。
3. Tampermonkey 側は `onerror` / `ontimeout` を出すだけで再送しない。
4. その回答は永遠に失われる。

影響:
- ダウンタイム中の回答が丸ごと欠損する。
- 通知もファイルも残らないため、後から復元しにくい。

修正案:
- userscript 側にローカル再送キューを持たせる。
- 監視周期を短くするか、`systemd --restart=always` に寄せる。
- 失敗 POST をブラウザ内で明示する。

## 優先度メモ

優先度高:
1. `isBusy()` の brittle さによる全面停止
2. 1秒ポーリングによる短文取り逃がし
3. partial body / 単一スレッドによる受信ハング
4. watchdog の「ポートだけ監視」
5. 保存成功後 500 を返しうる schema 未検証

優先度中:
1. 添付ファイル検知の brittle さ
2. DOM 更新競合による末尾欠け
3. 通知失敗の握り潰し
4. 5 分監視によるダウンタイム時のデータ欠損

