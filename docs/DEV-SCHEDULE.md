# カツアゲくん v2 — 開発予定表

> 作成: 2026-03-09 22:20 JST

## Phase 1: レビュー（ロブ🦞がやる、やまちゃん不要）
- [ ] katsuage-kunリポにv2コード+ドキュメントをpush
- [ ] PR作成 → @claude レビュー依頼
- [ ] Codex CLI 5.4 でクロスレビュー
- [ ] レビュー指摘を修正（Codex CLIで）

## Phase 2: テスト（Tampermonkeyインストールはやまちゃん）
- [ ] Receiver v2 起動テスト
- [ ] やまちゃんにTampermonkey v2インストール依頼（旧v7.5.x無効化）
- [ ] 通常回答テスト × 10
- [ ] Thinking回答テスト × 10
- [ ] 短文テスト × 10
- [ ] 長文テスト × 10
- [ ] 通知到達確認

## Phase 3: パイプライン統合
- [ ] repomix → DragEvent → GPT送信 → v2キャプチャ → 一気通貫テスト
- [ ] cron 10分監視スクリプト作成（Elvis式）
- [ ] @claude自動トリガー設定（PAT or cron gh pr comment）

## Phase 4: 安定化
- [ ] 3日間の実運用で問題なし確認
- [ ] エラー統計（成功率95%+を確認）
- [ ] v1コード無効化・アーカイブ
