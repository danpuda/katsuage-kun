# CLAUDE.md — カツアゲくん開発ガイドライン

## プロジェクト概要
ChatGPT WebUIの出力をTampermonkey経由でWSLに自動転送・保存するツール。

## コーディング規約
- JavaScript: ES2020+、strict mode不要（Tampermonkey環境）
- Python: 3.10+、型ヒント推奨、asyncio使用
- コメント: 日本語OK、変更理由を `// v7.x: 理由` 形式で記載

## アーキテクチャ
- `src/chatgpt-helper.user.js` — Tampermonkeyスクリプト（ブラウザ側）
  - MutationObserverでDOM変更を監視
  - 新しいassistantメッセージを検出→HTTP POSTでreceiverに送信
  - ステータスパネルをページ内に表示
- `src/receiver.py` — Python HTTPサーバー（WSL側、port 8854）
  - `/response` エンドポイントでテキスト受信
  - `/file` エンドポイントでファイル受信
  - 受信データをタイムスタンプ付きで保存

## パフォーマンス要件（重要）
- MutationObserverは `childList` + `subtree` のみ監視。`attributes` / `characterData` は禁止（CPU暴走防止）
- DOM探索（querySelector）はポーリング内で1回だけ実行し、結果をキャッシュ変数に保存
- `isGeneratingNow()` / `evaluateAndSend()` はキャッシュ値を使用。DOM直叩き禁止
- ログは200件上限。無限蓄積禁止
- setIntervalは15秒（POLL_MS）。500ms以下にするな

## テスト方法
1. ChatGPTで適当な質問を送信
2. receiverが起動していることを確認（`curl http://127.0.0.1:8854/status`）
3. 出力が `docs/gpt54-responses/` に保存されることを確認

## 既知の制約
- ChatGPTのDOM構造変更で動かなくなる可能性あり（セレクタ更新が必要）
- ファイルアップロードはWSLパス制約あり（`/tmp/openclaw/uploads/` 経由）
