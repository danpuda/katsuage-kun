# 😈 カツアゲくん (katsuage-kun)

> ChatGPT WebUIから出力をカツアゲして、WSLに自動保存するツール

## 🎯 何ができる？

1. **Tampermonkeyスクリプト** — ChatGPT WebUI上で動作し、AIの出力をリアルタイム監視
2. **Python Receiver** — WSL上でHTTPサーバーとして待ち受け、出力を自動保存
3. **Chrome Relay連携** — OpenClaw経由でファイル添付・プロンプト送信を自動化

```
ChatGPT WebUI ──(Tampermonkey)──▶ HTTP POST ──▶ WSL Receiver ──▶ ファイル保存
                                                                      │
OpenClaw ──(Chrome Relay/CDP)──▶ ChatGPT WebUI                       ▼
                                                              lobster-results/
```

## 📦 構成

| ファイル | 役割 |
|---------|------|
| `src/chatgpt-helper.user.js` | Tampermonkeyスクリプト（v7.2） |
| `src/receiver.py` | Python HTTPレシーバー（port 8854） |
| `src/receiver-watchdog.sh` | レシーバー死活監視 |

## 🚀 セットアップ

### 1. Tampermonkeyスクリプト
1. Chromeに[Tampermonkey](https://www.tampermonkey.net/)をインストール
2. `src/chatgpt-helper.user.js` をTampermonkeyに追加
3. ChatGPTを開くと自動で有効化

### 2. Python Receiver
```bash
cd src
python3 receiver.py
# → http://127.0.0.1:8854 で待ち受け開始
```

### 3. OpenClawからの自動送信（オプション）
GPT送信スキル（`gpt-browser-send`）でChrome Relay経由で自動投げ込み可能。
詳細: [docs/skill-integration.md](docs/skill-integration.md)

## 📊 バージョン履歴

| バージョン | 変更内容 |
|-----------|---------|
| v7.2 | GPT-5.4レビュー反映: キャッシュ活用(P1) + MutationObserver軽量化(P2) |
| v7.1 | renderPanelデバウンス + ボタンキャッシュ + ドラッグリスナー重複防止 |
| v7.0 | WebSocket→HTTP POST移行、ステータスパネル追加 |

## 🔮 将来構想: 自動開発ループ

```
要件定義 ──▶ GPT-5.4(設計+実装) ──▶ GitHub PR
                                        │
                                        ▼
                              Claude /code-review (自動)
                                        │
                               ┌────────┴────────┐
                               │                  │
                          問題あり              問題なし
                               │                  │
                               ▼                  ▼
                      GPT-5.4が修正        ロブ🦞に通知
                      → 再PR → 再レビュー      → マージ
```

## ライセンス

MIT
