// ==UserScript==
// @name chatgpt-helper-v2
// @namespace local
// @version 2.1.0
// @description Capture completed ChatGPT assistant messages and send them to a local receiver
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

 function normalize(text) {
 return String(text || '').replace(/\r/g, '').replace(/\u00a0/g, ' ').trim();
 }

 function getButtons() {
 return Array.from(document.querySelectorAll('button,[role="button"]'));
 }

 function getButtonText(el) {
 const label = el.getAttribute('aria-label') || '';
 const text = el.textContent || '';
 return normalize(`${label} ${text}`).toLowerCase();
 }

 function hasStopButton() {
 return getButtons().some((el) => {
 const s = getButtonText(el);
 return s.includes('stop') || s.includes('停止') || s.includes('stop generating') || s.includes('stop streaming');
 });
 }

 function hasThinkingButton() {
 return getButtons().some((el) => {
 const s = getButtonText(el);
 return s.includes('thinking') || s.includes('思考中');
 });
 }

 function isBusy() {
 return hasStopButton() || hasThinkingButton();
 }

 function getAssistantMessages() {
 return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
 }

 function getLatestAssistantMessage() {
 const nodes = getAssistantMessages();
 return nodes.length ? nodes[nodes.length - 1] : null;
 }

 function extractAssistantText(node) {
 if (!node) return '';
 const content = node.querySelector('[data-message-content]') || node;
 const text = content.innerText || content.textContent || '';
 return normalize(text);
 }

 function getLabel() {
 const parts = location.pathname.split('/').filter(Boolean);
 const tail = parts[parts.length - 1] || '';
 return normalize(tail || document.title || 'chatgpt');
 }

 function sendPayload(payload) {
 GM_xmlhttpRequest({
 method: 'POST',
 url: SERVER_URL,
 headers: {
 'Content-Type': 'application/json',
 'X-Rob-Token': TOKEN
 },
 data: JSON.stringify(payload),
 timeout: 30000,
 onload: (res) => {
 if (res.status < 200 || res.status >= 300) {
 console.error('chatgpt-helper-v2: bad response', res.status, res.responseText);
 }
 },
 ontimeout: () => console.error('chatgpt-helper-v2: request timeout'),
 onerror: (err) => console.error('chatgpt-helper-v2: request failed', err)
 });
 }

 function maybeSendCompletedMessage() {
 const node = getLatestAssistantMessage();
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
 if (prevBusy && !busy) {
 maybeSendCompletedMessage();
 }
 prevBusy = busy;
 }

 setInterval(tick, POLL_MS);
})();
