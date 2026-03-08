// ==UserScript==
// @name         GPT54-Scholar Helper v7
// @namespace    https://github.com/danpuda
// @version      7.5.5
// @description  ChatGPT返答と添付ファイル参照を安定検知し、Canvas/sandboxファイルも自動取得してWSLサーバーへ保存する
// @author       Rob🦞 & Yama🗻
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @connect      chatgpt.com
// @connect      cdn.oaiusercontent.com
// @connect      files.oaiusercontent.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const VERSION = '7.5.5';
    const ROB_SERVER = 'http://127.0.0.1:8854';
    const ROB_TOKEN = 'scholar-v4-rob';

    const CAPTURE_ALL_NEW = true;
    const MAX_EVAL_MESSAGES = 5;
    const MIN_TEXT_LEN = 20;
    const MAX_FILE_BYTES = 25 * 1024 * 1024;

    const MUTATION_DEBOUNCE_MS = 300;
    const POLL_MS = 15000;
    const COMPLETE_IDLE_MS = 5000;
    const SEND_RETRY_COUNT = 3;
    const SEND_RETRY_DELAY_MS = 5000;
    const SEND_COOLDOWN_MS = 30000;
    const MIN_DELTA_CHARS_TO_RESEND = 100;
    const QUERY_CACHE_TTL_MS = 5000;
    const INITIAL_DELAY_MS = 1200;
    const SELF_HEAL_MS = 5000;

    const PANEL_ID = 'scholar-v7-panel';
    const TOAST_ID = 'scholar-toast-v7';
    const PANEL_STORAGE_KEY = 'scholar-v7-panel-pos';
    const PANEL_MAX_LOGS = 200;

    const TEXT_SELECTORS = [
        '[data-message-content]',
        '[data-testid*="conversation-turn-content"]',
        '.markdown',
        '.prose',
        '[class*="markdown"]',
        '[class*="prose"]'
    ];

    const MESSAGE_SELECTORS = [
        '[data-message-author-role="assistant"]',
        '[data-testid*="conversation-turn"][data-message-author-role="assistant"]',
        'article[data-message-author-role="assistant"]',
        '[role="article"][data-message-author-role="assistant"]',
        'article',
        '[role="article"]',
        'main section',
        'main div'
    ];

    const BUSY_SELECTORS = [
        '[aria-busy="true"]',
        '.result-streaming',
        '[data-state="streaming"]',
        '[data-testid*="typing"]',
        '[class*="stream"]'
    ];

    const STOP_BUTTON_RE = /(stop|停止|中止|stop generating|stop streaming)/i;
    // v7.5.3→v7.5.5: ChatGPT 5.4 Thinking — 「思考中」ボタンも生成中として扱う（英語UI+aria-label対応）
    const THINKING_BUTTON_RE = /^(思考中|thinking)$/i;
    // v7.4: ChatGPT 5.4 Thinking UI対応 — 「モデルを切り替える」ボタンも完了判定に使用
    const REGENERATE_BUTTON_RE = /(regenerate|再生成|やり直し|retry|モデルを切り替え|switch model|良い回答|良くない回答|good response|bad response)/i;
    const DOWNLOAD_HINT_RE = /(sandbox:|blob:|\/download\b|\/files\b|attachment|artifact|mnt\/data\/|\.(txt|md|pdf|csv|tsv|json|js|ts|py|ipynb|zip|tar|gz|png|jpg|jpeg|webp|svg|docx|pptx|xlsx))(\?|#|$)/i;

    let observer = null;
    let watchTarget = null;
    let pollTimer = null;
    let selfHealTimer = null;
    let debounceTimer = null;

    let pageReady = false;
    let booting = false;
    let bootShown = false;
    let historyHooked = false;
    let globalHooksBound = false;

    let evaluationRunning = false;
    let pendingEvaluation = false;
    let pendingReason = '';

    let lastMutationAt = 0;
    let lastDetectAt = 0;
    let lastSendAt = 0;
    let sendCount = 0;
    let lastPollGenerating = null;
    let routeEpoch = 0;

    let panelRoot = null;
    let panelBody = null;
    let panelLogs = null;
    let logs = [];
    let statusState = 'idle';
    let renderPanelRAF = null;
    let panelDragListenersInstalled = false;
    let cachedStopButton = false;
    let cachedRegenerateButton = false;

    let latestTextLength = 0;
    let latestFingerprint = '';
    let lastLabelHref = '';
    let lastLabelValue = '';

    let currentRouteKey = '';
    let routeSeeded = false;
    let knownMessages = new Set();
    let inFlightFingerprints = new Set();
    let lastSentByFingerprint = new Map();

    const queryCache = new WeakMap();

    function nowMs() {
        return Date.now();
    }

    function formatTime(ts) {
        if (!ts) return '--:--:--';
        const d = new Date(ts);
        return d.toLocaleTimeString('ja-JP', { hour12: false });
    }

    function shortFingerprint(fp) {
        return fp ? `${fp.slice(0, 12)}...` : '-';
    }

    function sanitizeText(text) {
        return String(text || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]+\n/g, '\n')
            .trim();
    }

    function normalizeLabelPart(value) {
        const s = String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/[\\/:*?"<>|]/g, '_')
            .trim();
        return s.slice(0, 60);
    }

    function getRouteKey() {
        return `${location.origin}${location.pathname}`;
    }

    function updateStatus(next, extras = {}) {
        statusState = next;
        if (typeof extras.textLength === 'number') latestTextLength = extras.textLength;
        if (typeof extras.fingerprint === 'string') latestFingerprint = extras.fingerprint;
        renderPanel();
    }

    function pushLog(level, message, extra) {
        const line = {
            ts: nowMs(),
            level,
            message: String(message || ''),
            extra: extra === undefined ? '' : String(extra)
        };
        logs.push(line);
        if (logs.length > PANEL_MAX_LOGS) logs = logs.slice(-PANEL_MAX_LOGS);

        const prefix = `🦞[v7][${level}]`;
        if (level === 'WARN') {
            console.warn(prefix, line.message, line.extra || '');
        } else if (level === 'ERROR') {
            console.error(prefix, line.message, line.extra || '');
        } else {
            console.log(prefix, line.message, line.extra || '');
        }
        renderPanel();
    }

    function log(message, extra) {
        pushLog('INFO', message, extra);
    }

    function warn(message, extra) {
        pushLog('WARN', message, extra);
    }

    function errorLog(message, extra) {
        pushLog('ERROR', message, extra);
    }

    function showToast(msg, isError = false) {
        const old = document.getElementById(TOAST_ID);
        if (old) old.remove();

        const el = document.createElement('div');
        el.id = TOAST_ID;
        el.textContent = msg;
        el.style.cssText = [
            'position:fixed',
            'bottom:18px',
            'right:18px',
            'z-index:2147483647',
            `background:${isError ? '#4b1113' : '#111827'}`,
            'color:#f3f7f4',
            'padding:10px 14px',
            'border-radius:10px',
            'font-size:13px',
            'font-family:system-ui,sans-serif',
            'box-shadow:0 8px 26px rgba(0,0,0,.35)',
            `border:1px solid ${isError ? '#d24b4b' : '#2a9d6f'}`,
            'pointer-events:none',
            'opacity:.98',
            'transition:opacity .35s ease'
        ].join(';');
        document.body.appendChild(el);
        setTimeout(() => { el.style.opacity = '0'; }, 2200);
        setTimeout(() => el.remove(), 2800);
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function queryAllUnique(root, selectors) {
        const cacheKey = selectors.join('||');
        const now = nowMs();
        const rootCache = queryCache.get(root);
        const cached = rootCache ? rootCache.get(cacheKey) : null;

        if (cached && cached.expiresAt > now) {
            const restored = [];
            const seenCached = new Set();

            for (const ref of cached.refs) {
                const node = (typeof WeakRef !== 'undefined' && ref instanceof WeakRef) ? ref.deref() : ref;
                if (node && node.isConnected && !seenCached.has(node)) {
                    seenCached.add(node);
                    restored.push(node);
                }
            }

            if (restored.length) {
                return restored;
            }
        }

        const seen = new Set();
        const items = [];
        for (const selector of selectors) {
            root.querySelectorAll(selector).forEach((node) => {
                if (!seen.has(node)) {
                    seen.add(node);
                    items.push(node);
                }
            });
        }

        const nextCache = rootCache || new Map();
        nextCache.set(cacheKey, {
            expiresAt: now + QUERY_CACHE_TTL_MS,
            refs: items.map((node) => (typeof WeakRef !== 'undefined' ? new WeakRef(node) : node))
        });
        if (!rootCache) {
            queryCache.set(root, nextCache);
        }

        return items;
    }

    function getMainRoot() {
        return document.querySelector('main,[role="main"]') || document.body;
    }

    function looksLikeAssistantMessage(node) {
        if (!(node instanceof Element)) return false;

        const role = node.getAttribute('data-message-author-role');
        if (role === 'assistant') return true;
        if (role && role !== 'assistant') return false;

        if (node.matches('form, nav, aside, header, footer')) return false;
        if (node.querySelector('textarea, input[type="text"], #prompt-textarea')) return false;

        const text = sanitizeText(node.innerText || node.textContent || '');
        if (text.length < MIN_TEXT_LEN) return false;

        const hasMessageContent = !!node.querySelector(TEXT_SELECTORS.join(','));
        const hasRichContent = !!node.querySelector('pre, code, p, li, table, a[href], blockquote, ol, ul');
        const hasUserMarkers = /^(you|あなた)\b/i.test(text.slice(0, 20));
        if (hasUserMarkers && !hasMessageContent && !hasRichContent) return false;

        return hasMessageContent || hasRichContent;
    }

    function getAssistantCandidates() {
        const root = getMainRoot();
        const primary = queryAllUnique(root, MESSAGE_SELECTORS).filter(looksLikeAssistantMessage);
        if (primary.length) return primary;

        return Array.from(root.querySelectorAll('article, section, div')).filter((el) => {
            if (!(el instanceof Element)) return false;
            if (!looksLikeAssistantMessage(el)) return false;
            return !!el.querySelector('a[href], pre, code, p, li');
        });
    }

    function getLatestAssistantMessage() {
        const items = getAssistantCandidates();
        return items.length ? items[items.length - 1] : null;
    }

    function extractTextFromMessage(messageEl) {
        if (!messageEl) return '';

        for (const selector of TEXT_SELECTORS) {
            const nodes = Array.from(messageEl.querySelectorAll(selector));
            const joined = sanitizeText(
                nodes
                    .map((n) => sanitizeText(n.innerText || n.textContent || ''))
                    .filter(Boolean)
                    .join('\n\n')
            );
            if (joined.length >= MIN_TEXT_LEN) return joined;
        }

        return sanitizeText(messageEl.innerText || messageEl.textContent || '');
    }

    function elementDomPath(el, stopAt) {
        const parts = [];
        let cur = el;
        while (cur && cur !== stopAt && cur instanceof Element) {
            const parent = cur.parentElement;
            if (!parent) break;
            const siblings = Array.from(parent.children).filter((x) => x.tagName === cur.tagName);
            const idx = siblings.indexOf(cur);
            parts.push(`${cur.tagName.toLowerCase()}:${idx}`);
            cur = parent;
        }
        return parts.reverse().join('/');
    }

    function getMessageIdentity(messageEl, index) {
        const attrKeys = ['data-message-id', 'data-testid', 'id', 'data-turn-id'];
        for (const key of attrKeys) {
            const value = messageEl.getAttribute(key);
            if (value) return `${key}:${value}`;
        }
        return `idx:${index}|path:${elementDomPath(messageEl, getMainRoot())}`;
    }

    function buildRouteMessageId(messageEl, index) {
        return `${getRouteKey()}|${getMessageIdentity(messageEl, index)}`;
    }

    function getChatIdLabel() {
        const m = location.pathname.match(/\/c\/([^/?#]+)/);
        if (m && m[1]) return `c-${normalizeLabelPart(m[1].slice(0, 12))}`;
        const bits = location.pathname.split('/').filter(Boolean);
        const tail = bits.length ? normalizeLabelPart(bits[bits.length - 1]) : '';
        return tail ? `u-${tail.slice(0, 20)}` : '';
    }

    function getAssistantLabelSnippet() {
        const latest = getLatestAssistantMessage();
        if (!latest) return '';
        const text = extractTextFromMessage(latest);
        return normalizeLabelPart(text.slice(0, 30));
    }

    function getLabel() {
        const title = normalizeLabelPart((document.title || '').replace(/\s*\|\s*ChatGPT\s*$/i, ''));
        const snippet = getAssistantLabelSnippet();
        const urlLabel = getChatIdLabel();

        let base = title || snippet || urlLabel || 'response';
        if (lastLabelHref && lastLabelHref !== location.href && base === lastLabelValue) {
            base = urlLabel || snippet || title || base;
        }

        const parts = [];
        if (base) parts.push(base);
        if (urlLabel && !parts.some((x) => x.includes(urlLabel))) parts.push(urlLabel);

        const finalLabel = normalizeLabelPart(parts.join('_')) || 'response';
        lastLabelHref = location.href;
        lastLabelValue = finalLabel;
        return finalLabel;
    }

    function guessFileName(anchor, rawHref, resolvedHref) {
        const download = anchor.getAttribute('download');
        if (download) return download;

        const text = sanitizeText(anchor.textContent || '');
        if (text && /\.[a-z0-9]{1,8}$/i.test(text)) return text;

        const fromHref = [resolvedHref, rawHref].find(Boolean) || '';
        try {
            const url = new URL(fromHref, location.href);
            const pathName = decodeURIComponent(url.pathname.split('/').pop() || '');
            if (pathName) return pathName;
        } catch (_) {
            const tail = fromHref.split('/').pop() || '';
            if (tail) return tail;
        }

        return 'attachment.bin';
    }

    function isInterestingLink(anchor, rawHref, resolvedHref) {
        const download = anchor.hasAttribute('download');
        const text = sanitizeText(anchor.textContent || '');
        const merged = `${rawHref || ''} ${resolvedHref || ''} ${text}`;
        return download || DOWNLOAD_HINT_RE.test(merged);
    }

    function collectAttachmentRefs(messageEl) {
        if (!messageEl) return [];

        const refs = [];
        const seen = new Set();

        messageEl.querySelectorAll('a[href]').forEach((anchor) => {
            const rawHref = anchor.getAttribute('href') || '';
            const resolvedHref = anchor.href || rawHref;
            if (!isInterestingLink(anchor, rawHref, resolvedHref)) return;

            const name = guessFileName(anchor, rawHref, resolvedHref);
            const key = `${rawHref}__${resolvedHref}__${name}`;
            if (seen.has(key)) return;
            seen.add(key);

            refs.push({
                name,
                raw_href: rawHref,
                resolved_href: resolvedHref,
                text: sanitizeText(anchor.textContent || ''),
                download_attr: anchor.getAttribute('download') || '',
                kind: rawHref.startsWith('sandbox:') || resolvedHref.startsWith('sandbox:')
                    ? 'sandbox'
                    : resolvedHref.startsWith('blob:')
                        ? 'blob'
                        : 'url'
            });
        });

        // v7.5: Canvas/artifact buttons (behavior-btn) — ファイル名を持つボタンを検出
        const FILE_EXT_RE = /\.(py|js|ts|jsx|tsx|json|md|txt|csv|html|css|sh|yaml|yml|toml|xml|sql|rb|go|rs|java|c|cpp|h|hpp|swift|kt)$/i;
        messageEl.querySelectorAll('button.behavior-btn').forEach((btn) => {
            const text = (btn.textContent || '').trim();
            if (!FILE_EXT_RE.test(text)) return;
            const key = `canvas:${text}`;
            if (seen.has(key)) return;
            seen.add(key);

            refs.push({
                name: text,
                raw_href: '',
                resolved_href: '',
                text: text,
                download_attr: '',
                kind: 'canvas-artifact'
            });
        });

        return refs;
    }

    // ─── v7.5: ChatGPT Internal API — Canvas/sandbox ファイル自動取得 ───

    let cachedAccessToken = null;
    let cachedTokenExpiry = 0;

    function getConversationId() {
        const m = location.pathname.match(/\/c\/([a-f0-9-]+)/);
        return m ? m[1] : null;
    }

    async function getAccessToken() {
        if (cachedAccessToken && nowMs() < cachedTokenExpiry) {
            return cachedAccessToken;
        }
        try {
            const resp = await fetch('/api/auth/session', { credentials: 'include' });
            if (resp.status === 401 || resp.status === 403) {
                // v7.5.1 P1: 認証エラーで即破棄
                cachedAccessToken = null;
                cachedTokenExpiry = 0;
                throw new Error(`session auth failed ${resp.status}`);
            }
            if (!resp.ok) throw new Error(`session ${resp.status}`);
            const data = await resp.json();
            if (!data.accessToken) throw new Error('no accessToken');
            cachedAccessToken = data.accessToken;
            cachedTokenExpiry = nowMs() + 2 * 60 * 1000; // v7.5.1 P2: 4分→2分に短縮
            return cachedAccessToken;
        } catch (err) {
            warn('accessToken取得失敗', String(err.message || err));
            cachedAccessToken = null; // v7.5.1 P1: 失敗時も即破棄
            cachedTokenExpiry = 0;
            return null;
        }
    }

    function invalidateApiCaches() {
        // v7.5.1 P1: route changeやアカウント切替で全キャッシュ破棄
        cachedAccessToken = null;
        cachedTokenExpiry = 0;
        convCache = { convId: null, data: null, expiresAt: 0 };
        convFetchInFlight = null;
    }

    // v7.5.1 P1: conversation APIキャッシュ（会話ID単位 TTL + in-flight共有）
    let convCache = { convId: null, data: null, expiresAt: 0 };
    let convFetchInFlight = null;
    const CONV_CACHE_TTL_MS = 8000; // 8秒TTL

    async function fetchConversationData() {
        const convId = getConversationId();
        if (!convId) return null;

        // キャッシュヒット
        if (convCache.convId === convId && convCache.data && nowMs() < convCache.expiresAt) {
            return convCache.data;
        }

        // in-flight共有（同時実行防止）
        if (convFetchInFlight) return convFetchInFlight;

        convFetchInFlight = (async () => {
            const token = await getAccessToken();
            if (!token) return null;

            try {
                const resp = await fetch(`/backend-api/conversation/${convId}`, {
                    credentials: 'include',
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                if (!resp.ok) {
                    warn('conversation API', `${resp.status}`);
                    // v7.5.1 P1: 401/403でtoken即破棄
                    if (resp.status === 401 || resp.status === 403) {
                        cachedAccessToken = null;
                        cachedTokenExpiry = 0;
                    }
                    return null;
                }
                const data = await resp.json();
                convCache = { convId, data, expiresAt: nowMs() + CONV_CACHE_TTL_MS };
                return data;
            } catch (err) {
                warn('conversation取得失敗', String(err.message || err));
                return null;
            } finally {
                convFetchInFlight = null;
            }
        })();

        return convFetchInFlight;
    }

    async function fetchSandboxFiles() {
        const conv = await fetchConversationData();
        if (!conv) return [];

        try {
            const mapping = conv.mapping || {};
            const sandboxFiles = [];

            // v7.5.1 P0: message_idベースで紐付け（ファイル名だけのマッチング廃止）
            for (const [msgId, msg] of Object.entries(mapping)) {
                const content = msg?.message?.content;
                if (!content) continue;
                const author = msg?.message?.author?.role;
                if (author !== 'assistant') continue;
                const isComplete = msg?.message?.metadata?.is_complete;

                // v7.5.2 P1-1: create_timeを保持（最新ソート用）
                const createTime = msg?.message?.create_time || 0;

                const parts = content.parts || [];
                for (const part of parts) {
                    const text = typeof part === 'string' ? part : (part?.text || '');
                    // v7.5.2 P1-2: sandbox path regex強化 — 末尾の句読点・backtick・括弧を除外
                    const sandboxRe = /sandbox:\/mnt\/data\/([^\s)"`',;}\]]+)/g;
                    let match;
                    while ((match = sandboxRe.exec(text)) !== null) {
                        // v7.5.2 P1-2: 末尾のドット（文末ピリオド等）を除去
                        let rawPath = match[1].replace(/\.+$/, '');
                        // basename化（UIボタンはbasename表示）
                        const fileName = rawPath.split('/').pop();
                        const sandboxPath = `/mnt/data/${rawPath}`;
                        sandboxFiles.push({
                            msgId,          // P0: 構造的IDで紐付け
                            fileName,       // v7.5.2: basename化済み
                            sandboxPath,
                            createTime,     // v7.5.2 P1-1: ソート用
                            isComplete: isComplete !== false
                        });
                    }
                }
            }

            return sandboxFiles;
        } catch (err) {
            warn('sandbox検索失敗', String(err.message || err));
            return [];
        }
    }

    async function downloadSandboxFile(msgId, sandboxPath) {
        const convId = getConversationId();
        if (!convId) return null;

        const token = await getAccessToken();
        if (!token) return null;

        try {
            // Step 1: download URLを取得
            const dlResp = await fetch(
                `/backend-api/conversation/${convId}/interpreter/download?message_id=${encodeURIComponent(msgId)}&sandbox_path=${encodeURIComponent(sandboxPath)}`,
                { credentials: 'include', headers: { 'Authorization': `Bearer ${token}` } }
            );
            if (dlResp.status === 401 || dlResp.status === 403) {
                // v7.5.1 P1: DLでも認証エラーならtoken即破棄
                cachedAccessToken = null;
                cachedTokenExpiry = 0;
                warn('sandbox DL認証失敗', `${dlResp.status} — token破棄`);
                return null;
            }
            if (!dlResp.ok) {
                warn('sandbox DL URL', `${dlResp.status} for ${sandboxPath}`);
                return null;
            }
            const dlData = await dlResp.json();
            if (!dlData.download_url) {
                warn('sandbox DL URL空', sandboxPath);
                return null;
            }

            // Step 2: ファイル内容を取得
            // v7.5.2 P0-1: download_urlが同一オリジンの時だけAuthorizationを付ける
            // cross-originの場合はtokenを送らない（CDN署名URL等への漏洩防止）
            const dlUrl = new URL(dlData.download_url, location.origin);
            const isSameOrigin = dlUrl.origin === location.origin;
            const fileResp = await fetch(dlUrl.toString(), isSameOrigin
                ? { credentials: 'include', headers: { 'Authorization': `Bearer ${token}` } }
                : { credentials: 'omit' }
            );
            if (!fileResp.ok) {
                warn('sandbox DL content', `${fileResp.status}`);
                return null;
            }
            const content = await fileResp.text();
            log('sandbox DL成功', `${sandboxPath} (${content.length}文字)`);
            return content;
        } catch (err) {
            // v7.5.1 P2: DL失敗でもnull返し（呼び元でreference_only扱い）
            warn('sandbox DL失敗', `${sandboxPath}: ${err.message || err}`);
            return null;
        }
    }

    function hasStopButton() {
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
        return buttons.some((btn) => {
            const text = `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`.trim();
            return STOP_BUTTON_RE.test(text) && !btn.disabled;
        });
    }

    function hasRegenerateButton() {
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
        return buttons.some((btn) => {
            const text = `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`.trim();
            return REGENERATE_BUTTON_RE.test(text);
        });
    }

    // v7.5.3: 「思考中」ボタン検知（ChatGPT 5.4 Thinkingで思考フェーズ中に表示される）
    let cachedThinkingButton = false;
    function hasThinkingButton() {
        const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
        return buttons.some((btn) => {
            const text = `${btn.getAttribute('aria-label') || ''} ${btn.textContent || ''}`.trim();
            return THINKING_BUTTON_RE.test(btn.textContent?.trim() || '') ||
                   THINKING_BUTTON_RE.test(btn.getAttribute('aria-label')?.trim() || '');
        });
    }

    function isGeneratingNow() {
        if (cachedStopButton) return true; // v7.2: キャッシュ値を使用（DOM直叩き回避）
        if (cachedThinkingButton) return true; // v7.5.3: 思考中ボタン = まだ生成中

        const latest = getLatestAssistantMessage();
        if (latest && latest.querySelector(BUSY_SELECTORS.join(','))) return true;

        return nowMs() - lastMutationAt < COMPLETE_IDLE_MS;
    }

    async function sha256Hex(text) {
        const buf = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest('SHA-256', buf);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    async function sha256BytesHex(bytes) {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function parseHeaderValue(headers, name) {
        const m = String(headers || '').match(new RegExp(`^${name}:\\s*([^\\r\\n]+)$`, 'im'));
        return m ? m[1].trim() : '';
    }

    function gmRequest(method, path, payload = undefined) {
        return new Promise((resolve, reject) => {
            const headers = {
                'X-Rob-Token': ROB_TOKEN
            };

            const req = {
                method,
                url: `${ROB_SERVER}${path}`,
                headers,
                timeout: 30000,
                onload: (res) => {
                    let body = null;
                    try {
                        body = res.responseText ? JSON.parse(res.responseText) : null;
                    } catch (_) {
                        body = { raw: res.responseText };
                    }
                    if (res.status >= 200 && res.status < 300) {
                        resolve(body || {});
                    } else {
                        reject(new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`));
                    }
                },
                ontimeout: () => reject(new Error('request timeout')),
                onerror: () => reject(new Error('request failed'))
            };

            if (payload !== undefined) {
                headers['Content-Type'] = 'application/json';
                req.data = JSON.stringify(payload);
            }

            GM_xmlhttpRequest(req);
        });
    }

    function gmGetArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                timeout: 30000,
                onload: (res) => {
                    if (res.status >= 200 && res.status < 300) {
                        resolve({
                            bytes: new Uint8Array(res.response || new ArrayBuffer(0)),
                            mimeType: parseHeaderValue(res.responseHeaders, 'content-type') || 'application/octet-stream'
                        });
                    } else {
                        reject(new Error(`GET ${res.status}`));
                    }
                },
                ontimeout: () => reject(new Error('GET timeout')),
                onerror: () => reject(new Error('GET failed'))
            });
        });
    }

    function xhrGetArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'arraybuffer';
            xhr.onload = () => {
                if ((xhr.status >= 200 && xhr.status < 300) || xhr.status === 0) {
                    resolve({
                        bytes: new Uint8Array(xhr.response || new ArrayBuffer(0)),
                        mimeType: xhr.getResponseHeader('content-type') || 'application/octet-stream'
                    });
                } else {
                    reject(new Error(`XHR ${xhr.status}`));
                }
            };
            xhr.onerror = () => reject(new Error('XHR failed'));
            xhr.ontimeout = () => reject(new Error('XHR timeout'));
            xhr.timeout = 30000;
            xhr.send();
        });
    }

    async function resolveAttachmentPayload(ref) {
        const candidateUrls = [ref.resolved_href, ref.raw_href].filter(Boolean);
        let lastError = '';

        for (const url of candidateUrls) {
            try {
                if (/^sandbox:/i.test(url)) {
                    lastError = `unsupported url scheme: ${url}`;
                    continue;
                }

                let payload = null;
                if (/^blob:/i.test(url)) {
                    payload = await xhrGetArrayBuffer(url);
                } else if (/^https?:/i.test(url)) {
                    // v7.5.4 P1: ChatGPT由来URLのみ取得（外部リンクへの無差別GETを防止）
                    try {
                        const parsedUrl = new URL(url);
                        const allowedHosts = ['chatgpt.com', 'chat.openai.com', 'cdn.oaiusercontent.com', 'files.oaiusercontent.com'];
                        if (!allowedHosts.some(h => parsedUrl.hostname === h || parsedUrl.hostname.endsWith('.' + h))) {
                            lastError = `skipped external host: ${parsedUrl.hostname}`;
                            continue;
                        }
                    } catch (_) { /* invalid URL — let it fail naturally */ }
                    payload = await gmGetArrayBuffer(url);
                } else {
                    lastError = `unsupported url scheme: ${url}`;
                    continue;
                }

                const bytes = payload.bytes || new Uint8Array(0);
                if (bytes.byteLength > MAX_FILE_BYTES) {
                    return {
                        ...ref,
                        reference_only: true,
                        note: `file too large: ${bytes.byteLength} bytes`
                    };
                }

                return {
                    ...ref,
                    reference_only: false,
                    mime_type: payload.mimeType || 'application/octet-stream',
                    size: bytes.byteLength,
                    sha256: await sha256BytesHex(bytes),
                    content_base64: bytesToBase64(bytes)
                };
            } catch (err) {
                lastError = String(err && err.message ? err.message : err);
            }
        }

        return {
            ...ref,
            reference_only: true,
            note: lastError || 'browser fetch unavailable'
        };
    }

    function getAssistantRecords() {
        const candidates = getAssistantCandidates();
        return candidates.map((messageEl, index) => ({
            messageEl,
            index,
            routeMessageId: buildRouteMessageId(messageEl, index)
        }));
    }

    function resetRouteState(reason) {
        currentRouteKey = getRouteKey();
        routeSeeded = false;
        knownMessages = new Set();
        inFlightFingerprints = new Set();
        lastSentByFingerprint = new Map();
        latestFingerprint = '';
        latestTextLength = 0;
        lastLabelHref = '';
        lastLabelValue = '';
        invalidateApiCaches(); // v7.5.1 P1: route changeでAPI全キャッシュ破棄
        log('route-reset', `${reason} -> ${currentRouteKey}`);
        renderPanel();
    }

    function ensureRouteState() {
        const nextRouteKey = getRouteKey();
        if (currentRouteKey !== nextRouteKey) {
            routeEpoch += 1;
            resetRouteState('route-key-changed');
        }
    }

    function seedKnownMessages(reason) {
        ensureRouteState();
        if (routeSeeded) return 0;

        const records = getAssistantRecords();
        for (const record of records) {
            knownMessages.add(record.routeMessageId);
        }

        routeSeeded = true;
        log('initial-seed', `${knownMessages.size} known message(s) via ${reason || 'unknown'}`);
        renderPanel();
        return knownMessages.size;
    }

    async function buildSnapshotForRecord(record, total) {
        const text = extractTextFromMessage(record.messageEl);
        const attachmentRefs = collectAttachmentRefs(record.messageEl);
        const textSha = await sha256Hex(text);
        const attachmentSignature = await sha256Hex(
            attachmentRefs.map((x) => `${x.kind}:${x.name}:${x.raw_href}:${x.resolved_href}`).join('\n')
        );
        const clientFingerprint = await sha256Hex(record.routeMessageId);

        // v7.5.4 P0: DOMのdata-message-idを取得（conversation APIのmsgIdと突き合わせ用）
        const domMessageId = record.messageEl.getAttribute('data-message-id') || '';

        return {
            label: getLabel(),
            source_url: location.href,
            message_index: record.index,
            total_assistant_messages: total,
            message_key: getMessageIdentity(record.messageEl, record.index),
            route_message_id: record.routeMessageId,
            dom_message_id: domMessageId, // v7.5.4: conversation API照合用
            text,
            text_sha256: textSha,
            attachmentRefs,
            attachmentSignature,
            client_fingerprint: clientFingerprint
        };
    }

    async function buildSnapshots() {
        const allRecords = getAssistantRecords();
        if (!allRecords.length) return [];

        const total = allRecords.length;
        const targetRecords = CAPTURE_ALL_NEW
            ? allRecords.slice(-MAX_EVAL_MESSAGES)
            : allRecords.slice(-1);

        const snapshots = [];
        for (const record of targetRecords) {
            const snapshot = await buildSnapshotForRecord(record, total);
            if (!snapshot.text || snapshot.text.length < MIN_TEXT_LEN) continue;
            snapshots.push(snapshot);
        }

        return snapshots;
    }

    function shouldSendSnapshot(snapshot) {
        if (!snapshot.text || snapshot.text.length < MIN_TEXT_LEN) {
            return { ok: false, reason: `⏭ SKIP: テキスト短すぎ(${snapshot.text.length}文字)` };
        }

        if (!knownMessages.has(snapshot.route_message_id)) {
            if (inFlightFingerprints.has(snapshot.client_fingerprint)) {
                return { ok: false, reason: '⏭ SKIP: 送信中(in-flight)' };
            }
            return { ok: true, reason: 'new' };
        }

        const fp = snapshot.client_fingerprint;
        if (inFlightFingerprints.has(fp)) {
            return { ok: false, reason: '⏭ SKIP: 送信中(in-flight)' };
        }

        const prev = lastSentByFingerprint.get(fp);
        if (!prev) {
            return { ok: false, reason: '⏭ SKIP: 初回既知メッセージ' };
        }

        const ageMs = nowMs() - (prev.sentAt || 0);
        if (ageMs < SEND_COOLDOWN_MS) {
            return { ok: false, reason: `⏭ SKIP: cooldown ${Math.ceil((SEND_COOLDOWN_MS - ageMs) / 1000)}s` };
        }

        const changed = (
            prev.textSha !== snapshot.text_sha256 ||
            prev.textLength !== snapshot.text.length ||
            prev.attachmentSignature !== snapshot.attachmentSignature
        );

        if (!changed) {
            return { ok: false, reason: '⏭ SKIP: fingerprint重複' };
        }

        const delta = Math.abs((prev.textLength || 0) - snapshot.text.length);
        if (delta < MIN_DELTA_CHARS_TO_RESEND) {
            return { ok: false, reason: `⏭ SKIP: 微小変化(${delta}文字)` };
        }

        return { ok: true, reason: `changed len ${prev.textLength}→${snapshot.text.length}` };
    }

    async function sendSnapshotOnce(snapshot) {
        // v7.5: canvas-artifact があればsandboxファイルを自動取得
        // v7.5.1 P0: 名前だけでなくmsgIdベースで照合、曖昧時は取得中止
        // v7.5.1 P1: canvas refがある時だけAPI呼び出し
        const canvasRefs = snapshot.attachmentRefs.filter((x) => x.kind === 'canvas-artifact');
        let sandboxContents = [];

        if (canvasRefs.length > 0) {
            log('canvas検出', `${canvasRefs.length}個のCanvas artifact`);
            try {
                const sandboxFiles = await fetchSandboxFiles();

                for (const ref of canvasRefs) {
                    const normalizedName = ref.name.toLowerCase().trim();

                    // v7.5.4 P0: まずDOM message_idで絞る（同名別メッセージの誤取得を防ぐ）
                    let candidates;
                    if (snapshot.dom_message_id) {
                        const sameMessage = sandboxFiles.filter(
                            (sf) => sf.msgId === snapshot.dom_message_id
                        );
                        candidates = sameMessage.filter(
                            (sf) => sf.fileName.toLowerCase().trim() === normalizedName
                        );
                        // v7.5.5 P1: dom_message_idがあるのにmsgIdマッチなし→全体検索せずスキップ（誤取得防止）
                        if (candidates.length === 0) {
                            warn('sandbox msgId不一致→スキップ', `${ref.name} msgId=${snapshot.dom_message_id} — 全体検索しない（安全側）`);
                            continue;
                        }
                    } else {
                        // dom_message_idがない場合はファイル名のみ（フォールバック）
                        candidates = sandboxFiles.filter(
                            (sf) => sf.fileName.toLowerCase().trim() === normalizedName
                        );
                    }

                    if (candidates.length === 0) {
                        warn('sandbox未発見', `${ref.name} — API応答に該当ファイルなし`);
                        continue;
                    }

                    // v7.5.4 P2: isComplete=trueを優先（未完了メッセージのartifactを避ける）
                    const completeCandidates = candidates.filter((sf) => sf.isComplete);
                    const pool = completeCandidates.length > 0 ? completeCandidates : candidates;

                    // v7.5.2 P1-1: create_timeで明示的にソートして最新を選ぶ
                    pool.sort((a, b) => (a.createTime || 0) - (b.createTime || 0));
                    if (pool.length > 1) {
                        log('sandbox同名複数', `${ref.name} x${pool.length} — create_time最新を採用`);
                    }

                    // 最新のcreate_timeを持つ候補を使用
                    const best = pool[pool.length - 1];
                    const content = await downloadSandboxFile(best.msgId, best.sandboxPath);
                    if (content !== null) {
                        sandboxContents.push({
                            name: best.fileName,
                            sandbox_path: best.sandboxPath,
                            message_id: best.msgId,  // P0: 構造的IDを記録
                            content: content,
                            size: content.length,
                            kind: 'canvas-artifact'
                        });
                    }
                }
                log('sandbox取得完了', `${sandboxContents.length}/${canvasRefs.length}ファイル`);
            } catch (err) {
                // v7.5.1 P2: sandbox取得失敗でも本文送信は止めない
                warn('sandbox取得エラー（本文送信は継続）', String(err.message || err));
            }
        }

        const responsePayload = {
            label: snapshot.label,
            text: snapshot.text,
            text_sha256: snapshot.text_sha256,
            client_fingerprint: snapshot.client_fingerprint,
            source_url: snapshot.source_url,
            attachments_discovered: snapshot.attachmentRefs.map((x) => ({
                name: x.name,
                kind: x.kind,
                raw_href: x.raw_href,
                resolved_href: x.resolved_href,
                text: x.text,
                download_attr: x.download_attr
            })),
            // v7.5: sandboxファイル内容を直接ペイロードに含める
            sandbox_files: sandboxContents
        };

        const response = await gmRequest('POST', '/response', responsePayload);
        const bundleId = response.bundle_id;
        if (!bundleId) throw new Error('bundle_id missing');

        for (const ref of snapshot.attachmentRefs) {
            if (ref.kind === 'canvas-artifact') {
                // canvas-artifactはsandbox_filesとして送信済み — 個別/file送信はスキップ
                continue;
            }
            const payload = await resolveAttachmentPayload(ref);
            await gmRequest('POST', '/file', {
                bundle_id: bundleId,
                name: payload.name,
                kind: payload.kind,
                raw_href: payload.raw_href,
                resolved_href: payload.resolved_href,
                text: payload.text || '',
                download_attr: payload.download_attr || '',
                reference_only: !!payload.reference_only,
                note: payload.note || '',
                mime_type: payload.mime_type || '',
                size: payload.size || 0,
                sha256: payload.sha256 || '',
                content_base64: payload.content_base64 || ''
            });
        }

        return bundleId;
    }

    async function sendSnapshotWithRetry(snapshot) {
        const fp = snapshot.client_fingerprint;
        inFlightFingerprints.add(fp);
        updateStatus('sending', { textLength: snapshot.text.length, fingerprint: fp });

        for (let attempt = 1; attempt <= SEND_RETRY_COUNT; attempt += 1) {
            try {
                log(`送信開始 #${attempt}/${SEND_RETRY_COUNT}`, `${snapshot.message_key} len=${snapshot.text.length}`);
                const bundleId = await sendSnapshotOnce(snapshot);

                knownMessages.add(snapshot.route_message_id);
                lastSentByFingerprint.set(fp, {
                    textSha: snapshot.text_sha256,
                    textLength: snapshot.text.length,
                    attachmentSignature: snapshot.attachmentSignature,
                    sentAt: nowMs(),
                    messageKey: snapshot.message_key
                });

                latestTextLength = snapshot.text.length;
                latestFingerprint = fp;
                lastSendAt = nowMs();
                sendCount += 1;

                updateStatus('done', { textLength: snapshot.text.length, fingerprint: fp });
                const canvasCount = snapshot.attachmentRefs.filter((x) => x.kind === 'canvas-artifact').length;
                const otherCount = snapshot.attachmentRefs.length - canvasCount;
                const parts = [];
                if (otherCount > 0) parts.push(`添付${otherCount}`);
                if (canvasCount > 0) parts.push(`📄Canvas${canvasCount}`);
                showToast(`✅ 自動保存完了${parts.length ? ` +${parts.join('+')}` : ''}`);
                log('送信成功', `bundle=${bundleId} attachments=${snapshot.attachmentRefs.length} canvas=${canvasCount}`);
                inFlightFingerprints.delete(fp);
                return true;
            } catch (err) {
                const detail = String(err && err.message ? err.message : err);
                warn(`送信失敗 #${attempt}/${SEND_RETRY_COUNT}`, detail);
                if (attempt >= SEND_RETRY_COUNT) {
                    updateStatus('error', { textLength: snapshot.text.length, fingerprint: fp });
                    showToast('❌ 自動保存失敗', true);
                    inFlightFingerprints.delete(fp);
                    return false;
                }
                await sleep(SEND_RETRY_DELAY_MS);
            }
        }

        inFlightFingerprints.delete(fp);
        return false;
    }

    async function evaluateAndSend(reason) {
        ensureRouteState();
        if (!pageReady) return;

        if (evaluationRunning) {
            pendingEvaluation = true;
            pendingReason = reason || pendingReason || 'queued';
            return;
        }

        evaluationRunning = true;
        updateStatus('detecting');
        lastDetectAt = nowMs();

        try {
            if (!routeSeeded) {
                seedKnownMessages(reason || 'initial');
                updateStatus('idle');
                return;
            }

            const generating = isGeneratingNow();
            const latest = getLatestAssistantMessage();
            const regenerate = cachedRegenerateButton; // v7.2: キャッシュ値を使用（DOM直叩き回避）

            if (generating) {
                const age = nowMs() - lastMutationAt;
                log('⏭ SKIP: 生成中', `reason=${reason || '-'} idle=${age}ms regenerate=${regenerate}`);
                return;
            }

            if (!latest) {
                log('⏭ SKIP: assistantメッセージなし', reason || '-');
                return;
            }

            const snapshots = await buildSnapshots();
            if (!snapshots.length) {
                log('⏭ SKIP: 送信対象なし', reason || '-');
                return;
            }

            let sentAny = false;
            for (const snapshot of snapshots) {
                latestTextLength = snapshot.text.length;
                latestFingerprint = snapshot.client_fingerprint;
                renderPanel();

                const decision = shouldSendSnapshot(snapshot);
                if (!decision.ok) {
                    log(decision.reason, `${snapshot.message_key} len=${snapshot.text.length}`);
                    continue;
                }

                if (decision.reason !== 'new') {
                    log('再送対象', `${snapshot.message_key} ${decision.reason}`);
                }

                const ok = await sendSnapshotWithRetry(snapshot);
                sentAny = sentAny || ok;
            }

            if (!sentAny) {
                updateStatus('idle');
            }
        } catch (err) {
            const detail = String(err && err.message ? err.message : err);
            errorLog('評価中エラー', detail);
            updateStatus('error');
        } finally {
            evaluationRunning = false;
            if (pendingEvaluation) {
                const nextReason = pendingReason || 'queued';
                pendingEvaluation = false;
                pendingReason = '';
                setTimeout(() => {
                    void evaluateAndSend(nextReason);
                }, 10);
            }
        }
    }

    function scheduleEvaluation(reason) {
        ensureRouteState();
        if (!pageReady) return;

        lastDetectAt = nowMs();
        pendingReason = reason || 'unknown';
        updateStatus('detecting');

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void evaluateAndSend(pendingReason || reason || 'debounced');
        }, MUTATION_DEBOUNCE_MS);
    }

    function createPanel() {
        if (panelRoot && panelRoot.isConnected) return;

        panelRoot = document.createElement('div');
        panelRoot.id = PANEL_ID;
        panelRoot.style.cssText = [
            'position:fixed',
            'right:18px',
            'bottom:72px',
            'width:280px',
            'min-height:220px',
            'z-index:2147483646',
            'background:rgba(17,24,39,.88)',
            'color:#e5f7ef',
            'border:1px solid rgba(42,157,111,.75)',
            'border-radius:12px',
            'box-shadow:0 12px 32px rgba(0,0,0,.35)',
            'backdrop-filter:blur(8px)',
            'font:12px/1.45 system-ui,sans-serif',
            'user-select:none',
            'overflow:hidden'
        ].join(';');

        const header = document.createElement('div');
        header.textContent = '🦞 v7.5.5 Status';
        header.style.cssText = [
            'padding:10px 12px',
            'cursor:move',
            'font-weight:700',
            'border-bottom:1px solid rgba(255,255,255,.08)',
            'background:rgba(255,255,255,.03)'
        ].join(';');

        panelBody = document.createElement('pre');
        panelBody.style.cssText = [
            'margin:0',
            'padding:10px 12px 6px',
            'white-space:pre-wrap',
            'word-break:break-word',
            'font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace',
            'max-height:130px',
            'overflow:hidden'
        ].join(';');

        panelLogs = document.createElement('div');
        panelLogs.style.cssText = [
            'padding:6px 12px 12px',
            'border-top:1px solid rgba(255,255,255,.08)',
            'font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace',
            'white-space:pre-wrap',
            'word-break:break-word',
            'max-height:120px',
            'overflow:auto',
            'color:#c9f5de'
        ].join(';');

        panelRoot.appendChild(header);
        panelRoot.appendChild(panelBody);
        panelRoot.appendChild(panelLogs);
        document.body.appendChild(panelRoot);

        const saved = localStorage.getItem(PANEL_STORAGE_KEY);
        if (saved) {
            try {
                const pos = JSON.parse(saved);
                if (typeof pos.left === 'number') {
                    panelRoot.style.left = `${pos.left}px`;
                    panelRoot.style.top = `${pos.top}px`;
                    panelRoot.style.right = 'auto';
                    panelRoot.style.bottom = 'auto';
                }
            } catch (_) {
            }
        }

        let drag = null;
        header.addEventListener('mousedown', (ev) => {
            drag = {
                dx: ev.clientX - panelRoot.offsetLeft,
                dy: ev.clientY - panelRoot.offsetTop
            };
            panelRoot.style.right = 'auto';
            panelRoot.style.bottom = 'auto';
            if (!panelRoot.style.left || !panelRoot.style.top) {
                const rect = panelRoot.getBoundingClientRect();
                panelRoot.style.left = `${rect.left}px`;
                panelRoot.style.top = `${rect.top}px`;
            }
            ev.preventDefault();
        });

        if (!panelDragListenersInstalled) {
            panelDragListenersInstalled = true;
            window.addEventListener('mousemove', (ev) => {
                if (!drag) return;
                const left = Math.max(0, Math.min(window.innerWidth - panelRoot.offsetWidth, ev.clientX - drag.dx));
                const top = Math.max(0, Math.min(window.innerHeight - panelRoot.offsetHeight, ev.clientY - drag.dy));
                panelRoot.style.left = `${left}px`;
                panelRoot.style.top = `${top}px`;
            }, true);

            window.addEventListener('mouseup', () => {
                if (!drag) return;
                drag = null;
                localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
                    left: panelRoot.offsetLeft,
                    top: panelRoot.offsetTop
                }));
            }, true);
        }

        renderPanel();
    }

    function renderPanel() {
        if (renderPanelRAF) return;
        renderPanelRAF = requestAnimationFrame(() => {
            renderPanelRAF = null;
            _doRenderPanel();
        });
    }

    function _doRenderPanel() {
        if (!panelRoot || !panelBody || !panelLogs) return;

        panelBody.textContent = [
            '────────────',
            `状態: ${statusState}`,
            `最終検知: ${formatTime(lastDetectAt)}`,
            `最終送信: ${formatTime(lastSendAt)}${lastSendAt ? ' ✅' : ''}`,
            `送信回数: ${sendCount}`,
            `既知数: ${knownMessages.size}`,
            `seeded: ${routeSeeded ? 'yes' : 'no'}`,
            `テキスト長: ${latestTextLength.toLocaleString('ja-JP')}`,
            `fingerprint: ${shortFingerprint(latestFingerprint)}`,
            `route epoch: ${routeEpoch}`,
            `stop: ${cachedStopButton ? 'yes' : 'no'} / regen: ${cachedRegenerateButton ? 'yes' : 'no'}`
        ].join('\n');

        const renderedLogs = logs
            .map((x) => `${formatTime(x.ts)} [${x.level}] ${x.message}${x.extra ? ` — ${x.extra}` : ''}`)
            .join('\n');
        panelLogs.textContent = renderedLogs || '(log empty)';
        panelLogs.scrollTop = panelLogs.scrollHeight;
    }

    function installHistoryHook() {
        if (historyHooked) return;
        historyHooked = true;

        const fire = () => {
            routeEpoch += 1;
            resetRouteState('route-change');
            lastMutationAt = nowMs();
            log('route-change', location.href);
            scheduleEvaluation('route-change');
        };

        const wrap = (methodName) => {
            const original = history[methodName];
            history[methodName] = function (...args) {
                const ret = original.apply(this, args);
                queueMicrotask(fire);
                return ret;
            };
        };

        wrap('pushState');
        wrap('replaceState');
        window.addEventListener('popstate', fire, true);
    }

    function bindGlobalHooks() {
        if (globalHooksBound) return;
        globalHooksBound = true;

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                log('visibility', 'visible');
                scheduleEvaluation('visibility-visible');
            }
        }, true);

        window.addEventListener('focus', () => {
            log('focus', 'window focused');
            scheduleEvaluation('focus');
        }, true);

        window.addEventListener('pageshow', () => {
            ensurePanelExists();
            ensureRouteState();
            scheduleEvaluation('pageshow');
        }, true);
    }

    function stopWatching() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        watchTarget = null;
        cachedStopButton = false;
        cachedRegenerateButton = false;
        cachedThinkingButton = false; // v7.5.3
        lastPollGenerating = null;
    }

    function startWatching(reason) {
        stopWatching();

        const target = getMainRoot();
        watchTarget = target;

        observer = new MutationObserver((mutations) => {
            lastMutationAt = nowMs();

            const touchedAssistant = mutations.some((m) => {
                const nodes = [m.target, ...Array.from(m.addedNodes || [])];
                return nodes.some((node) => {
                    if (!(node instanceof Element)) return false;

                    const assistantContainer = node.matches('[data-message-author-role="assistant"], article, [role="article"]')
                        ? node
                        : node.closest('[data-message-author-role="assistant"], article, [role="article"]');

                    if (!assistantContainer) return false;
                    if (assistantContainer.getAttribute('data-message-author-role') === 'assistant') return true;

                    return looksLikeAssistantMessage(assistantContainer);
                });
            });

            if (touchedAssistant) {
                log('mutation', 'assistant changed');
                scheduleEvaluation('assistant-mutation');
            }
        });

        observer.observe(target, {
            childList: true,
            subtree: true,
            characterData: false, // v7.2: CPU負荷軽減（childListだけで新メッセージ検出は十分）
            attributes: false,   // v7.2: CPU負荷軽減（attributeFilter不要に）
        });

        // v7.3: キャッシュを先に初期化（isGeneratingNow()がキャッシュ参照するため）
        cachedStopButton = hasStopButton();
        cachedRegenerateButton = hasRegenerateButton();
        cachedThinkingButton = hasThinkingButton(); // v7.5.3
        lastPollGenerating = isGeneratingNow();
        pollTimer = setInterval(() => {
            cachedStopButton = hasStopButton();
            cachedRegenerateButton = hasRegenerateButton();
            cachedThinkingButton = hasThinkingButton(); // v7.5.3
            const generatingNow = isGeneratingNow();

            if (generatingNow !== lastPollGenerating) {
                log('poll-state', `generating ${lastPollGenerating} -> ${generatingNow}`);
            }

            if (lastPollGenerating === true && generatingNow === false) {
                lastDetectAt = nowMs();
                log('poll-complete', `idle=${nowMs() - lastMutationAt}ms evaluate`);
                scheduleEvaluation('poll-generation-complete');
            }

            // v7.4: 短い回答の取りこぼし防止 — 生成完了後にtrue→false遷移を
            // 見逃した場合でも、idle時間経過でevaluateをトリガー
            if (!generatingNow && (nowMs() - lastMutationAt) > COMPLETE_IDLE_MS && (nowMs() - lastMutationAt) < POLL_MS * 2) {
                log('poll-idle-catch', `idle=${nowMs() - lastMutationAt}ms — missed transition, evaluate`);
                scheduleEvaluation('poll-idle-catch');
            }

            lastPollGenerating = generatingNow;
            renderPanel();
        }, POLL_MS);

        pageReady = true;
        lastMutationAt = nowMs();

        if (!bootShown) {
            bootShown = true;
            showToast('🦞 v7 自動監視ON');
        }

        log('watching started', `${reason || 'boot'} -> ${location.href}`);
        scheduleEvaluation(reason || 'initial');
    }

    function ensurePanelExists() {
        if (!document.body) return;
        if (!panelRoot || !panelRoot.isConnected || !document.getElementById(PANEL_ID)) {
            panelRoot = null;
            panelBody = null;
            panelLogs = null;
            createPanel();
        }
    }

    function installSelfHeal() {
        if (selfHealTimer) return;

        selfHealTimer = setInterval(() => {
            try {
                if (!document.body) return;

                ensurePanelExists();
                ensureRouteState();

                const target = getMainRoot();
                const watcherBroken = !observer || !watchTarget || !watchTarget.isConnected || watchTarget !== target || !pollTimer;

                if (!pageReady || watcherBroken) {
                    log('self-heal', watcherBroken ? 'watcher restart' : 'page not ready');
                    startWatching('self-heal');
                } else {
                    renderPanel();
                }
            } catch (err) {
                errorLog('self-heal error', String(err && err.message ? err.message : err));
            }
        }, SELF_HEAL_MS);
    }

    function boot(reason) {
        if (booting) return;
        if (!document.body) return;

        booting = true;
        try {
            ensurePanelExists();
            installHistoryHook();
            bindGlobalHooks();
            installSelfHeal();

            if (!currentRouteKey) {
                currentRouteKey = getRouteKey();
                resetRouteState('boot');
            } else {
                ensureRouteState();
            }

            startWatching(reason || 'boot');
        } finally {
            booting = false;
        }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(() => boot('readyState'), 0);
    } else {
        document.addEventListener('DOMContentLoaded', () => boot('domcontentloaded'), { once: true });
        window.addEventListener('load', () => boot('load'), { once: true });
    }

    setTimeout(() => boot('initial-delay'), INITIAL_DELAY_MS);
})();
