# Bug #3: 送信失敗時のlocalStorage再送キュー設計

## 問題
receiverダウン中（最大5分）のGPT回答がPOST失敗→データロスト。
onerrorでconsole.errorだけ。再送なし。

## 設計

### localStorage キュー
```js
const QUEUE_KEY = 'katsuage-retry-queue';
const MAX_QUEUE = 20;
const RETRY_INTERVAL_MS = 10000; // 10秒ごとにリトライ

function enqueue(payload) {
  const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  queue.push({ payload, retries: 0, enqueuedAt: Date.now() });
  if (queue.length > MAX_QUEUE) queue.shift(); // 古いのを捨てる
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  console.log('[v2] 📦 Queued for retry:', queue.length);
}

function processQueue() {
  const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  if (!queue.length) return;
  const item = queue[0]; // FIFO
  sendPayload(item.payload, {
    onSuccess: () => {
      queue.shift();
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      console.log('[v2] ✅ Retry success, remaining:', queue.length);
    },
    onFail: () => {
      item.retries++;
      if (item.retries >= 10) {
        queue.shift(); // 10回失敗→諦め
        console.error('[v2] ❌ Dropped after 10 retries');
      }
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    }
  });
}
```

### 変更点
1. `sendPayload()` の `onerror`/`ontimeout` で `enqueue(payload)`
2. `setInterval(processQueue, RETRY_INTERVAL_MS)` を追加
3. キュー残数をconsole.logに出す（サイレント失敗防止）

### リスク
- localStorageの容量制限（5MB）→ 20件上限で十分
- ページリロードでもキュー残る → 重複送信リスク → labelで重複チェック
- receiver復旧後に一気に来る → receiverはシングルスレッドだが1件ずつなのでOK

### テスト方法
1. receiverを停止
2. GPTで質問→回答完了
3. console: `📦 Queued for retry` 確認
4. receiverを起動
5. 10秒以内に `✅ Retry success` 確認
