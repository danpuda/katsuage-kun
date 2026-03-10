// ==UserScript==
// @name chatgpt-helper-v2
// @namespace local
// @version 2.3.0
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

 let prevBusy = false;
 let tickCount = 0;

 function normalize(text) {
   return String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
 }

 function isBusy() {
   // aria-label includes check (handles "ストリーミングの停止", "Stop streaming", etc.)
   const buttons = document.querySelectorAll('button[aria-label]');
   for (const btn of buttons) {
     const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
     if (aria.includes('stop') || aria.includes('停止')) {
       // Exclude model selector ("5.4 Thinking" contains no stop/停止 so safe)
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

 function getLabel() {
   const parts = location.pathname.split('/').filter(Boolean);
   return normalize(parts[parts.length - 1] || document.title || 'chatgpt');
 }

 function sendPayload(payload) {
   console.log('[v2] 🚀 SENDING:', payload.text.substring(0, 100));
   GM_xmlhttpRequest({
     method: 'POST',
     url: SERVER_URL,
     headers: { 'Content-Type': 'application/json', 'X-Rob-Token': TOKEN },
     data: JSON.stringify(payload),
     timeout: 30000,
     onload: (res) => console.log('[v2] ✅', res.status, res.responseText),
     ontimeout: () => console.error('[v2] ❌ TIMEOUT'),
     onerror: (err) => console.error('[v2] ❌ ERROR', err)
   });
 }

 function maybeSendCompletedMessage() {
   const nodes = getAssistantMessages();
   const node = nodes.length ? nodes[nodes.length - 1] : null;
   if (!node) return;
   const text = extractAssistantText(node);
   if (!text) return;
   sendPayload({
     text,
     label: getLabel(),
     source_url: location.href.split('#')[0],
     captured_at: new Date().toISOString()
   });
 }

 function tick() {
   const busy = isBusy();
   tickCount++;
   if (tickCount <= 3 || tickCount % 30 === 0) {
     console.log(`[v2] tick#${tickCount} busy=${busy} prev=${prevBusy}`);
   }
   if (busy && !prevBusy) console.log('[v2] 🟡 IDLE → BUSY');
   if (prevBusy && !busy) {
     console.log('[v2] 🟢 BUSY → IDLE — sending!');
     maybeSendCompletedMessage();
   }
   prevBusy = busy;
 }

 console.log('[v2] 🦞 v2.3.0 LOADED (stop button: aria includes check)');
 setInterval(tick, POLL_MS);
})();
