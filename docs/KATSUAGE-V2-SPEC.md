# カツアゲくん v2 — 最終要件定義 + パイプライン設計

> 作成: 2026-03-09 22:16 JST
> 設計: GPT-5.4 Thinking（やまちゃん🗻と対話して決定）
> レビュー予定: @claude (GitHub PR) + Codex CLI 5.4

---

## 🎯 ゴール（一言）

**ロブ🦞がGPT WebUIにコードを投げて、完了した回答を自動で受け取って、Gitに積んでレビューを回す。**

---

## 📐 要件定義

### Tampermonkey v2 (chatgpt-helper-v2.user.js)

**目的:** ChatGPT回答完了が確定した瞬間だけ、最後のassistantメッセージ本文を取得し、ローカルreceiverに1回POST。

**完了検知:**
- 1秒間隔のsetIntervalでStop/Thinkingボタンの有無をチェック
- `prevBusy=true → isBusy()=false` の遷移 = 完了確定
- MutationObserver不使用。推測なし。確定シグナルのみ

**テキスト取得:**
- `[data-message-author-role="assistant"]` の最後の要素
- `[data-message-content]` 配下優先、なければinnerText
- ベタ貼り出力のみ対応。Canvas/ダウンロードファイルは対象外

**送信:**
- `POST http://127.0.0.1:8854/response`
- JSON: { text, label, source_url, captured_at }
- X-Rob-Token認証

**禁止事項:**
- MutationObserver
- fingerprint / cooldown / throttle / debounce
- 時間ベース完了推測（lastMutationAt等）
- Canvas / sandbox / 添付ファイル回収
- self-heal / status panel / toast

### Receiver v2 (receiver_v2.py)

**目的:** Tampermonkeyから本文JSONを受け取り、ファイル保存し、ロブ🦞に通知。

**処理:**
- POST /response のみ受付
- origin / token検証
- YYYYMMDD-HHMMSS-label ディレクトリに response.md + meta.json 保存
- 同秒衝突は連番サフィックス
- `openclaw system event --mode now` でロブ🦞に通知

**禁止事項:**
- /file エンドポイント
- fingerprint index / dedupe
- Canvas / sandbox 保存
- Git commit連携（receiverの責務外）

---

## 🔄 最終パイプライン（v3）

### フェーズA: 初版生成（GPT WebUI使用）
```
やまちゃん「やって」
  ↓
ロブ🦞 → repomix でリポ→1ファイル化（5秒）
  ↓
ロブ🦞 → GPT送信スキル（DragEvent）→ ChatGPT WebUI に送信
  ↓
GPT-5.4 → 回答（設計 / コード生成 / 要件定義）
  ↓
カツアゲくん v2 → 完了検知（busy→not busy）→ receiver保存
  ↓
Receiver v2 → ファイル保存 → ロブ🦞に通知
  ↓
ロブ🦞 → git commit + push + gh pr create
  ↓
フェーズBへ
```

### フェーズB: 修正ループ（CLI + GitHub完結、WebUI不要）
```
@claude → 自動レビュー（claude.yml、月額$0）
  ↓
レビュー結果をロブ🦞が読む
  ↓
Codex CLI 5.4 → 修正コード生成 → git commit + push
  ↓
@claude → 再レビュー
  ↓
SHIPまでループ → マージ → やまちゃん🗻に完了通知
```

### cron監視（Elvis式）
```
*/10 * * * * check-agents.sh
  - PRのCI状態を gh cli で確認
  - @claudeレビュー結果を確認
  - 必要ならロブ🦞に通知
```

---

## 📊 v1との比較

| | v1 | v2 |
|---|---|---|
| Tampermonkey | 1650行 | ~100行 |
| Receiver | 692行 | ~190行 |
| 完了検知 | MutationObserver+polling+idle推測 | busy→not busy遷移のみ |
| 有効率 | 55% | 目標: 95%+ |
| 通知 | 0%（PATHバグ） | openclaw フルパス |
| Canvas対応 | あり（バグの元凶） | なし（割り切り） |

---

## 🔑 設計判断の根拠

1. **ベタ貼り上限は非公開** — Canvas切替は行数閾値ではなくUI依存（GPT-5.4確認）
2. **Canvas/DLは割り切り** — v1の複雑化原因。検出したらフラグだけ残す
3. **行数制限は撤廃** — 本質は「禁止事項を守った必要十分実装」
4. **Elvis式参考** — tmux+cron+GitHub完結で$190/月（出典: dailykoin.com/ai-agent-swarm/）
5. **Codex CLI 5.4動作確認済み** — 修正ループはCLIで完結

---

## テスト基準（10回連続成功）

### Tampermonkey v2
- [ ] 通常回答 10回連続成功
- [ ] Thinking回答 10回連続成功
- [ ] 短文回答 10回連続成功
- [ ] 長文回答 10回連続成功
- [ ] 途中生成中の誤送信 0件
- [ ] 二重送信 0件

### Receiver v2
- [ ] 正常JSON 10件連続保存成功
- [ ] 空body → 400
- [ ] 不正JSON → 400
- [ ] 空text → 400
- [ ] 同秒2件 → 上書きなし
- [ ] 通知が毎回1回だけ
