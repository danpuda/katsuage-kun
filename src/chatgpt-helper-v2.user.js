// ==UserScript==
// @name chatgpt-helper-v2
// @namespace local
// @version 2.7.0
// @description Capture completed ChatGPT assistant messages
// @match https://chatgpt.com/*
// @match https://chat.openai.com/*
// @grant GM_xmlhttpRequest
// @connect 127.0.0.1
// @connect localhost
// ==/UserScript==

(() => {
 'use strict';

 const SERVER_URL = 'http://127.0.0.1:8854/response';
 const TOKEN = 'scholar-v4-rob';
 const POLL_MS = 1000;
 const QUEUE_KEY = 'katsuage-retry-queue';
 const MAX_QUEUE = 20;
 const RETRY_MS = 10000; // retry every 10s

 let prevBusy = false;
 let tickCount = 0;
 let idleConfirmCount = 0;
 const IDLE_CONFIRM_TICKS = 2; // 1 extra tick after transition (1s at POLL_MS=1000)

 function normalize(text) {
   return String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
 }

 function isBusy() {
   // Strategy: look for the stop button near the chat input form
   // Selector 1: data-testid (most stable, ChatGPT uses this)
   const byTestId = document.querySelector('button[data-testid="stop-button"]');
   if (byTestId) return true;
   // Selector 2: aria-label exact patterns (fallback)
   // Restrict to form area only — [role="presentation"] is too broad
   const form = document.querySelector('form');
   if (!form) return false;
   const buttons = form.querySelectorAll('button[aria-label]');
   for (const btn of buttons) {
     const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
     if (aria === 'stop streaming' || aria === 'stop' ||
         aria === 'ストリーミングの停止' || aria === '停止') {
       return true;
     }
   }
   return false;
 }

 function getAssistantMessages() {
   return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
 }

 function extractAssistantText(node) {
   if (!node) return '';
   const content = node.querySelector('[data-message-content]') || node;
   return normalize(content.innerText || content.textContent || '');
 }

 function detectFiles(node) {
   if (!node) return [];
   const buttons = node.querySelectorAll('button.behavior-btn');
   const files = [];
   for (const btn of buttons) {
     const t = (btn.textContent || '').trim();
     const parent = btn.parentElement;
     const isFileBtn = parent && parent.tagName === 'SPAN' && parent.dataset.state === 'closed';
     if (!isFileBtn) continue;
     // Pattern 1: "filename をダウンロード" (single file)
     if (t.includes('をダウンロード')) {
       files.push(t.replace(' をダウンロード', ''));
     // Pattern 2: "Download filename" (English)
     } else if (t.toLowerCase().startsWith('download ')) {
       files.push(t.substring(9));
     // Pattern 3: Just filename with extension (multiple files)
     } else if (/\.\w{1,10}$/.test(t) && !t.includes(' ')) {
       files.push(t);
     }
   }
   if (files.length) console.log('[v2] 📎 Files detected:', files);
   return files;
 }

 function getLabel() {
   const parts = location.pathname.split('/').filter(Boolean);
   return normalize(parts[parts.length - 1] || document.title || 'chatgpt');
 }

 // --- Retry Queue (Bug #3 fix) ---
 function getQueue() {
   try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
   catch { return []; }
 }
 function saveQueue(q) {
   localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
 }
 function enqueue(payload) {
   const q = getQueue();
   q.push({ payload, retries: 0, enqueuedAt: Date.now() });
   if (q.length > MAX_QUEUE) q.shift();
   saveQueue(q);
   console.log('[v2] 📦 Queued for retry. Queue size:', q.length);
 }
 let isSending = false; // prevent overlapping sends (RETRY_MS < timeout)
 function processQueue() {
   if (isSending) return;
   const q = getQueue();
   if (!q.length) return;
   isSending = true;
   const item = q[0];
   doSend(item.payload, () => {
     isSending = false;
     q.shift();
     saveQueue(q);
     console.log('[v2] ✅ Retry success! Remaining:', q.length);
     if (q.length) setTimeout(processQueue, 1000); // drain next
   }, () => {
     isSending = false;
     item.retries++;
     if (item.retries >= 10) {
       q.shift();
       console.error('[v2] ❌ Dropped after 10 retries:', item.payload.label);
     }
     saveQueue(q);
   });
 }

 function doSend(payload, onOk, onFail) {
   GM_xmlhttpRequest({
     method: 'POST',
     url: SERVER_URL,
     headers: { 'Content-Type': 'application/json', 'X-Rob-Token': TOKEN },
     data: JSON.stringify(payload),
     timeout: 30000,
     onload: (res) => {
       console.log('[v2] ✅', res.status, res.responseText);
       if (onOk) onOk();
     },
     ontimeout: () => { console.error('[v2] ❌ TIMEOUT'); if (onFail) onFail(); },
     onerror: (err) => { console.error('[v2] ❌ ERROR', err); if (onFail) onFail(); }
   });
 }

 function sendPayload(payload) {
   console.log('[v2] 🚀 SENDING:', payload.text.substring(0, 100));
   doSend(payload, null, () => enqueue(payload));
 }

 function maybeSendCompletedMessage() {
   const nodes = getAssistantMessages();
   const node = nodes.length ? nodes[nodes.length - 1] : null;
   if (!node) return;
   const text = extractAssistantText(node);
   if (!text) return;
   const files = detectFiles(node);
   const payload = {
     text,
     label: getLabel(),
     source_url: location.href.split('#')[0],
     captured_at: new Date().toISOString()
   };
   if (files.length) {
     payload.has_file = true;
     payload.file_names = files;
   }
   sendPayload(payload);
 }

 function tick() {
   const busy = isBusy();
   tickCount++;
   if (tickCount <= 3 || tickCount % 30 === 0) {
     console.log(`[v2] tick#${tickCount} busy=${busy} prev=${prevBusy}`);
   }
   if (busy && !prevBusy) {
     console.log('[v2] 🟡 IDLE → BUSY');
     idleConfirmCount = 0;
   }
   if (prevBusy && !busy) {
     idleConfirmCount = 1;
     console.log('[v2] 🟡 BUSY → maybe IDLE (confirming...)');
   } else if (!busy && idleConfirmCount > 0) {
     idleConfirmCount++;
     if (idleConfirmCount >= IDLE_CONFIRM_TICKS) {
       console.log('[v2] 🟢 IDLE confirmed — sending!');
       maybeSendCompletedMessage();
       idleConfirmCount = 0;
     }
   }
   prevBusy = busy;
 }

 console.log('[v2] 🦞 v2.7.0 LOADED (retry queue + isBusy hardened + idle confirm + multi-file)');
 setInterval(tick, POLL_MS);
 setInterval(processQueue, RETRY_MS);
})();
